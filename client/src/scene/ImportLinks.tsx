/**
 * The file-level import graph, drawn as arcs above the call bundle.
 *
 * These are not inferred: each arc is an import statement that resolved to a
 * file in this repository. Turning them on shows the module map; the call
 * streamlines below show what actually runs through it.
 */
import { useMemo } from "react";
import { BufferAttribute, BufferGeometry, Color } from "three";
import type { SceneGraph } from "@shared/protocol";
import { useDisposed } from "../lib/useDisposable";

const COOL = new Color("#4f7fa8");
const WARM = new Color("#8fd0ff");

export function ImportLinks({ scene }: { scene: SceneGraph }) {
  const maxWeight = useMemo(
    () => Math.max(1, ...scene.importLinks.map((l) => l.weight)),
    [scene.importLinks],
  );

  const geometry = useDisposed(() => {
    const positions: number[] = [];
    const colors: number[] = [];
    const c = new Color();

    for (const link of scene.importLinks) {
      const count = link.points.length / 3;
      // Heavier imports (more bound names) read brighter.
      c.copy(COOL).lerp(WARM, Math.min(1, link.weight / maxWeight));
      for (let i = 0; i < count - 1; i++) {
        positions.push(
          link.points[i * 3],
          link.points[i * 3 + 1],
          link.points[i * 3 + 2],
          link.points[(i + 1) * 3],
          link.points[(i + 1) * 3 + 1],
          link.points[(i + 1) * 3 + 2],
        );
        // Fade toward the ends so the arcs do not fight the call bundle.
        const fade = Math.sin((Math.PI * i) / Math.max(1, count - 2));
        for (let k = 0; k < 2; k++) {
          colors.push(c.r * fade, c.g * fade, c.b * fade);
        }
      }
    }

    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
    geo.setAttribute("color", new BufferAttribute(new Float32Array(colors), 3));
    geo.computeBoundingSphere();
    return geo;
  }, [scene.importLinks, maxWeight]);

  if (!scene.importLinks.length) return null;

  return (
    <lineSegments geometry={geometry} name="import-links" frustumCulled={false}>
      <lineBasicMaterial vertexColors transparent opacity={0.5} depthWrite={false} toneMapped={false} />
    </lineSegments>
  );
}
