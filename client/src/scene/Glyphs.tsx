/**
 * The bright point glyphs sitting on the streamlines — one per graph node.
 * A merged sphere mesh (exports cleanly) plus an additive sprite halo that
 * gives the soft bloom-ready glow from the reference frames.
 */
import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, type Points } from "three";
import type { SceneGraph } from "@shared/protocol";
import { mapScalarLinear } from "../lib/colormap";
import { makeTexture } from "../lib/canvasTex";
import { mergeSpheres } from "../lib/mergeSpheres";
import { MOTION } from "../lib/motion";
import { useDisposed } from "../lib/useDisposable";

const HOT = new Color("#ffd58a");

function haloTexture() {
  return makeTexture(64, 64, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.25, "rgba(210,235,255,0.55)");
    g.addColorStop(0.6, "rgba(120,180,255,0.14)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });
}

export function Glyphs({ scene }: { scene: SceneGraph }) {
  const halo = useDisposed(haloTexture, []);
  const pointsRef = useRef<Points>(null);
  const uniforms = useRef({ uTime: { value: 0 }, uScale: { value: 420 }, uBirth: { value: MOTION.birth } });

  /**
   * When each definition was first seen, on the same clock the shader runs on.
   *
   * The halo geometry is rebuilt from scratch on every scene message, so "is
   * this node new?" cannot be answered from the geometry — it has to be
   * remembered across rebuilds. Everything present at boot shares a birthday,
   * which is why the graph lights up as it arrives rather than snapping on.
   */
  const born = useRef(new Map<string, number>());

  /**
   * Only nodes a streamline actually visits get a glyph. On a large repo the
   * graph has thousands of functions but the traced paths touch a few hundred;
   * drawing all of them turns the upstream fan into a white blob and says
   * nothing about the flow being visualised.
   */
  const visible = useMemo(() => {
    const visited = new Set<string>();
    for (const line of scene.streamlines) for (const id of line.nodeIds) visited.add(id);
    const nodes = scene.nodes.filter((n) => visited.has(n.id));
    return nodes.length ? nodes : scene.nodes.slice(0, 400);
  }, [scene.streamlines, scene.nodes]);

  // Keep the additive halos from stacking into a wash on dense graphs.
  const density = Math.min(1, 120 / Math.max(1, visible.length));

  /** Merged low-poly spheres, coloured per node. */
  const solid = useDisposed(() => {
    const c = new Color();
    const white = new Color(1, 1, 1);
    return mergeSpheres(
      visible.map((node) => {
        const [cr, cg, cb] = mapScalarLinear(node.scalar, scene.domain);
        return {
          pos: node.pos,
          radius:
            0.032 + Math.min(0.055, Math.log2(1 + node.fanIn + node.fanOut) * 0.014) + node.heat * 0.03,
          color: c.setRGB(cr, cg, cb).lerp(white, 0.55 + node.heat * 0.3).clone(),
        };
      }),
    );
  }, [visible, scene.domain]);

  /** Halo sprites, sized by fan-out and edit heat. */
  const glow = useDisposed(() => {
    const position = new Float32Array(visible.length * 3);
    const size = new Float32Array(visible.length);
    const color = new Float32Array(visible.length * 3);
    const birth = new Float32Array(visible.length);
    const seen = born.current;
    // A graph that churns through renames for hours should not grow a map of
    // every name it ever had.
    if (seen.size > 20_000) seen.clear();
    const clock = uniforms.current.uTime.value;
    const c = new Color();
    visible.forEach((node, i) => {
      let at = seen.get(node.id);
      if (at === undefined) {
        at = clock;
        seen.set(node.id, at);
      }
      birth[i] = at;
      position.set(node.pos, i * 3);
      size[i] =
        (0.16 + Math.min(0.3, node.fanOut * 0.038)) * (0.45 + 0.55 * density) + node.heat * 0.5;
      const [r, g, b] = mapScalarLinear(node.scalar, scene.domain);
      c.setRGB(r, g, b).lerp(HOT, node.heat * 0.85);
      color[i * 3] = c.r;
      color[i * 3 + 1] = c.g;
      color[i * 3 + 2] = c.b;
    });
    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(position, 3));
    geo.setAttribute("aSize", new BufferAttribute(size, 1));
    geo.setAttribute("color", new BufferAttribute(color, 3));
    geo.setAttribute("aBorn", new BufferAttribute(birth, 1));
    geo.computeBoundingSphere();
    return geo;
  }, [visible, scene.domain, density]);

  useFrame((state, dt) => {
    uniforms.current.uTime.value += dt;
    uniforms.current.uScale.value = state.size.height * 0.9;
  });

  return (
    <group name="glyphs">
      <mesh geometry={solid} name="glyph-cores" frustumCulled={false}>
        <meshStandardMaterial
          vertexColors
          roughness={0.25}
          metalness={0}
          emissive="#ffffff"
          emissiveIntensity={1}
          onBeforeCompile={(shader) => {
            shader.fragmentShader = shader.fragmentShader.replace(
              "#include <emissivemap_fragment>",
              `#include <emissivemap_fragment>
               totalEmissiveRadiance = diffuseColor.rgb * 0.6;`,
            );
          }}
        />
      </mesh>

      <points ref={pointsRef} geometry={glow} name="glyph-halos" frustumCulled={false} renderOrder={4}>
        <shaderMaterial
          transparent
          depthWrite={false}
          blending={AdditiveBlending}
          uniforms={{ uMap: { value: halo }, uGain: { value: 0.45 + 0.55 * density }, ...uniforms.current }}
          vertexShader={`
            attribute float aSize;
            attribute float aBorn;
            varying vec3 vColor;
            uniform float uScale;
            uniform float uTime;
            uniform float uBirth;
            void main() {
              // A definition that has just appeared flares and settles: bright
              // and small, growing into its steady size. This is the only cue
              // in the scene that says "this function did not exist a moment
              // ago", so it is worth a second of everyone's attention.
              float age = clamp((uTime - aBorn) / uBirth, 0.0, 1.0);
              float pop = 1.0 - pow(1.0 - age, 3.0);
              vColor = color * (1.0 + 2.2 * (1.0 - pop));
              vec4 mv = modelViewMatrix * vec4(position, 1.0);
              float breathe = 0.92 + 0.08 * sin(uTime * 2.2 + position.x * 3.0);
              gl_PointSize = aSize * breathe * (0.3 + 0.7 * pop) * uScale / max(0.001, -mv.z);
              gl_Position = projectionMatrix * mv;
            }`}
          fragmentShader={`
            uniform sampler2D uMap;
            uniform float uGain;
            varying vec3 vColor;
            void main() {
              vec4 t = texture2D(uMap, gl_PointCoord);
              gl_FragColor = vec4(vColor * t.a * uGain, t.a * 0.8 * uGain);
              if (gl_FragColor.a < 0.01) discard;
            }`}
          vertexColors
        />
      </points>

    </group>
  );
}
