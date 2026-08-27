/**
 * Scene assembly: camera framing, atmosphere, the live layers, and the
 * `export-root` group that the GLB exporter serializes.
 *
 * There is deliberately no post-processing chain. An EffectComposer with bloom
 * used to sit at the end of this and rendered the entire frame black — a
 * full-screen pass that can silently swallow the scene is not worth its cost,
 * and it is GPU time on every frame. The glow comes from where it should: the
 * streamline material is emissive, and the glyphs carry additive halo sprites.
 * The `bloom` setting now drives those directly.
 */
import { useEffect, useMemo } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { ACESFilmicToneMapping, SRGBColorSpace, WebGLRenderer, type WebGLRendererParameters } from "three";
import type { SceneGraph } from "@shared/protocol";
import { useStore } from "../state/store";
import { EXPORT_ROOT_NAME, liveScene } from "../export/glb";
import { Environment3D } from "./Environment";
import { Streamlines } from "./Streamlines";
import { Glyphs } from "./Glyphs";
import { CodePanels } from "./CodePanels";
import { ModuleTree } from "./ModuleTree";
import { ImportLinks } from "./ImportLinks";
import { ScreenLinks } from "./ScreenLinks";
import { Controls, HOME } from "./Controls";
import { ZoomFlight } from "./ZoomFlight";
import { CameraProbe } from "../ui/Hud";

/**
 * Publishes the live three.js scene so the GLB exporter can find its root.
 *
 * The exporter looks its subtree up by name against this scene rather than
 * holding a ref to the group: one handle to the whole scene is simpler to keep
 * correct than a ref per layer, and a name lookup cannot go stale while the
 * objects are still on screen.
 */
function ExportBridge() {
  const three = useThree((state) => state.scene);
  useEffect(() => {
    liveScene.current = three;
    return () => {
      if (liveScene.current === three) liveScene.current = null;
    };
  }, [three]);
  return null;
}

function Layers({ scene }: { scene: SceneGraph }) {
  const view = useStore((s) => s.view);

  return (
    <group name={EXPORT_ROOT_NAME}>
      <ExportBridge />
      <Environment3D />
      {view.streamlines && <Streamlines scene={scene} />}
      {view.importLinks && <ImportLinks scene={scene} />}
      {view.glyphs && <Glyphs scene={scene} />}
      {view.panels && <CodePanels scene={scene} />}
      {view.panels && view.screenLinks && <ScreenLinks scene={scene} />}
      {view.tree && <ModuleTree scene={scene} />}
    </group>
  );
}

/**
 * Build the renderer, degrading the request rather than giving up on it.
 *
 * three.js asks for a context once, with exactly the attributes it was handed,
 * and reports `Error creating WebGL context.` if that one request is refused.
 * Those attributes are a wish list, not requirements: `high-performance` asks
 * the browser for the discrete GPU, and `antialias` asks for a multisampled
 * drawing buffer. An embedded browser running on a software rasteriser — VS
 * Code's built-in browser view, a remote desktop, a VM — can refuse that exact
 * combination while granting a plainer one without complaint.
 *
 * So the same real canvas is asked three times, each time for less. Attributes
 * only take effect on the request that actually creates the context, so a
 * refused attempt costs nothing and leaks nothing.
 *
 * What this cannot paper over: three.js has been WebGL2-only since r163, so a
 * view that offers WebGL1 and nothing else has no path here at all. That case
 * is reported rather than retried — see ui/SceneFallback.
 */
function makeRenderer(canvas: HTMLCanvasElement): WebGLRenderer {
  const attempts: WebGLRendererParameters[] = [
    { antialias: true, powerPreference: "high-performance", alpha: false, stencil: false },
    { antialias: false, powerPreference: "default", alpha: false, stencil: false },
    { antialias: false, powerPreference: "low-power", alpha: true, stencil: false, failIfMajorPerformanceCaveat: false },
  ];
  let last: unknown;
  for (const params of attempts) {
    try {
      return new WebGLRenderer({ canvas, ...params });
    } catch (err) {
      last = err;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export function Scene({
  onCameraSample,
}: {
  /** Feeds the HUD's position read-out from inside the Canvas. */
  onCameraSample: (pos: [number, number, number]) => void;
}) {
  const scene = useStore((s) => s.scene);
  const preset = useStore((s) => s.view.preset);
  const fog = useMemo(
    () => (preset === "cinematic" ? { color: "#05070a", density: 0.026 } : { color: "#1c1f23", density: 0.014 }),
    [preset],
  );

  return (
    <Canvas
      dpr={[1, 2]}
      gl={(canvas) => makeRenderer(canvas as HTMLCanvasElement)}
      camera={{ fov: 33, near: 0.05, far: 300, position: [HOME.x, HOME.y, HOME.z] }}
      onCreated={({ gl, scene: s }) => {
        gl.toneMapping = ACESFilmicToneMapping;
        gl.toneMappingExposure = preset === "cinematic" ? 0.94 : 1.0;
        // Set here because the renderer is built by hand above, and this is the
        // one default of r3f's own that the scene's colours depend on.
        gl.outputColorSpace = SRGBColorSpace;
        s.background = null;
      }}
    >
      <color attach="background" args={[preset === "cinematic" ? "#05070a" : "#26292d"]} />
      <fogExp2 attach="fog" args={[fog.color, fog.density]} />
      <Controls />
      <ZoomFlight scene={scene} />
      <CameraProbe onSample={onCameraSample} />
      {scene && <Layers scene={scene} />}
    </Canvas>
  );
}
