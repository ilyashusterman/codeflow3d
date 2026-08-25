/**
 * The contents of each HUD drawer.
 *
 * These used to live in a rail pinned to the right edge, which meant the
 * controls were permanently eating a column of the view. They are now panels
 * that rise out of the bottom bar on demand, so the scene keeps the whole
 * window and the controls are one click (or one key) away.
 */
import { useEffect, useState } from "react";
import { send, watchPath } from "../net/socket";
import { useStore, type ViewSettings } from "../state/store";
import { download, exportAndSave } from "../export/glb";
import { FolderPicker, rememberPath } from "./FolderPicker";

function Toggle({ k, label }: { k: keyof ViewSettings; label: string }) {
  const value = useStore((s) => s.view[k]) as boolean;
  const setView = useStore((s) => s.setView);
  return (
    <button className={`toggle ${value ? "on" : ""}`} onClick={() => setView({ [k]: !value } as never)}>
      <i />
      {label}
    </button>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format = (v: number) => v.toFixed(2),
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
}) {
  return (
    <label className="slider">
      <span>
        {label}
        <em>{format(value)}</em>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

/**
 * What the app can and cannot see of edits you have not saved.
 *
 * This panel exists because the honest answer is usually "nothing yet", and a
 * viewer that shows nothing is indistinguishable from a broken one.
 *
 * Unsaved buffers are read from the editor's hot-exit backup store. That store
 * is real and the parser works — but VS Code and Cursor on desktop only write
 * it when a window closes, not while you type, so with default settings there
 * is genuinely nothing on disk to read until you save. Rather than imply
 * otherwise, this says which of the three routes is actually live.
 */
function LiveTyping() {
  const stats = useStore((s) => s.scene?.stats);
  const [copied, setCopied] = useState(false);
  if (!stats) return null;

  const pushing = stats.pushedBuffers > 0;
  const scanning = stats.unsavedSeen > 0;
  const state = pushing ? "push" : scanning ? "backup" : "save";
  const snippet = '"files.autoSave": "afterDelay",\n"files.autoSaveDelay": 120';

  return (
    <div className="drawer-col wide">
      <h5>live typing</h5>
      <div className="live-rows">
        <div className={`live-row ${state === "push" ? "ok" : "off"}`}>
          <span>pushed buffers</span>
          <em>{stats.pushedBuffers || "—"}</em>
        </div>
        <div className={`live-row ${state === "backup" ? "ok" : "off"}`}>
          <span>editor backups</span>
          <em>
            {stats.backupStores} store{stats.backupStores === 1 ? "" : "s"}
            {stats.backupStores ? ` · ${stats.unsavedSeen || 0} seen` : ""}
          </em>
        </div>
        <div className="live-row ok">
          <span>on save</span>
          <em>watching</em>
        </div>
      </div>
      {state === "save" ? (
        <>
          <p className="hint">
            Nothing is reporting unsaved edits, so a file only appears here once
            you save it. That is not a setting you have wrong: desktop VS Code
            and Cursor write their hot-exit backups when a window closes, not
            while you type, so there is nothing on disk to read.
          </p>
          <p className="hint">
            The fix is the bundled editor extension, which sends the buffer on
            every keystroke — <code>bun editor/install.ts</code>, then restart
            your editor. Failing that, autosave routes real writes through the
            save path in about 8ms.
          </p>
          <button
            className="ghost"
            onClick={() => {
              void navigator.clipboard?.writeText(snippet);
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            }}
          >
            {copied ? "copied" : "copy autosave settings"}
          </button>
        </>
      ) : (
        <p className="hint">
          {state === "push"
            ? "An editor is sending buffers as you type — this is as live as it gets."
            : "Unsaved buffers are being read from the editor's backup store."}
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------- repo

export function RepoPanel() {
  const scene = useStore((s) => s.scene);
  const detail = useStore((s) => s.detail);
  const phase = useStore((s) => s.phase);
  const [path, setPath] = useState("");
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (scene?.root) setPath((p) => p || scene.root);
  }, [scene?.root]);

  const doWatch = async (target: string) => {
    setError(null);
    try {
      await watchPath(target);
      setPath(target);
      rememberPath(target);
      setPicking(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <>
      {picking && (
        <FolderPicker
          initialPath={path || scene?.root || ""}
          onPick={(p) => void doWatch(p)}
          onClose={() => setPicking(false)}
        />
      )}
      <div className="drawer-col wide">
        <h5>watch a local repository</h5>
        <div className="path-row">
          <input
            value={path}
            spellCheck={false}
            placeholder="/absolute/path/to/repo"
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && doWatch(path)}
          />
          <button onClick={() => doWatch(path)} disabled={!path}>
            watch
          </button>
          <button className="ghost" onClick={() => setPicking(true)}>
            choose folder…
          </button>
          <button className="ghost" onClick={() => send({ t: "reanalyze" })}>
            re-scan
          </button>
        </div>
        <p className={`status ${phase}`}>
          {phase}
          {detail ? ` · ${detail}` : ""}
        </p>
        {error && <p className="status error">{error}</p>}
      </div>

      {scene && <LiveTyping />}

      {scene && (
        <div className="drawer-col">
          <h5>graph confidence</h5>
          <div className="conf-rows">
            {(["import", "member", "local", "unique", "weak"] as const).map((k) => {
              const n = scene.stats.byConfidence[k] ?? 0;
              const total = Math.max(1, scene.stats.edges);
              const inferred = k === "unique" || k === "weak";
              return (
                <div className="conf-row" key={k}>
                  <span className={inferred ? "warn" : "ok"}>{k}</span>
                  <i>
                    <b style={{ width: `${(n / total) * 100}%` }} className={inferred ? "warn" : "ok"} />
                  </i>
                  <em>{n}</em>
                </div>
              );
            })}
          </div>
          <p className="hint">
            The top three come from bindings actually in scope. The last two are
            name-match inference, drawn the same but counted apart.
          </p>
        </div>
      )}
    </>
  );
}

// --------------------------------------------------------------- navigate

export function NavPanel() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const resetPanels = useStore((s) => s.resetPanels);
  const alignPanels = useStore((s) => s.alignPanels);

  return (
    <>
      <div className="drawer-col">
        <h5>mode</h5>
        <div className="preset-row">
          {(["orbit", "fly"] as const).map((m) => (
            <button
              key={m}
              className={`preset ${view.navMode === m ? "on" : ""}`}
              onClick={() => setView({ navMode: m })}
            >
              {m}
            </button>
          ))}
        </div>
        <p className="hint">
          {view.navMode === "fly"
            ? "click empty space to capture the mouse · esc releases it"
            : "drag to orbit · scroll to zoom · right-drag to pan"}
        </p>
      </div>

      <div className="drawer-col">
        <h5>keys</h5>
        <dl className="keymap">
          <dt>W A S D</dt>
          <dd>move (arrows too)</dd>
          <dt>Q / E</dt>
          <dd>down / up</dd>
          <dt>shift</dt>
          <dd>sprint</dd>
          <dt>F</dt>
          <dd>orbit ⇄ fly</dd>
          <dt>Tab</dt>
          <dd>this bar</dd>
          <dt>C</dt>
          <dd>change log</dd>
          <dt>G</dt>
          <dd>align screens</dd>
        </dl>
      </div>

      <div className="drawer-col">
        <h5>screens</h5>
        <div className="preset-row">
          {(["stagger", "wall", "arc"] as const).map((m) => (
            <button
              key={m}
              className={`preset ${view.screenLayout === m ? "on" : ""}`}
              onClick={() => setView({ screenLayout: m })}
              title={
                m === "wall"
                  ? "line every screen up on one plane"
                  : m === "arc"
                    ? "curve the wall around you"
                    : "step them back in depth"
              }
            >
              {m}
            </button>
          ))}
        </div>
        <Slider
          label="screen size"
          value={view.screenScale}
          min={0.5}
          max={2.5}
          step={0.05}
          onChange={(v) => setView({ screenScale: v })}
          format={(v) => `${v.toFixed(2)}×`}
        />
        <button className={`toggle ${view.tail ? "on" : ""}`} onClick={() => setView({ tail: !view.tail })}>
          <i />
          follow changes
        </button>
        <p className="hint">
          <b>Click</b> a screen and it turns to face you. <b>Double-click</b>
          flies you in until it fills the frame; <b>esc</b> flies back.
          <b> Drag</b> moves it in the plane you are looking at, and the wheel
          pushes it away or pulls it closer.
        </p>
        <p className="hint">
          Tethers run from each screen to its definitions — warm out of the left
          edge for the code the last write touched, cool out of the right for
          the rest of the file.
        </p>
        <button className="ghost wide" onClick={alignPanels}>
          align into a grid
        </button>
        <button className="ghost wide" onClick={resetPanels}>
          reset screen positions
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- display

export function DisplayPanel() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);

  return (
    <>
      <div className="drawer-col">
        <h5>preset</h5>
        <div className="preset-row">
          {(["flat", "cinematic"] as const).map((p) => (
            <button
              key={p}
              className={`preset ${view.preset === p ? "on" : ""}`}
              onClick={() => setView({ preset: p })}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      <div className="drawer-col">
        <h5>layers</h5>
        <div className="toggles">
          <Toggle k="streamlines" label="streamlines" />
          <Toggle k="glyphs" label="glyphs" />
          <Toggle k="panels" label="screens" />
          <Toggle k="tree" label="module tree" />
          <Toggle k="importLinks" label="import map" />
          <Toggle k="screenLinks" label="screen links" />
          <Toggle k="grid" label="grid" />
          <Toggle k="pulses" label="pulses" />
          <Toggle k="bloom" label="glow" />
          <Toggle k="autoOrbit" label="auto-orbit" />
        </div>
      </div>

      <div className="drawer-col">
        <h5>tuning</h5>
        <Slider
          label="tube radius"
          value={view.thickness}
          min={0.3}
          max={3}
          step={0.05}
          onChange={(v) => setView({ thickness: v })}
        />
        <Slider
          label="pulse speed"
          value={view.speed}
          min={0}
          max={3}
          step={0.05}
          onChange={(v) => setView({ speed: v })}
        />
      </div>
    </>
  );
}

// ------------------------------------------------------------------ graph

export function GraphPanel() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const [traces, setTraces] = useState(3);
  const [panelCount, setPanelCount] = useState(5);

  return (
    <>
      <div className="drawer-col">
        <h5>edge bundling</h5>
        <Slider
          label="strength"
          value={view.bundle}
          min={0}
          max={1}
          step={0.02}
          onChange={(v) => {
            setView({ bundle: v });
            send({ t: "config", bundle: v });
          }}
        />
        <p className="hint">
          0 draws every call edge where it really is. Higher pulls paths toward
          their module trunk, so routes through the same module braid together.
        </p>
      </div>

      <div className="drawer-col">
        <h5>density</h5>
        <Slider
          label="traces / path"
          value={traces}
          min={1}
          max={8}
          step={1}
          format={(v) => String(v)}
          onChange={(v) => {
            setTraces(v);
            send({ t: "config", tracesPerPath: v });
          }}
        />
        <Slider
          label="screens on stage"
          value={panelCount}
          min={1}
          max={6}
          step={1}
          format={(v) => String(v)}
          onChange={(v) => {
            setPanelCount(v);
            send({ t: "config", maxPanels: v });
          }}
        />
      </div>
    </>
  );
}

// ----------------------------------------------------------------- export

export function ExportPanel({ onViewGlb }: { onViewGlb: (url: string) => void }) {
  const scene = useStore((s) => s.scene);
  const exportState = useStore((s) => s.exportState);
  const setExport = useStore((s) => s.setExport);

  const doExport = async () => {
    setExport({ busy: true, error: null });
    try {
      const { bytes, url, name } = await exportAndSave();
      setExport({ busy: false, last: url ?? null });
      download(bytes, name ?? "codeflow3d.glb");
      if (url) onViewGlb(url);
    } catch (err) {
      setExport({ busy: false, error: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="drawer-col wide">
      <h5>export the scene</h5>
      <div className="path-row">
        <button className="primary" onClick={doExport} disabled={exportState.busy || !scene}>
          {exportState.busy ? "building glb…" : "export .glb"}
        </button>
        {exportState.last && (
          <>
            <button className="ghost" onClick={() => onViewGlb(exportState.last!)}>
              open in model-viewer
            </button>
            <a className="ghost as-link" href={exportState.last} download>
              download
            </a>
          </>
        )}
      </div>
      {exportState.error && <p className="status error">{exportState.error}</p>}
      <p className="hint">
        Saved under <code>exports/</code> as glTF 2.0. The same file opens in{" "}
        <a href="https://f3d.app/" target="_blank" rel="noreferrer">
          F3D
        </a>
        , Blender, or anything else that reads glTF.
      </p>
    </div>
  );
}
