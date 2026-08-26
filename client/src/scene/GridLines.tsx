/**
 * The reference grid, and how it arrives.
 *
 * The lines do not simply appear. Each one starts scattered — offset and
 * rotated out of place — and settles into its true position, staggered so the
 * grid assembles in order rather than snapping into existence. It reads as the
 * space being built around you, and it makes the structure legible on the way
 * in: you watch the floor find its rows, then the walls find theirs.
 *
 * The whole animation is one uniform driving a vertex shader, so it costs a
 * float per frame rather than a geometry rebuild.
 */
import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, NormalBlending, ShaderMaterial } from "three";
import { useDisposed } from "../lib/useDisposable";

export interface GridSegment {
  a: [number, number, number];
  b: [number, number, number];
  color: Color;
  /** 0..1 — when in the assembly this line settles. */
  order: number;
}

const VERT = /* glsl */ `
  attribute vec3 aScatter;
  attribute float aOrder;
  attribute vec3 aColor;
  uniform float uProgress;
  varying vec3 vColor;
  varying float vSettled;

  void main() {
    // Each line gets its own slice of the timeline; within that slice it eases
    // from its scattered position to its real one.
    float span = 0.35;
    float local = clamp((uProgress - aOrder * (1.0 - span)) / span, 0.0, 1.0);
    float eased = local * local * (3.0 - 2.0 * local);

    vec3 settled = mix(position + aScatter, position, eased);
    vSettled = eased;
    vColor = aColor;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(settled, 1.0);
  }
`;

const FRAG = /* glsl */ `
  uniform float uOpacity;
  varying vec3 vColor;
  varying float vSettled;

  void main() {
    // A line flashes brighter as it lands, then fades to its resting colour.
    float land = smoothstep(0.55, 1.0, vSettled);
    float arriving = (1.0 - abs(vSettled - 0.85) / 0.15);
    float flash = max(0.0, arriving) * 0.9;
    vec3 rgb = vColor * (0.35 + 0.65 * land) + vec3(0.35, 0.55, 0.75) * flash;
    gl_FragColor = vec4(rgb, uOpacity * (0.15 + 0.85 * land));

    // Colours arrive linear (three converts them on the way in). A raw
    // ShaderMaterial does not get the renderer's output conversion for free,
    // so without this the whole grid renders far darker than it should.
    #include <colorspace_fragment>
  }
`;

export function GridLines({
  segments,
  opacity = 0.85,
  duration = 2.2,
  additive = false,
  name,
}: {
  segments: GridSegment[];
  opacity?: number;
  /** Seconds for the whole grid to assemble. */
  duration?: number;
  additive?: boolean;
  name?: string;
}) {
  const geometry = useDisposed(() => {
    const count = segments.length * 2;
    const position = new Float32Array(count * 3);
    const scatter = new Float32Array(count * 3);
    const color = new Float32Array(count * 3);
    const order = new Float32Array(count);

    segments.forEach((seg, i) => {
      for (const [k, point] of [seg.a, seg.b].entries()) {
        const v = (i * 2 + k) * 3;
        position[v] = point[0];
        position[v + 1] = point[1];
        position[v + 2] = point[2];
        color[v] = seg.color.r;
        color[v + 1] = seg.color.g;
        color[v + 2] = seg.color.b;
        order[i * 2 + k] = seg.order;
      }

      // Both ends of a line share one scatter vector, so the line drifts in as
      // a rigid piece instead of stretching.
      const angle = (i * 2.399963) % (Math.PI * 2);
      const radius = 3 + ((i * 7919) % 100) / 100 * 9;
      const lift = 2 + ((i * 104729) % 100) / 100 * 7;
      const dx = Math.cos(angle) * radius;
      const dz = Math.sin(angle) * radius;
      for (let k = 0; k < 2; k++) {
        const v = (i * 2 + k) * 3;
        scatter[v] = dx;
        scatter[v + 1] = lift;
        scatter[v + 2] = dz;
      }
    });

    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(position, 3));
    geo.setAttribute("aScatter", new BufferAttribute(scatter, 3));
    geo.setAttribute("aColor", new BufferAttribute(color, 3));
    geo.setAttribute("aOrder", new BufferAttribute(order, 1));
    geo.computeBoundingSphere();
    return geo;
  }, [segments]);

  const material = useDisposed(
    () =>
      new ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: { uProgress: { value: 0 }, uOpacity: { value: opacity } },
        transparent: true,
        depthWrite: false,
        blending: additive ? AdditiveBlending : NormalBlending,
      }),
    [opacity, additive],
  );

  const elapsed = useRef(0);
  useFrame((_, dt) => {
    elapsed.current = Math.min(duration, elapsed.current + dt);
    material.uniforms.uProgress.value = elapsed.current / duration;
    material.uniforms.uOpacity.value = opacity;
  });

  return <lineSegments geometry={geometry} material={material} name={name} frustumCulled={false} />;
}
