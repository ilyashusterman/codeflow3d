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
import { ACESFilmicToneMapping } from "three";
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
      gl={{ antialias: true, powerPreference: "high-performance", alpha: false, stencil: false }}
      camera={{ fov: 33, near: 0.05, far: 300, position: [HOME.x, HOME.y, HOME.z] }}
      onCreated={({ gl, scene: s }) => {
        gl.toneMapping = ACESFilmicToneMapping;
        gl.toneMappingExposure = preset === "cinematic" ? 0.94 : 1.0;
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
