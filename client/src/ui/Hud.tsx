/**
 * The heads-up display: everything that is not the scene.
 *
 * Laid out the way a game does it. A thin status strip along the bottom that is
 * always readable, and the controls in drawers that rise out of it on demand
 * rather than a rail permanently eating a column of the view. The whole thing
 * fades while you are flying and comes back a moment after you stop, so it is
 * never in the way mid-flight and never more than a keystroke away.
 */
import { useEffect, useMemo, useState } from "react";
import { useThree } from "@react-three/fiber";
import { useStore } from "../state/store";
import { rampGradient } from "../lib/colormap";
import { RepoPanel, NavPanel, DisplayPanel, GraphPanel, ExportPanel } from "./Panels";
import { ChangeLog } from "./ActivityFeed";

/** Live camera read-out. Must live inside the Canvas to see the camera. */
export function CameraProbe({ onSample }: { onSample: (pos: [number, number, number]) => void }) {
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    let raf = 0;
    let last = 0;
    let shown = "";
    const tick = (t: number) => {
      // Four samples a second is plenty for a coordinate read-out, and only
      // when the displayed value actually changes. Pushing state on every
      // sample re-rendered the whole app several times a second whether the
      // camera had moved or not.
      if (t - last > 250) {
        last = t;
        const { x, y, z } = camera.position;
        const key = `${x.toFixed(1)} ${y.toFixed(1)} ${z.toFixed(1)}`;
        if (key !== shown) {
          shown = key;
          onSample([x, y, z]);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [camera, onSample]);
  return null;
}

function ago(at: number, now: number) {
  const s = Math.max(0, (now - at) / 1000);
  if (s < 1) return "now";
  if (s < 60) return `${s.toFixed(0)}s`;
  if (s < 3600) return `${(s / 60).toFixed(0)}m`;
  return `${(s / 3600).toFixed(0)}h`;
}

export type DrawerId = "repo" | "nav" | "display" | "graph" | "export" | "changes";

const TABS: { id: DrawerId; label: string; key?: string }[] = [
  { id: "changes", label: "changes", key: "C" },
  { id: "repo", label: "repo" },
  { id: "nav", label: "navigate", key: "F" },
  { id: "display", label: "display" },
  { id: "graph", label: "graph" },
  { id: "export", label: "export" },
];

export function Hud({
  cameraPos,
  onViewGlb,
}: {
  cameraPos: [number, number, number];
  onViewGlb: (url: string) => void;
}) {
  const scene = useStore((s) => s.scene);
  const connected = useStore((s) => s.connected);
  const phase = useStore((s) => s.phase);
  const events = useStore((s) => s.events);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const drawer = useStore((s) => s.drawer);
  const setDrawer = useStore((s) => s.setDrawer);
  const pointerLocked = useStore((s) => s.pointerLocked);
  const focused = useStore((s) => s.focused);
  const alignPanels = useStore((s) => s.alignPanels);
  const panelPos = useStore((s) => s.panelPos);
  const panelRot = useStore((s) => s.panelRot);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const gradient = useMemo(() => rampGradient(40), []);
  const latest = events.find((e) => e.kind === "change" || e.kind === "add");
  const [lo, hi] = scene?.domain ?? [-2, 8];
  const changeCount = events.filter((e) => e.kind !== "addDir").length;

  /**
   * How many screens are out of the grid.
   *
   * Screens start aligned and stay wherever you put them, so this is the
   * signal that there is anything to snap back — the button reads as a live
   * action when it will do something and as a quiet one when it will not.
   */
  const strayCount = new Set([
    ...Object.keys(panelPos),
    ...Object.keys(panelRot),
  ]).size;

  return (
    <div className={`hud ${focused ? "hidden" : ""}`}>
      {drawer && (
        <div className="hud-drawer">
          <div className="drawer-body">
            {drawer === "changes" && <ChangeLog />}
            {drawer === "repo" && <RepoPanel />}
            {drawer === "nav" && <NavPanel />}
            {drawer === "display" && <DisplayPanel />}
            {drawer === "graph" && <GraphPanel />}
            {drawer === "export" && <ExportPanel onViewGlb={onViewGlb} />}
          </div>
        </div>
      )}

      <div className="hud-bar">
        {/* Left: what is being traced. */}
        <div className="hud-block">
          <span className={`live-dot ${connected ? "on" : ""}`} />
          <span className="hud-project" title={scene?.root ?? ""}>
            {scene?.projectName ?? "—"}
          </span>
          <span className="hud-sep" />
          <span className="hud-stat">
            <b>{scene?.stats.files ?? 0}</b> files
          </span>
          <span className="hud-stat">
            <b>{scene?.stats.nodes ?? 0}</b> defs
          </span>
          <span className="hud-stat">
            <b>{scene?.stats.edges ?? 0}</b> calls
          </span>
        </div>

        {/* Centre: the transfer function this scene is coloured by. */}
        <div className="hud-legend">
          <span>{lo.toFixed(1)}</span>
          <i style={{ background: gradient }} />
          <span>{hi.toFixed(1)}</span>
          <em>settled → just edited</em>
        </div>

        {/* Right: latest change, mode, position, drawers. */}
        <div className="hud-block right">
          {latest ? (
            <span className="hud-latest" title={latest.path}>
              <b>{latest.path.split("/").pop()}</b>
              {latest.added ? <span className="add">+{latest.added}</span> : null}
              {latest.removed ? <span className="del">-{latest.removed}</span> : null}
              <em>{ago(latest.at, now)}</em>
            </span>
          ) : (
            <span className="hud-latest dim">{phase === "analyzing" ? "parsing…" : "watching"}</span>
          )}
          <span className="hud-coords">{cameraPos.map((v) => v.toFixed(1)).join("  ")}</span>
          <button
            className={`hud-align ${strayCount ? "stray" : ""}`}
            onClick={alignPanels}
            title="snap every screen back into the grid (G)"
          >
            ALIGN
            {strayCount > 0 && <b>{strayCount}</b>}
          </button>
          <button
            className={`hud-mode ${view.navMode === "fly" ? "fly" : ""}`}
            onClick={() => setView({ navMode: view.navMode === "fly" ? "orbit" : "fly" })}
            title="orbit ⇄ fly (F)"
          >
            {view.navMode === "fly" ? (pointerLocked ? "FLY ●" : "FLY") : "ORBIT"}
          </button>
          <span className="hud-tabs">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                className={drawer === tab.id ? "on" : ""}
                onClick={() => setDrawer(drawer === tab.id ? null : tab.id)}
                title={tab.key ? `${tab.label} (${tab.key})` : tab.label}
              >
                {tab.label}
                {tab.id === "changes" && changeCount > 0 && <b>{changeCount}</b>}
              </button>
            ))}
          </span>
        </div>
      </div>
    </div>
  );
}

/** Global hotkeys. Kept here so the HUD documents its own keys. */
export function HudHotkeys() {
  const setDrawer = useStore((s) => s.setDrawer);
  const drawer = useStore((s) => s.drawer);
  const setView = useStore((s) => s.setView);
  const navMode = useStore((s) => s.view.navMode);
  const focused = useStore((s) => s.focused);
  const zoomed = useStore((s) => s.zoomed);
  const setZoomed = useStore((s) => s.setZoomed);
  const alignPanels = useStore((s) => s.alignPanels);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      // Flat mode owns the keyboard while it is open.
      if (typing || focused) return;
      // Escape unwinds one step at a time: out of a zoom first, then a drawer.
      if (e.key === "Escape" && zoomed) {
        e.preventDefault();
        setZoomed(null);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        setDrawer(drawer ? null : "display");
      } else if (e.key === "Escape" && drawer) {
        setDrawer(null);
      } else if (e.key.toLowerCase() === "c" && !e.metaKey && !e.ctrlKey) {
        setDrawer(drawer === "changes" ? null : "changes");
      } else if (e.key.toLowerCase() === "f" && !e.metaKey && !e.ctrlKey) {
        setView({ navMode: navMode === "fly" ? "orbit" : "fly" });
      } else if (e.key.toLowerCase() === "g" && !e.metaKey && !e.ctrlKey) {
        alignPanels();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setDrawer, drawer, setView, navMode, focused, zoomed, setZoomed, alignPanels]);

  return null;
}
