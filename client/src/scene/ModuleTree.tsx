/**
 * The small node-link diagram up and to the left: the repo's directory tree.
 * Pale blue spheres joined by thin lines, exactly the accent element in the
 * reference frames. Recently-touched branches warm up.
 */
import { useMemo } from "react";
import { BufferAttribute, BufferGeometry, Color, type Texture } from "three";
import type { SceneGraph } from "@shared/protocol";
import { makeTexture } from "../lib/canvasTex";
import { mergeSpheres } from "../lib/mergeSpheres";
import { useDisposable, useDisposed } from "../lib/useDisposable";

const COOL = new Color("#8fc6f0");
const WARM = new Color("#ffc46b");

export function ModuleTree({ scene }: { scene: SceneGraph }) {
  const byId = useMemo(() => new Map(scene.tree.map((t) => [t.id, t])), [scene.tree]);

  const spheres = useDisposed(() => {
    const c = new Color();
    return mergeSpheres(
      scene.tree.map((node) => ({
        pos: node.pos,
        radius: node.depth === 0 ? 0.1 : node.isDir ? 0.078 : 0.06,
        color: c.copy(COOL).lerp(WARM, node.heat).clone(),
      })),
    );
  }, [scene.tree]);

  const links = useDisposed(() => {
    const pts: number[] = [];
    const cols: number[] = [];
    const c = new Color();
    for (const node of scene.tree) {
      if (!node.parent) continue;
      const parent = byId.get(node.parent);
      if (!parent) continue;
      pts.push(...parent.pos, ...node.pos);
      c.copy(COOL).lerp(WARM, parent.heat).multiplyScalar(0.8);
      cols.push(c.r, c.g, c.b);
      c.copy(COOL).lerp(WARM, node.heat).multiplyScalar(0.8);
      cols.push(c.r, c.g, c.b);
    }
    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(new Float32Array(pts), 3));
    geo.setAttribute("color", new BufferAttribute(new Float32Array(cols), 3));
    return geo;
  }, [scene.tree, byId]);

  /** Filenames as tiny billboarded canvas labels — only for leaves. */
  const labels = useDisposable(
    () =>
      scene.tree
        .filter((n) => n.depth > 0)
        .slice(0, 14)
        .map((n) => ({
          node: n,
          tex: makeTexture(180, 34, (ctx, w, h) => {
            ctx.clearRect(0, 0, w, h);
            ctx.font = '600 15px ui-monospace, "SF Mono", Menlo, monospace';
            ctx.textBaseline = "middle";
            ctx.fillStyle = n.heat > 0.1 ? "rgba(255,205,130,0.95)" : "rgba(178,208,232,0.72)";
            ctx.fillText(n.label.slice(0, 18), 2, h / 2);
          }),
        })),
    [scene.tree],
    (list) => list.forEach((l) => l.tex.dispose()),
  );

  return (
    <group name="module-tree">
      <lineSegments geometry={links} name="tree-links">
        <lineBasicMaterial vertexColors transparent opacity={0.78} toneMapped={false} />
      </lineSegments>
      <mesh geometry={spheres} name="tree-nodes">
        <meshStandardMaterial
          vertexColors
          roughness={0.3}
          metalness={0.1}
          emissive="#ffffff"
          emissiveIntensity={1}
          onBeforeCompile={(shader) => {
            shader.fragmentShader = shader.fragmentShader.replace(
              "#include <emissivemap_fragment>",
              `#include <emissivemap_fragment>
               totalEmissiveRadiance = diffuseColor.rgb * 0.9;`,
            );
          }}
        />
      </mesh>
      {labels.map(({ node, tex }) => (
        <TreeLabel key={node.id} pos={node.pos} tex={tex} />
      ))}
    </group>
  );
}

function TreeLabel({ pos, tex }: { pos: [number, number, number]; tex: Texture }) {
  return (
    <sprite position={[pos[0] + 0.17, pos[1] + 0.11, pos[2]]} scale={[0.62, 0.117, 1]}>
      <spriteMaterial map={tex} transparent depthWrite={false} toneMapped={false} opacity={0.95} />
    </sprite>
  );
}
