/**
 * Folder picker.
 *
 * A filesystem chooser squeezed into a 230px sidebar is not a chooser, so this
 * is a real dialog: breadcrumbs, a typable path, keyboard navigation, recents,
 * and per-row hints (repo marker, source-file count) so you can tell which
 * directory is the one you meant before you open it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { apiUrl } from "../net/api";

interface DirInfo {
  name: string;
  path: string;
  sourceFiles: number;
  subdirs: number;
  marker: string | null;
  readable: boolean;
}

interface Listing {
  path: string;
  parent: string | null;
  home: string;
  self: DirInfo;
  dirs: DirInfo[];
}

const RECENTS_KEY = "codeflow3d.recentPaths";

function loadRecents(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x) => typeof x === "string").slice(0, 8) : [];
  } catch {
    return [];
  }
}

export function rememberPath(path: string) {
  const next = [path, ...loadRecents().filter((p) => p !== path)].slice(0, 8);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* private mode */
  }
}

export function FolderPicker({
  initialPath,
  onPick,
  onClose,
}: {
  initialPath: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [draft, setDraft] = useState(initialPath);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [filter, setFilter] = useState("");
  const recents = useMemo(loadRecents, []);
  const listRef = useRef<HTMLDivElement>(null);

  const open = useCallback(
    async (path: string) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(apiUrl(`/api/browse?path=${encodeURIComponent(path)}&hidden=${hidden ? 1 : 0}`));
        const body = await res.json();
        if (body.error) {
          setError(body.error);
        } else {
          setListing(body as Listing);
          setDraft((body as Listing).path);
          setCursor(0);
          setFilter("");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [hidden],
  );

  useEffect(() => {
    void open(initialPath);
    // Re-listing on `hidden` is intentional; initialPath is the entry point only.
  }, [hidden]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => {
    if (!listing) return [];
    const needle = filter.trim().toLowerCase();
    return needle ? listing.dirs.filter((d) => d.name.toLowerCase().includes(needle)) : listing.dirs;
  }, [listing, filter]);

  // Keyboard: arrows move, Enter descends, Cmd/Ctrl+Enter watches, Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return onClose();
      if (!listing) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCursor((c) => Math.min(rows.length - 1, c + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((c) => Math.max(0, c - 1));
      } else if (e.key === "Backspace" && listing.parent && filter === "") {
        e.preventDefault();
        void open(listing.parent);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (e.metaKey || e.ctrlKey) return pick(rows[cursor]?.path ?? listing.path);
        const target = rows[cursor];
        if (target?.readable) void open(target.path);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [listing, rows, cursor, filter, onClose, open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  function pick(path: string) {
    rememberPath(path);
    onPick(path);
  }

  const crumbs = useMemo(() => {
    if (!listing) return [];
    const parts = listing.path.split("/").filter(Boolean);
    return parts.map((name, i) => ({ name, path: "/" + parts.slice(0, i + 1).join("/") }));
  }, [listing]);

  /*
   * Rendered into the body rather than in place.
   *
   * The picker is opened from the repo drawer, and the drawer is a clipped,
   * transformed box 430px tall — which made it the containing block for
   * anything inside it, fixed or not, and cut the dialog's footer (the button
   * that actually starts the watch) off below the window. A modal belongs at
   * the top of the tree.
   */
  return createPortal(
    <div className="picker-backdrop" onMouseDown={onClose}>
      <div className="picker" onMouseDown={(e) => e.stopPropagation()}>
        <header>
          <span>choose a repository to watch</span>
          <button onClick={onClose} title="close">
            ×
          </button>
        </header>

        <div className="picker-path">
          <input
            value={draft}
            spellCheck={false}
            placeholder="/absolute/path"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.stopPropagation();
                void open(draft);
              }
            }}
          />
          <button onClick={() => void open(draft)} disabled={busy}>
            go
          </button>
        </div>

        <nav className="picker-crumbs">
          <button onClick={() => void open("/")}>/</button>
          {listing && (
            <button onClick={() => void open(listing.home)} title={listing.home}>
              ~
            </button>
          )}
          {crumbs.map((c) => (
            <button key={c.path} onClick={() => void open(c.path)}>
              {c.name}
            </button>
          ))}
        </nav>

        <div className="picker-tools">
          <input
            className="picker-filter"
            value={filter}
            placeholder="filter…"
            spellCheck={false}
            onChange={(e) => {
              setFilter(e.target.value);
              setCursor(0);
            }}
          />
          <label className="picker-check">
            <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
            show dotfiles
          </label>
          {listing?.parent && <button onClick={() => void open(listing.parent!)}>up</button>}
        </div>

        {error && <p className="picker-error">{error}</p>}

        <div className="picker-list" ref={listRef}>
          {busy && !listing && <p className="picker-empty">reading…</p>}
          {listing && rows.length === 0 && <p className="picker-empty">no subdirectories here</p>}
          {rows.map((d, i) => (
            <div
              key={d.path}
              data-i={i}
              className={`picker-row ${i === cursor ? "on" : ""} ${d.marker ? "repo" : ""}`}
              onMouseEnter={() => setCursor(i)}
              onDoubleClick={() => d.readable && void open(d.path)}
            >
              <button className="picker-name" onClick={() => d.readable && void open(d.path)} disabled={!d.readable}>
                <span className="picker-icon">{d.marker ? "◆" : "▸"}</span>
                {d.name}
                {!d.readable && <em>no access</em>}
              </button>
              <span className="picker-meta">
                {d.marker && <em title="repository marker">{d.marker}</em>}
                {d.sourceFiles > 0 && <b>{d.sourceFiles} src</b>}
                {d.subdirs > 0 && <i>{d.subdirs} dirs</i>}
              </span>
              <button className="picker-use" onClick={() => pick(d.path)}>
                watch
              </button>
            </div>
          ))}
        </div>

        {recents.length > 0 && (
          <div className="picker-recents">
            <span>recent</span>
            {recents.map((p) => (
              <button key={p} onClick={() => pick(p)} title={p}>
                {p.split("/").slice(-2).join("/")}
              </button>
            ))}
          </div>
        )}

        <footer>
          <div className="picker-current">
            {listing?.self && (
              <>
                <code>{listing.path}</code>
                <span>
                  {listing.self.sourceFiles} analyzable files here
                  {listing.self.marker ? ` · ${listing.self.marker}` : ""}
                </span>
              </>
            )}
          </div>
          <button className="primary" disabled={!listing} onClick={() => listing && pick(listing.path)}>
            watch this folder
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
