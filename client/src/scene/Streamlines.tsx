/**
 * The streamline bundle. One merged mesh, coloured by the transfer function,
 * with travelling emissive pulses injected into a standard material — which is
 * both what makes the bundle self-lit and what keeps it exportable as valid
 * glTF, since a raw ShaderMaterial is not.
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { SceneGraph } from "@shared/protocol";
import { buildTubes } from "../lib/tubes";
import { useDisposable } from "../lib/useDisposable";
import { useStore } from "../state/store";

interface Props {
  scene: SceneGraph;
}

export function Streamlines({ scene }: Props) {
  const { thickness, speed, pulses, bloom } = useStore((s) => s.view);
  const uniforms = useRef({
    uTime: { value: 0 },
    uPulse: { value: 1 },
    uGlow: { value: 0.95 },
    uBoost: { value: 1 },
    uSince: { value: 0 },
  });

  // Per-line heat: how hot the hottest node on that path is right now. The
  // shader cools it from there, so colour keeps changing between server
  // messages instead of freezing until the next one arrives.
  const heatByNode = useMemo(() => {
    const map = new Map<string, number>();
    for (const node of scene.nodes) map.set(node.id, node.heat);
    return map;
  }, [scene.nodes]);

  const build = useDisposable(
    () =>
      buildTubes(scene.streamlines, scene.domain, thickness, 3, (line) =>
        line.nodeIds.reduce((m, id) => Math.max(m, heatByNode.get(id) ?? 0), 0),
      ),
    [scene.streamlines, scene.domain, thickness, heatByNode],
    (b) => b.geometry.dispose(),
  );

  // Restart the cooldown clock whenever a new scene lands.
  useEffect(() => {
    uniforms.current.uSince.value = 0;
  }, [scene.rev]);

  useFrame((_, dt) => {
    uniforms.current.uTime.value += dt * speed;
    uniforms.current.uSince.value += dt;
    uniforms.current.uPulse.value += ((pulses ? 1 : 0) - uniforms.current.uPulse.value) * Math.min(1, dt * 6);
    // "bloom" is now an emissive boost rather than a screen-space pass.
    const wanted = bloom ? 1.35 : 1;
    uniforms.current.uBoost.value += (wanted - uniforms.current.uBoost.value) * Math.min(1, dt * 5);
  });

  return (
    <mesh geometry={build.geometry} name="streamlines" frustumCulled={false}>
      <meshStandardMaterial
        vertexColors
        roughness={0.62}
        metalness={0.05}
        emissive="#ffffff"
        emissiveIntensity={1}
        toneMapped
        onBeforeCompile={(shader) => {
          Object.assign(shader.uniforms, uniforms.current);
          shader.vertexShader = shader.vertexShader
            .replace(
              "#include <common>",
              `#include <common>
               attribute float aT;
               attribute float aLine;
               attribute float aHeat;
               varying float vT;
               varying float vLine;
               varying float vHeat;`,
            )
            .replace(
              "#include <begin_vertex>",
              `#include <begin_vertex>
               vT = aT;
               vLine = aLine;
               vHeat = aHeat;`,
            );
          shader.fragmentShader = shader.fragmentShader
            .replace(
              "#include <color_fragment>",
              `#include <color_fragment>
               // Keep the pure transfer-function colour, then damp the lit
               // response so scene lights tint rather than wash out the bundle.
               flowColor = diffuseColor.rgb;
               diffuseColor.rgb *= 0.17;`,
            )
            .replace(
              "#include <common>",
              `#include <common>
               uniform float uTime;
               uniform float uPulse;
               uniform float uGlow;
               uniform float uBoost;
               uniform float uSince;
               varying float vT;
               varying float vLine;
               varying float vHeat;
               vec3 flowColor = vec3(1.0);
               float hash11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }`,
            )
            .replace(
              "#include <emissivemap_fragment>",
              `#include <emissivemap_fragment>
               // Base emissive so the whole bundle reads as self-lit, like a
               // scientific viewer's unlit streamlines.
               // Live cooldown: a path that just changed burns warm and fades
               // back to its resting colour continuously, on the GPU, so the
               // colour is always current rather than as-of-the-last-message.
               float cooled = vHeat * exp(-uSince / 4.5);
               float beat = 0.5 + 0.5 * sin(uSince * 5.0);
               // Stay inside the warm end of the ramp rather than climbing out
               // of it: pushed any brighter the hue clips and every hot path
               // turns the same white, which loses the thing being shown.
               vec3 hot = mix(vec3(0.95, 0.30, 0.06), vec3(1.0, 0.66, 0.16), beat);
               vec3 shown = mix(flowColor, hot, clamp(cooled, 0.0, 1.0));
               totalEmissiveRadiance = shown * uGlow * uBoost * (1.0 + cooled * 0.45);
               // Two offset packets per line travel from inlet to outlet.
               float off = hash11(vLine + 7.0);
               float head = fract(uTime * 0.22 + off);
               float d1 = abs(vT - head);
               float d2 = abs(vT - fract(head + 0.5));
               float pulse = exp(-pow(d1 * 26.0, 2.0)) + 0.55 * exp(-pow(d2 * 30.0, 2.0));
               totalEmissiveRadiance += shown * pulse * 1.5 * uPulse;
               totalEmissiveRadiance += vec3(1.0) * pulse * 0.18 * uPulse;`,
            );
        }}
      />
    </mesh>
  );
}
