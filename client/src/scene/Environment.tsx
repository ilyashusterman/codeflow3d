/**
 * The space the graph sits in: floor, grid, walls, height posts, axes.
 *
 * The grids assemble on load rather than appearing — see GridLines — so the
 * volume builds itself around you in order. Two presets: `flat` is the matte
 * charcoal grid, `cinematic` swaps in the reflective floor.
 */
import { useMemo } from "react";
import { MeshReflectorMaterial } from "@react-three/drei";
import { BufferAttribute, BufferGeometry, Color } from "three";
import { useStore } from "../state/store";
import { useDisposed } from "../lib/useDisposable";
import { GridLines, type GridSegment } from "./GridLines";

/** Floor grid reach. */
const EXTENT = 30;
const STEP = 0.75;
/**
 * The vertical grids sit close enough to the graph to be a usable reference.
 * Pushed out to the floor's edge they are too far away to read height against,
 * which defeats the point of having them.
 */
const WALL = 14;
const WALL_HEIGHT = 8;

const MINOR = new Color("#2c353f");
const MAJOR = new Color("#46545f");

/** Floor rows and columns, assembling from the centre outwards. */
function useFloorSegments(): GridSegment[] {
  return useMemo(() => {
    const out: GridSegment[] = [];
    const n = Math.round(EXTENT / STEP);
    for (let i = -n; i <= n; i++) {
      const v = i * STEP;
      const fade = 1 - Math.min(1, Math.abs(v) / EXTENT) * 0.65;
      const major = i % 8 === 0;
      // Centre lines land first, so the grid grows outwards.
      const order = Math.min(1, Math.abs(i) / n);
      const color = (major ? MAJOR : MINOR).clone().multiplyScalar(fade);
      out.push({ a: [-EXTENT, 0, v], b: [EXTENT, 0, v], color, order });
      out.push({ a: [v, 0, -EXTENT], b: [v, 0, EXTENT], color, order });
    }
    return out;
  }, []);
}

/**
 * Two back walls at right angles. A floor grid alone gives no sense of height —
 * a screen floating at y=3 looks the same as one at y=1 from most angles.
 */
function useWallSegments(): GridSegment[] {
  return useMemo(() => {
    const out: GridSegment[] = [];
    const n = Math.round(WALL / STEP);
    const rows = Math.round(WALL_HEIGHT / STEP);

    const push = (
      a: [number, number, number],
      b: [number, number, number],
      major: boolean,
      fade: number,
      order: number,
    ) => out.push({ a, b, color: (major ? MAJOR : MINOR).clone().multiplyScalar(fade), order });

    for (let i = -n; i <= n; i++) {
      const x = i * STEP;
      const fade = 1 - Math.min(1, Math.abs(x) / WALL) * 0.55;
      push([x, 0, -WALL], [x, WALL_HEIGHT, -WALL], i % 8 === 0, fade, Math.abs(i) / n);
      push([-WALL, 0, x], [-WALL, WALL_HEIGHT, x], i % 8 === 0, fade, Math.abs(i) / n);
    }
    for (let j = 0; j <= rows; j++) {
      const y = j * STEP;
      const fade = 1 - (y / WALL_HEIGHT) * 0.5;
      // Horizontals climb, so the walls build from the floor up.
      push([-WALL, y, -WALL], [WALL, y, -WALL], j % 8 === 0, fade, j / rows);
      push([-WALL, y, -WALL], [-WALL, y, WALL], j % 8 === 0, fade, j / rows);
    }
    return out;
  }, []);
}

/**
 * Height posts: a cross every few floor cells at each height step, so you can
 * read how high something floats without hunting for a wall.
 */
function usePostSegments(): GridSegment[] {
  return useMemo(() => {
    const out: GridSegment[] = [];
    const base = new Color("#3b4854");
    const spacing = STEP * 8;
    const reach = Math.floor(WALL / spacing);
    for (let i = -reach; i <= reach; i++) {
      for (let j = -reach; j <= reach; j++) {
        const x = i * spacing;
        const z = j * spacing;
        const dist = Math.hypot(x, z);
        if (dist > WALL) continue;
        const fade = 1 - Math.min(1, dist / WALL) * 0.6;
        const color = base.clone().multiplyScalar(fade);
        const order = dist / WALL;
        for (let k = 0; k <= 4; k += STEP * 4) {
          out.push({ a: [x - 0.1, k, z], b: [x + 0.1, k, z], color, order });
          out.push({ a: [x, k, z - 0.1], b: [x, k, z + 0.1], color, order });
        }
      }
    }
    return out;
  }, []);
}

/** The faint red/green/blue world axes. */
function WorldAxes() {
  const geo = useDisposed(() => {
    const L = EXTENT;
    const pos = [-L, 0, 0, L, 0, 0, 0, 0, -L, 0, 0, L, 0, 0.02, 0, 0, 4.2, 0];
    // Linear-sRGB: three reads raw colour attributes as already-linear.
    const axis = (r: number, g: number, b: number) => [r, g, b, r, g, b];
    const col = [...axis(0.26, 0.014, 0.016), ...axis(0.014, 0.045, 0.32), ...axis(0.016, 0.13, 0.033)];
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute("color", new BufferAttribute(new Float32Array(col), 3));
    return g;
  }, []);
  return (
    <lineSegments geometry={geo} name="world-axes" position={[0, 0.002, 0]}>
      <lineBasicMaterial vertexColors transparent opacity={0.75} toneMapped={false} />
    </lineSegments>
  );
}

export function Environment3D() {
  const { preset, grid } = useStore((s) => s.view);
  const cinematic = preset === "cinematic";
  const floor = useFloorSegments();
  const walls = useWallSegments();
  const posts = usePostSegments();

  return (
    // Excluded from GLB export: the ground plane would swallow the model's
    // bounding box, and lights are re-supplied by whatever viewer opens it.
    <group name="environment" userData={{ excludeFromExport: true }}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.004, 0]} name="floor">
        <planeGeometry args={[EXTENT * 2, EXTENT * 2]} />
        {cinematic ? (
          <MeshReflectorMaterial
            resolution={1024}
            mirror={0.42}
            mixBlur={2.6}
            mixStrength={2.2}
            blur={[420, 120]}
            depthScale={0.9}
            minDepthThreshold={0.4}
            maxDepthThreshold={1.3}
            roughness={0.82}
            metalness={0.42}
            color="#0a0d11"
          />
        ) : (
          <meshStandardMaterial color="#22262b" roughness={0.95} metalness={0.02} />
        )}
      </mesh>

      {grid && (
        <>
          <GridLines name="grid" segments={floor} opacity={cinematic ? 0.85 : 1} duration={1.8} />
          <GridLines name="wall-grids" segments={walls} opacity={0.8} duration={2.4} />
          <GridLines name="height-posts" segments={posts} opacity={0.85} duration={2.8} />
        </>
      )}

      <WorldAxes />

      <ambientLight intensity={cinematic ? 0.35 : 0.75} />
      <hemisphereLight args={["#8fb6ff", "#0a0d12", cinematic ? 0.4 : 0.7]} />
      <directionalLight position={[6, 9, 8]} intensity={cinematic ? 0.34 : 0.7} color="#cfe3ff" />
      <pointLight position={[-4, 2.4, 2]} intensity={cinematic ? 5 : 4} distance={16} color="#4d8fd6" />
      <pointLight position={[3, 1.6, 1]} intensity={cinematic ? 3.2 : 2.4} distance={12} color="#7fd0ff" />
    </group>
  );
}
