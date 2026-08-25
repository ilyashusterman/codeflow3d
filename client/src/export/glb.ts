/**
 * GLB export.
 *
 * Everything visual lives under one group (`export-root`), which GLTFExporter
 * walks. Three things have to be reconciled first:
 *
 *  1. The on-screen look comes from `onBeforeCompile` shader injection, which
 *     glTF cannot express. The exported asset gets unlit materials instead
 *     (KHR_materials_unlit), which is exactly what the injected shader
 *     approximates — flat, saturated, transfer-function colour.
 *  2. The environment (a 60-unit floor and grid) would dominate the model's
 *     bounding box and make viewers frame the data as a speck. It is excluded.
 *  3. The animation attributes (`aT`, `aLine`) mean nothing in a static asset,
 *     so they are stripped rather than shipped.
 */
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import {
  type BufferAttribute,
  type BufferGeometry,
  type Group,
  type InterleavedBufferAttribute,
  type Material,
  type Object3D,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Points,
  type Scene,
  ShaderMaterial,
  Sprite,
} from "three";
import { apiUrl } from "../net/api";

/**
 * The live three.js scene, published by <ExportBridge/> inside the Canvas.
 *
 * We look the export subtree up by name at export time rather than holding a
 * ref to it: refs on three objects are attached by R3F's own reconciler, and
 * depending on commit order a stale detach can leave the holder empty while
 * the object is very much on screen. A name lookup against the live scene
 * cannot get out of sync.
 */
export const liveScene: { current: Scene | null } = { current: null };

export const EXPORT_ROOT_NAME = "export-root";

function resolveRoot(): Group {
  const scene = liveScene.current;
  if (!scene) throw new Error("scene not ready");
  const root = scene.getObjectByName(EXPORT_ROOT_NAME);
  if (!root) throw new Error("export root missing from scene");
  return root as Group;
}

/** Attributes that only drive the live shader. */
const RUNTIME_ATTRIBUTES = ["aT", "aLine", "aHeat"] as const;

interface Restore {
  materials: { object: Mesh; original: Material | Material[] }[];
  hidden: Object3D[];
  attributes: {
    geometry: BufferGeometry;
    name: string;
    attribute: BufferAttribute | InterleavedBufferAttribute;
  }[];
  substitutes: Material[];
}

function isExcluded(obj: Object3D): boolean {
  for (let o: Object3D | null = obj; o; o = o.parent) {
    if (o.userData?.excludeFromExport) return true;
  }
  return false;
}

function prepare(root: Object3D): Restore {
  const state: Restore = { materials: [], hidden: [], attributes: [], substitutes: [] };

  root.traverse((obj) => {
    // Screen-space effects and the environment do not belong in the asset.
    if (obj instanceof Points || obj instanceof Sprite || isExcluded(obj)) {
      if (obj.visible) {
        obj.visible = false;
        state.hidden.push(obj);
      }
      return;
    }
    if (!(obj instanceof Mesh)) return;

    for (const name of RUNTIME_ATTRIBUTES) {
      const attribute = obj.geometry.getAttribute(name);
      if (attribute) {
        state.attributes.push({ geometry: obj.geometry, name, attribute });
        obj.geometry.deleteAttribute(name);
      }
    }

    const material = obj.material as Material | Material[];
    const first = Array.isArray(material) ? material[0] : material;

    // Standard materials whose colour is carried by the injected shader would
    // export as solid white emissive; a raw ShaderMaterial cannot export at
    // all. Both become unlit vertex-coloured materials.
    const needsSubstitute =
      first instanceof ShaderMaterial ||
      (first instanceof MeshStandardMaterial && first.vertexColors);
    if (!needsSubstitute) return;

    const substitute = new MeshBasicMaterial({
      vertexColors: true,
      transparent: first.transparent,
      opacity: first.opacity,
      side: first.side,
      depthWrite: first.depthWrite,
    });
    state.materials.push({ object: obj, original: material });
    state.substitutes.push(substitute);
    obj.material = substitute;
  });

  return state;
}

function restore(state: Restore) {
  for (const { object, original } of state.materials) object.material = original as never;
  for (const m of state.substitutes) m.dispose();
  for (const { geometry, name, attribute } of state.attributes) geometry.setAttribute(name, attribute);
  for (const o of state.hidden) o.visible = true;
}

export interface ExportResult {
  bytes: ArrayBuffer;
  url?: string;
  name?: string;
}

/** Serialize the current scene to a GLB ArrayBuffer. */
export async function exportGlb(): Promise<ArrayBuffer> {
  const root = resolveRoot();
  const state = prepare(root);
  try {
    const exporter = new GLTFExporter();
    return await new Promise<ArrayBuffer>((resolve, reject) => {
      exporter.parse(
        root,
        (result) => {
          if (result instanceof ArrayBuffer) resolve(result);
          else reject(new Error("expected binary glTF"));
        },
        (err) => reject(err instanceof Error ? err : new Error(String(err))),
        { binary: true, onlyVisible: true, includeCustomExtensions: false },
      );
    });
  } finally {
    restore(state);
  }
}

/** Export, POST to the server for persistence, and hand back the public URL. */
export async function exportAndSave(): Promise<ExportResult> {
  const bytes = await exportGlb();
  const res = await fetch(apiUrl("/api/glb"), {
    method: "POST",
    headers: { "content-type": "model/gltf-binary" },
    body: bytes,
  });
  if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  const body = (await res.json()) as { url: string; name: string };
  return { bytes, url: apiUrl(body.url), name: body.name };
}

/** Trigger a local download of the same GLB. */
export function download(bytes: ArrayBuffer, name = "codeflow3d.glb") {
  const url = URL.createObjectURL(new Blob([bytes], { type: "model/gltf-binary" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
