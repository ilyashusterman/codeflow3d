/**
 * Flat mode: one file, full screen, live.
 *
 * Double-clicking a screen in the scene opens it here. This is where reading
 * and editing actually happen — the in-scene screens are a map of what is
 * changing, this is the surface you work on. Escape or ✕ returns to 3D.
 *
 * "Live" is the point: while this is open the file is re-read whenever the
 * watcher reports it changed, so an edit made by an agent, another editor, or
 * a git checkout appears here as it happens. If you have unsaved work the
 * incoming version is never dropped on top of it — you are told, and you
 * choose.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CodeLine, SceneGraph, TokenClass } from "@shared/protocol";
import { highlight } from "@shared/highlight";
import { METRICS } from "../lib/editorTheme";
import { apiUrl } from "../net/api";
import { useStore } from "../state/store";

function tokenClass(c: TokenClass) {
  return "tk-" + c;
}

/** Bytes, in the unit a person would have said. */
function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

interface Loaded {
  source: string;
  language: string;
  /** Not text. Bytes, so the empty state can say how big it is. */
  binary?: number;
}

/** Line roles for the whole file, from the graph rather than from the window. */
function useLineRoles(scene: SceneGraph | null, file: string) {
  return useMemo(() => {
    const roles = new Map<number, CodeLine["flow"]>();
    const owner = new Map<number, string>();
    if (!scene) return { roles, owner };

    const onFlow = new Set<string>();
    for (const line of scene.streamlines) for (const id of line.nodeIds) onFlow.add(id);

    for (const node of scene.nodes) {
      if (node.file !== file) continue;
      const flowing = onFlow.has(node.id);
      for (let n = node.startLine; n <= node.endLine; n++) {
        owner.set(n, node.id);
        if (flowing && !roles.get(n)) roles.set(n, "body");
      }
      if (flowing) roles.set(node.startLine, "def");
    }
    for (const edge of scene.edges) {
      const from = scene.nodes.find((n) => n.id === edge.from);
      if (from?.file === file && onFlow.has(edge.from) && onFlow.has(edge.to)) {
        roles.set(edge.line, "call");
      }
    }
    return { roles, owner };
  }, [scene, file]);
}

export function FlatView() {
  const file = useStore((s) => s.focused);
  const setFocused = useStore((s) => s.setFocused);
  const scene = useStore((s) => s.scene);
  const events = useStore((s) => s.events);

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [incoming, setIncoming] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const focusRef = useRef<HTMLDivElement>(null);

  const editing = draft !== null;
  const dirty = editing && draft !== loaded?.source;
  const text = draft ?? loaded?.source ?? "";
  const panel = scene?.panels.find((p) => p.file === file);
  const { roles } = useLineRoles(scene, file ?? "");

  const load = useCallback(
    async (path: string): Promise<Loaded | null> => {
      try {
        const res = await fetch(apiUrl(`/api/source?file=${encodeURIComponent(path)}`));
        const body = await res.json();
        if (body.error) {
          setError(body.error);
          return null;
        }
        setError(null);
        if (body.binary) return { source: "", language: "binary", binary: body.bytes ?? 0 };
        return { source: body.source ?? "", language: body.language ?? "typescript" };
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      }
    },
    [],
  );

  // Initial load.
  useEffect(() => {
    if (!file) return;
    let alive = true;
    setLoaded(null);
    setDraft(null);
    setIncoming(null);
    void load(file).then((next) => alive && next && setLoaded(next));
    return () => {
      alive = false;
    };
  }, [file, load]);

  // Live: whenever the watcher reports this file changed, pull the new text.
  const lastEventAt = useMemo(
    () => events.find((e) => e.path === file)?.at ?? 0,
    [events, file],
  );
  useEffect(() => {
    if (!file || !lastEventAt || !loaded) return;
    let alive = true;
    void load(file).then((next) => {
      if (!alive || !next || next.source === loaded.source) return;
      if (dirty) setIncoming(next.source);
      else {
        setLoaded(next);
        if (editing) setDraft(next.source);
      }
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastEventAt]);

  const close = useCallback(() => setFocused(null), [setFocused]);

  const save = useCallback(async () => {
    if (!file || draft === null || saving) return;
    setSaving(true);
    try {
      const res = await fetch(apiUrl("/api/write"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file, content: draft }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      setLoaded({ source: draft, language: loaded?.language ?? "typescript" });
      setIncoming(null);
      setSavedAt(Date.now());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [file, draft, saving, loaded]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      } else if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save, close]);

  const lines = useMemo(() => {
    if (!loaded || loaded.binary !== undefined) return [];
    const count = text.split("\n").length;
    return highlight(text, loaded.language, 1, Math.min(count, 8000));
  }, [text, loaded]);

  const changed = useMemo(() => {
    const set = new Set<number>();
    if (!panel) return set;
    for (const line of panel.lines) if (line.change === "add") set.add(line.n);
    return set;
  }, [panel]);

  // Open where the screen was looking. An editor opening a file at the top
  // when you asked for line 300 is the one thing that makes a jump from the
  // scene feel like a different application.
  useEffect(() => {
    if (!loaded || editing) return;
    const at = focusRef.current;
    if (at) at.scrollIntoView({ block: "center" });
  }, [loaded, editing, file]);

  const syncScroll = () => {
    const from = areaRef.current;
    if (!from) return;
    if (mirrorRef.current) {
      mirrorRef.current.scrollTop = from.scrollTop;
      mirrorRef.current.scrollLeft = from.scrollLeft;
    }
    if (gutterRef.current) gutterRef.current.scrollTop = from.scrollTop;
  };

  if (!file) return null;

  return (
    <div className="flat">
      <header>
        <span className="flat-file" title={file}>
          {file.includes("/") && <span className="flat-dir">{file.slice(0, file.lastIndexOf("/") + 1)}</span>}
          <span className="flat-name">{file.slice(file.lastIndexOf("/") + 1)}</span>
        </span>
        {panel && (panel.added > 0 || panel.removed > 0) && (
          <span className="scr-delta">
            <b>+{panel.added}</b>
            <em>-{panel.removed}</em>
          </span>
        )}
        <span className="flat-meta">
          {loaded?.binary !== undefined
            ? `${size(loaded.binary)} · binary`
            : `${lines.length} lines${loaded ? ` · ${loaded.language}` : ""}`}
          {savedAt && !dirty ? " · saved" : ""}
        </span>
        <span className="flat-actions">
          {editing ? (
            <>
              <button className={dirty ? "hot" : ""} onClick={() => void save()} disabled={!dirty || saving}>
                {saving ? "saving…" : "save ⌘S"}
              </button>
              <button onClick={() => setDraft(null)}>stop editing</button>
            </>
          ) : (
            <button
              onClick={() => setDraft(loaded?.source ?? "")}
              disabled={!loaded || loaded.binary !== undefined}
              title={loaded?.binary !== undefined ? "not a text file" : "edit this file"}
            >
              edit
            </button>
          )}
          <button className="flat-close" onClick={close} title="back to 3D (esc)">
            ✕
          </button>
        </span>
      </header>

      {error && <div className="flat-error">{error}</div>}

      {incoming !== null && (
        <div className="flat-conflict">
          This file changed on disk while you were editing.
          <button
            onClick={() => {
              setLoaded({ source: incoming, language: loaded?.language ?? "typescript" });
              setDraft(incoming);
              setIncoming(null);
            }}
          >
            load their version
          </button>
          <button onClick={() => setIncoming(null)}>keep mine</button>
        </div>
      )}

      <div className="flat-body">
        {!loaded && !error && <div className="flat-loading">reading {file}…</div>}
        {loaded?.binary !== undefined && (
          <div className="flat-binary">
            <b>{file.slice(file.lastIndexOf("/") + 1)}</b>
            <span>
              {size(loaded.binary)} of binary data. There is nothing to read as code
              here — the trace still watches this file and reports every write to it.
            </span>
          </div>
        )}
        {loaded && loaded.binary === undefined && !editing && (
          <div className="flat-read">
            {lines.map((line) => {
              const flow = roles.get(line.n);
              // View mode has no caret, but the line the screen was following
              // is still the line an editor would have parked the cursor on.
              const focus = !editing && line.n === panel?.focusLine;
              return (
                <div
                  key={line.n}
                  ref={focus ? focusRef : undefined}
                  className={`scr-line${changed.has(line.n) ? " ch-add" : ""}${
                    flow ? ` fl-${flow}` : ""
                  }${focus ? " is-focus" : ""}`}
                >
                  <span className="scr-gutter">{line.n}</span>
                  <span className="scr-flow" />
                  <code>
                    {line.spans.map((s, i) => (
                      <span key={i} className={tokenClass(s.c)}>
                        {s.t}
                      </span>
                    ))}
                    {line.spans.length === 0 ? " " : null}
                  </code>
                </div>
              );
            })}
          </div>
        )}
        {loaded && loaded.binary === undefined && editing && (
          <div className="flat-edit">
            <div className="flat-gutter" ref={gutterRef}>
              {lines.map((line) => (
                <div key={line.n}>{line.n}</div>
              ))}
            </div>
            <div className="flat-editwrap">
              <pre className="scr-mirror" ref={mirrorRef} aria-hidden>
                {lines.map((line) => (
                  <div className="scr-mline" key={line.n}>
                    {line.spans.map((s, i) => (
                      <span key={i} className={tokenClass(s.c)}>
                        {s.t}
                      </span>
                    ))}
                    {line.spans.length === 0 ? " " : null}
                  </div>
                ))}
              </pre>
              <textarea
                ref={areaRef}
                className="scr-area"
                value={draft ?? ""}
                spellCheck={false}
                wrap="off"
                autoFocus
                onChange={(e) => setDraft(e.target.value)}
                onScroll={syncScroll}
                onKeyDown={(e) => {
                  // Deliberately not stopping propagation: the camera already
                  // ignores keys while an input has focus, and swallowing them
                  // here is what used to make Escape not work while typing.
                  if (e.key === "Escape") {
                    e.preventDefault();
                    close();
                    return;
                  }
                  if (e.key === "Tab") {
                    e.preventDefault();
                    const el = e.currentTarget;
                    const { selectionStart: a, selectionEnd: b } = el;
                    const next = (draft ?? "").slice(0, a) + "  " + (draft ?? "").slice(b);
                    setDraft(next);
                    requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2));
                  }
                }}
              />
            </div>
          </div>
        )}
      </div>

      <footer>
        <span>
          <b>esc</b> back to 3D
          {loaded?.binary === undefined && (
            <>
              {" · "}
              <b>⌘S</b> save · flow rails show what the traced call graph runs through
            </>
          )}
        </span>
        <span className="flat-status">
          {dirty && <b className="scr-dirty">unsaved changes</b>}
          {panel ? `Ln ${panel.focusLine}` : ""}
          {`  Spaces: ${METRICS.tabSize}  ${loaded?.language ?? ""}`}
        </span>
      </footer>
    </div>
  );
}
