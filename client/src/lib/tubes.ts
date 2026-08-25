/**
 * Builds the whole streamline bundle as ONE indexed BufferGeometry.
 *
 * 150-odd separate TubeGeometry meshes would mean 150 draw calls and a
 * miserable GLB; generating the tube shells by hand lets us pack positions,
 * normals, per-vertex colour (from the transfer function) and two animation
 * attributes into a single mesh that both renders and exports in one piece.
 */
import { BufferAttribute, BufferGeometry, Vector3 } from "three";
import type { Streamline } from "@shared/protocol";
import { mapScalarLinear } from "./colormap";

const RADIAL = 6;

export interface TubeBuild {
  geometry: BufferGeometry;
  vertexCount: number;
  triangleCount: number;
}

/** Catmull-Rom resample of a flat xyz array, giving a smooth centreline. */
function resample(points: number[], mult: number): Float32Array {
  const n = points.length / 3;
  if (n < 2) return new Float32Array(points);
  const out = new Float32Array(((n - 1) * mult + 1) * 3);
  const at = (i: number, c: number) => points[Math.min(n - 1, Math.max(0, i)) * 3 + c];
  let w = 0;
  for (let i = 0; i < n - 1; i++) {
    for (let s = 0; s < mult; s++) {
      const t = s / mult;
      const t2 = t * t;
      const t3 = t2 * t;
      for (let c = 0; c < 3; c++) {
        const p0 = at(i - 1, c);
        const p1 = at(i, c);
        const p2 = at(i + 1, c);
        const p3 = at(i + 2, c);
        out[w++] =
          0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
      }
    }
  }
  out[w++] = at(n - 1, 0);
  out[w++] = at(n - 1, 1);
  out[w++] = at(n - 1, 2);
  return out;
}

/**
 * @param thickness global radius multiplier
 * @param smooth    sub-samples per input segment (1 = use points as given)
 */
export function buildTubes(
  lines: Streamline[],
  domain: [number, number],
  thickness = 1,
  smooth = 3,
  /** Per-line 0..1 edit heat, so the shader can cool it down over time. */
  heatOf?: (line: Streamline) => number,
): TubeBuild {
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  const aT: number[] = [];
  const aLine: number[] = [];
  const aHeat: number[] = [];
  const idx: number[] = [];

  const tangent = new Vector3();
  const normal = new Vector3();
  const binormal = new Vector3();
  const prevNormal = new Vector3();
  const p = new Vector3();
  const next = new Vector3();
  const vtx = new Vector3();
  const up = new Vector3(0, 1, 0);

  lines.forEach((line, lineIndex) => {
    const pts = resample(line.points, smooth);
    const count = pts.length / 3;
    if (count < 2) return;

    const baseVertex = pos.length / 3;
    const radius = 0.0125 * thickness * line.weight;
    const heat = heatOf?.(line) ?? 0;
    prevNormal.set(0, 1, 0);

    for (let i = 0; i < count; i++) {
      const t = i / (count - 1);
      p.set(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
      const j = Math.min(count - 1, i + 1);
      const k = Math.max(0, i - 1);
      next.set(pts[j * 3] - pts[k * 3], pts[j * 3 + 1] - pts[k * 3 + 1], pts[j * 3 + 2] - pts[k * 3 + 2]);
      tangent.copy(next).normalize();
      if (!Number.isFinite(tangent.x) || tangent.lengthSq() < 1e-8) tangent.set(1, 0, 0);

      // Parallel transport the frame so the tube does not twist wildly.
      normal.copy(prevNormal).sub(tangent.clone().multiplyScalar(prevNormal.dot(tangent)));
      if (normal.lengthSq() < 1e-6) normal.copy(up).cross(tangent);
      if (normal.lengthSq() < 1e-6) normal.set(0, 0, 1);
      normal.normalize();
      prevNormal.copy(normal);
      binormal.copy(tangent).cross(normal).normalize();

      // Scalars are supplied per input point; sample at this resampled t.
      const sIdx = t * (line.scalars.length - 1);
      const s0 = line.scalars[Math.floor(sIdx)] ?? 0;
      const s1 = line.scalars[Math.min(line.scalars.length - 1, Math.floor(sIdx) + 1)] ?? s0;
      const scalar = s0 + (s1 - s0) * (sIdx - Math.floor(sIdx));
      const [r, g, b] = mapScalarLinear(scalar, domain);

      // Taper the ends so lines fade in/out instead of showing flat caps.
      const taper = Math.min(1, Math.min(t, 1 - t) * 14 + 0.12);

      for (let a = 0; a < RADIAL; a++) {
        const ang = (a / RADIAL) * Math.PI * 2;
        const cx = Math.cos(ang);
        const sy = Math.sin(ang);
        vtx.set(
          normal.x * cx + binormal.x * sy,
          normal.y * cx + binormal.y * sy,
          normal.z * cx + binormal.z * sy,
        );
        nor.push(vtx.x, vtx.y, vtx.z);
        pos.push(p.x + vtx.x * radius * taper, p.y + vtx.y * radius * taper, p.z + vtx.z * radius * taper);
        col.push(r, g, b);
        aT.push(t);
        aLine.push(lineIndex);
        aHeat.push(heat);
      }
    }

    for (let i = 0; i < count - 1; i++) {
      for (let a = 0; a < RADIAL; a++) {
        const a1 = (a + 1) % RADIAL;
        const v00 = baseVertex + i * RADIAL + a;
        const v01 = baseVertex + i * RADIAL + a1;
        const v10 = baseVertex + (i + 1) * RADIAL + a;
        const v11 = baseVertex + (i + 1) * RADIAL + a1;
        idx.push(v00, v10, v11, v00, v11, v01);
      }
    }
  });

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
  geometry.setAttribute("normal", new BufferAttribute(new Float32Array(nor), 3));
  geometry.setAttribute("color", new BufferAttribute(new Float32Array(col), 3));
  geometry.setAttribute("aT", new BufferAttribute(new Float32Array(aT), 1));
  geometry.setAttribute("aLine", new BufferAttribute(new Float32Array(aLine), 1));
  geometry.setAttribute("aHeat", new BufferAttribute(new Float32Array(aHeat), 1));
  geometry.setIndex(idx);
  geometry.computeBoundingSphere();

  return { geometry, vertexCount: pos.length / 3, triangleCount: idx.length / 3 };
}
