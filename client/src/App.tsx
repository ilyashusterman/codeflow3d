import { useCallback, useEffect, useMemo, useState } from "react";
import { Scene } from "./scene/Scene";
import { StatusToast } from "./ui/StatusToast";
import { GlbViewerPage } from "./ui/GlbViewer";
import { FlatView } from "./ui/FlatView";
import { Hud, HudHotkeys } from "./ui/Hud";
import { SceneBoundary, SceneFallback } from "./ui/SceneFallback";
import { hasWebGL } from "./lib/webgl";
import { connect } from "./net/socket";
import { useStore } from "./state/store";

function LiveApp() {
  const scene = useStore((s) => s.scene);
  const phase = useStore((s) => s.phase);
  const navMode = useStore((s) => s.view.navMode);
  const pointerLocked = useStore((s) => s.pointerLocked);
  const focused = useStore((s) => s.focused);
  const zoomed = useStore((s) => s.zoomed);
  // The floating fly hint would sit on top of an open drawer, which documents
  // the same keys properly a few pixels above it.
  const drawer = useStore((s) => s.drawer);
  const setZoomed = useStore((s) => s.setZoomed);
  const moving = useStore((s) => s.moving);
  const [cameraPos, setCameraPos] = useState<[number, number, number]>([0, 0, 0]);
  /*
   * Whether there is a scene to draw, decided before the first render.
   *
   * `<Canvas>` throws when it cannot get a context, and a throw during render
   * takes the whole tree with it — which is why an embedded browser without
   * WebGL used to show a black page instead of an application. Probing first
   * keeps the HUD, the change log and the editor alive, and the boundary below
   * catches the scene failing for any other reason.
   */
  const webgl = useMemo(() => hasWebGL(), []);
  const [sceneError, setSceneError] = useState<string | null>(null);

  useEffect(() => {
    connect();
  }, []);

  const sample = useCallback((pos: [number, number, number]) => setCameraPos(pos), []);

  // Panels fade while flying and while a file is open flat; the HUD strip and
  // the crosshair stay, the way a game keeps its reticle and status bar.
  const chromeHidden = moving || pointerLocked || Boolean(focused);

  return (
    <div className={`app ${chromeHidden ? "flying" : ""} ${drawer ? "drawer-open" : ""}`}>
      {webgl && (
        <SceneBoundary onError={setSceneError}>
          <Scene onCameraSample={sample} />
        </SceneBoundary>
      )}
      {(!webgl || sceneError) && <SceneFallback reason={sceneError} />}
      <StatusToast />
      <Hud
        cameraPos={cameraPos}
        onViewGlb={(url) => window.open(`/viewer?src=${encodeURIComponent(url)}`, "_blank")}
      />
      <HudHotkeys />
      <FlatView />

      {zoomed && !focused && (
        <div className="zoom-hud">
          <span className="zoom-file">{zoomed}</span>
          <button onClick={() => setZoomed(null)}>back  esc</button>
        </div>
      )}

      {webgl && !sceneError && navMode === "fly" && pointerLocked && <div className="crosshair" />}
      {webgl && !sceneError && navMode === "fly" && !pointerLocked && !focused && (
        <div className="nav-hint">
          click the scene to fly · <b>WASD</b> move · <b>Q/E</b> down/up · <b>shift</b> sprint ·{" "}
          <b>esc</b> release
        </div>
      )}

      {!scene && webgl && !sceneError && (
        <div className="boot">
          <div className="boot-card">
            <h1>codeflow3d</h1>
            <p>
              {phase === "analyzing"
                ? "parsing the repo with tree-sitter…"
                : "point it at a local repository to start tracing."}
            </p>
            <div className="boot-spin" />
          </div>
        </div>
      )}
    </div>
  );
}

/** Two pages, no router: the live trace, and the exported-asset viewer. */
export default function App() {
  return location.pathname === "/viewer" ? <GlbViewerPage /> : <LiveApp />;
}
