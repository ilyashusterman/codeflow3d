/**
 * Merges many small spheres into one non-indexed BufferGeometry.
 *
 * IcosahedronGeometry is non-indexed (it comes from PolyhedronGeometry), so the
 * merge copies triangles directly rather than remapping an index buffer. One
 * geometry means one draw call and one clean mesh in the GLB export.
 */
import { BufferAttribute, BufferGeometry, Color, IcosahedronGeometry } from "three";

export interface SphereSpec {
  pos: readonly [number, number, number];
  radius: number;
  color: Color;
}

export function mergeSpheres(specs: SphereSpec[], detail = 1): BufferGeometry {
  const proto = new IcosahedronGeometry(1, detail);
  const pPos = proto.getAttribute("position");
  const pNor = proto.getAttribute("normal");
  const per = pPos.count;

  const total = per * specs.length;
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const color = new Float32Array(total * 3);

  specs.forEach((spec, i) => {
    const base = i * per;
    for (let v = 0; v < per; v++) {
      const o = (base + v) * 3;
      position[o] = spec.pos[0] + pPos.getX(v) * spec.radius;
      position[o + 1] = spec.pos[1] + pPos.getY(v) * spec.radius;
      position[o + 2] = spec.pos[2] + pPos.getZ(v) * spec.radius;
      normal[o] = pNor.getX(v);
      normal[o + 1] = pNor.getY(v);
      normal[o + 2] = pNor.getZ(v);
      color[o] = spec.color.r;
      color[o + 1] = spec.color.g;
      color[o + 2] = spec.color.b;
    }
  });
  proto.dispose();

  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(position, 3));
  geo.setAttribute("normal", new BufferAttribute(normal, 3));
  geo.setAttribute("color", new BufferAttribute(color, 3));
  geo.computeBoundingSphere();
  return geo;
}
