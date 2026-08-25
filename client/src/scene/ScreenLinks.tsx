/**
 * The tethers between a screen and its code.
 *
 * Without these the screens float beside the graph with nothing tying them to
 * it, and you cannot tell which part of the bundle a file you are watching
 * actually is. Each screen sends a line to every definition that lives in that
 * file, and the two kinds are deliberately separated:
 *
 *   - definitions the last write touched leave the screen's **left** edge and
 *     run warm — this is the part being edited,
 *   - everything else leaves the **right** edge and runs cool — the code in
 *     that file the edit did not touch.
 *
 * So a glance at one screen tells you how much of its file is in play, and
 * where in the graph that work is landing.
 */
import { useMemo } from "react";
import { AdditiveBlending, BufferAttribute, BufferGeometry, Color } from "three";
import type { SceneGraph } from "@shared/protocol";
import { useDisposed } from "../lib/useDisposable";
import { useStore } from "../state/store";

const EDITED = new Color("#ff9d3c");
const UNTOUCHED = new Color("#3f6f96");

/** Cap per screen, so a 200-definition file does not become a hairball. */
const MAX_PER_SIDE = 26;
const SEGMENTS = 12;

export function ScreenLinks({ scene }: { scene: SceneGraph }) {
  const panelPos = useStore((s) => s.panelPos);
  const screenScale = useStore((s) => s.view.screenScale);

  /** Definitions per file, so each screen can find its own. */
  const byFile = useMemo(() => {
    const map = new Map<string, SceneGraph["nodes"]>();
    for (const node of scene.nodes) {
      const list = map.get(node.file);
      if (list) list.push(node);
      else map.set(node.file, [node]);
    }
    return map;
  }, [scene.nodes]);

  const geometry = useDisposed(() => {
    const positions: number[] = [];
    const colors: number[] = [];
    const colour = new Color();

    for (const panel of scene.panels) {
      const nodes = byFile.get(panel.file);
      if (!nodes?.length) continue;

      const origin = panelPos[panel.file] ?? panel.pos;
      const halfWidth = (panel.size[0] * screenScale) / 2;
      const cos = Math.cos(panel.rotY);
      const sin = Math.sin(panel.rotY);

      // Which lines were touched by the last write, from the panel's own marks.
      const touched = new Set<number>();
      for (const line of panel.lines) {
        if (line.change === "add" && line.nodeId) touched.add(line.n);
      }
      const isEdited = (node: SceneGraph["nodes"][number]) => {
        if (node.heat > 0.05) return true;
        for (const n of touched) if (n >= node.startLine && n <= node.endLine) return true;
        return false;
      };

      const edited = nodes.filter(isEdited).slice(0, MAX_PER_SIDE);
      const rest = nodes.filter((n) => !isEdited(n)).slice(0, MAX_PER_SIDE);

      for (const [side, group] of [
        [-1, edited],
        [1, rest],
      ] as const) {
        // Anchor on the screen's own edge, in its rotated frame.
        const ax = origin[0] + side * halfWidth * cos;
        const az = origin[2] - side * halfWidth * sin;
        const ay = origin[1];

        for (const node of group) {
          const warm = side === -1;
          colour.copy(warm ? EDITED : UNTOUCHED);
          const strength = warm ? 0.55 + node.heat * 0.45 : 0.3;

          for (let i = 0; i < SEGMENTS; i++) {
            const t0 = i / SEGMENTS;
            const t1 = (i + 1) / SEGMENTS;
            for (const t of [t0, t1]) {
              // A shallow sag, so the tether reads as a hanging line rather
              // than a hard spoke through the middle of the scene.
              const sag = Math.sin(Math.PI * t) * 0.42;
              positions.push(
                ax + (node.pos[0] - ax) * t,
                ay + (node.pos[1] - ay) * t - sag,
                az + (node.pos[2] - az) * t,
              );
              // Fade toward the graph end so the screens stay the anchor.
              const fade = (1 - t * 0.75) * strength;
              colors.push(colour.r * fade, colour.g * fade, colour.b * fade);
            }
          }
        }
      }
    }

    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
    geo.setAttribute("color", new BufferAttribute(new Float32Array(colors), 3));
    geo.computeBoundingSphere();
    return geo;
  }, [scene.panels, byFile, panelPos, screenScale]);

  if (!scene.panels.length) return null;

  return (
    <lineSegments geometry={geometry} name="screen-links" frustumCulled={false}>
      <lineBasicMaterial
        vertexColors
        transparent
        opacity={0.62}
        depthWrite={false}
        blending={AdditiveBlending}
        toneMapped={false}
      />
    </lineSegments>
  );
}
