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
import { ACESFilmicToneMapping, SRGBColorSpace, WebGLRenderer } from "three";
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
 * and throws a bare `Error creating WebGL context.` when that one request is
 * refused — after printing the browser's real explanation to the console,
 * where a user staring at the page will never see it. Both halves of that are
 * fixed here by asking for the context directly and handing the result to
 * three.js, which then cannot fail.
 *
 * The attributes are a wish list, not requirements: `high-performance` asks for
 * the discrete GPU, `antialias` for a multisampled drawing buffer. A browser on
 * a software rasteriser can refuse that exact combination and grant a plainer
 * one, so the same real canvas is asked three times, each time for less.
 * Attributes only bind on the request that actually creates the context, so a
 * refused attempt costs nothing and leaves the canvas reusable.
 *
 * When every attempt is refused, the browser's own reason is thrown — it is the
 * only text that distinguishes "this machine has no GPU access" from anything
 * the application could have done differently. Chromium words that one:
 *
 *   GL_VENDOR = Disabled, GL_RENDERER = Disabled, Sandboxed = yes,
 *   ErrorMessage = BindToCurrentSequence failed
 *
 * which means its GPU process is gone, and no amount of retrying will bring it
 * back — only restarting the browser will.
 */
function makeRenderer(canvas: HTMLCanvasElement): WebGLRenderer {
  const attempts: WebGLContextAttributes[] = [
    { antialias: true, powerPreference: "high-performance", alpha: false, stencil: false },
    { antialias: false, powerPreference: "default", alpha: false, stencil: false },
    { antialias: false, powerPreference: "low-power", alpha: true, stencil: false, failIfMajorPerformanceCaveat: false },
  ];

  // The only place the browser says *why*; it arrives as an event, not a throw.
  let why = "";
  const capture = (e: Event) => {
    const message = (e as WebGLContextEvent).statusMessage;
    if (message) why = message;
  };
  canvas.addEventListener("webglcontextcreationerror", capture, false);
  try {
    for (const attrs of attempts) {
      const context = canvas.getContext("webgl2", attrs);
      if (context) return new WebGLRenderer({ canvas, context, ...attrs });
    }
    // Nothing left to try, but there is one more thing worth knowing: whether
    // this browser has WebGL at all or only the version three.js dropped in
    // r163. This poisons the canvas for WebGL2, which is moot — we are leaving.
    if (canvas.getContext("webgl")) {
      throw new Error("this browser view offers WebGL 1 only, and the renderer needs WebGL 2");
    }
    throw new Error(why || "the browser refused a WebGL context and gave no reason");
  } finally {
    canvas.removeEventListener("webglcontextcreationerror", capture);
  }
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
