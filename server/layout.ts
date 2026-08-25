/**
 * Turns the resolved code graph into 3D geometry.
 *
 * Every coordinate comes from the graph, not from decoration:
 *
 *   X  call depth — entry points on the left, leaves on the right
 *   Z  module lane — files grouped by directory, so a module reads as a band
 *   Y  position within the file, so a file's functions stack in source order
 *
 * Streamlines are real call paths through those positions. The braided look
 * comes from *hierarchical edge bundling*: intermediate points are pulled
 * toward their directory's trunk, so paths that travel through the same module
 * bundle together and paths that do not, do not. `bundle: 0` shows the raw
 * graph; the shape is always a property of the code.
 *
 * Positions are derived from stable ids, so re-analysing after a save leaves
 * untouched geometry pixel-identical and only the edited part moves.
 */
import type {
  CodeLine,
  FlowMark,
  CodePanel,
  ImportLink,
  SceneEdge,
  SceneGraph,
  SceneNode,
  Streamline,
  TreeNode,
} from "../shared/protocol";
import type { AnalysisResult, FileEntry } from "./analyzer";
import type { CodeGraph, GraphEdge } from "./parse/resolve";
import type { Definition } from "./parse/extract";
import { highlight, type RawLine } from "../shared/highlight";

// ---------------------------------------------------------------- tunables

export interface LayoutConfig {
  /** Jittered traces per call path. Higher = denser bundle. */
  tracesPerPath: number;
  /** Cap on distinct call paths turned into streamlines. */
  maxPaths: number;
  /** Samples along each streamline centreline. */
  samples: number;
  /** Code panels on screen at once. */
  maxPanels: number;
  /** Source lines a screen displays at once. */
  panelLines: number;
  /** Lines kept in the scroll buffer around the action. */
  panelBuffer: number;
  /** 0 = raw graph edges, 1 = fully bundled through module trunks. */
  bundle: number;
  /** Edit-heat half life, ms. */
  heatHalfLife: number;
  xStart: number;
  xEnd: number;
  /** Half-width of the module lane spread along Z. */
  laneSpread: number;
}

export const DEFAULT_LAYOUT: LayoutConfig = {
  tracesPerPath: 3,
  maxPaths: 56,
  samples: 44,
  maxPanels: 5,
  panelLines: 12,
  panelBuffer: 44,
  bundle: 0.38,
  heatHalfLife: 9_000,
  xStart: -10.5,
  xEnd: 6.4,
  laneSpread: 5.4,
};

/** Colour-bar domain, matching the legend. */
const DOMAIN: [number, number] = [-2, 8];

// ---------------------------------------------------------------- utilities

function hash32(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  return h >>> 0;
}

const rnd = (key: string, salt = 0) => hash32(key + "#" + salt) / 4294967296;
const rnd2 = (key: string, salt = 0) => rnd(key, salt) * 2 - 1;

function noise1(key: string, t: number, freq: number, salt = 0): number {
  const x = t * freq;
  const i = Math.floor(x);
  const f = x - i;
  const s = f * f * (3 - 2 * f);
  const a = rnd2(key, salt * 977 + i);
  const b = rnd2(key, salt * 977 + i + 1);
  return a + (b - a) * s;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const q3 = (v: number) => Math.round(v * 1000) / 1000;
const q2 = (v: number) => Math.round(v * 100) / 100;

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

// ---------------------------------------------------------------- positions

interface Placed {
  nodes: SceneNode[];
  byId: Map<string, SceneNode>;
  /** Nodes grouped by the file they live in, so a panel need not scan them all. */
  byFile: Map<string, SceneNode[]>;
  edges: SceneEdge[];
  outbound: Map<string, string[]>;
  /** Directory -> depth bucket -> trunk position, for edge bundling. */
  trunks: Map<string, Map<number, [number, number, number]>>;
  fileLane: Map<string, number>;
  maxDepth: number;
}

/** Recency of the file's last write, 1 = just now, decaying exponentially. */
function fileHeat(file: FileEntry | undefined, now: number, halfLife: number, def?: Definition): number {
  // A buffer being typed into is as hot as it gets, saved or not.
  if (file?.unsaved) return 1;
  if (!file || file.revisions <= 1) return 0;
  const age = now - file.changedAt;
  if (age > halfLife * 6) return 0;
  let h = Math.pow(0.5, age / halfLife);
  // A definition whose own lines changed runs hotter than its file neighbours.
  if (def && file.diff.touched.size) {
    let touched = false;
    for (const line of file.diff.touched) {
      if (line >= def.startLine && line <= def.endLine + 1) {
        touched = true;
        break;
      }
    }
    h *= touched ? 1 : 0.4;
  }
  return clamp(h, 0, 1);
}

/**
 * Map a node onto the colour-bar domain. Cool is the resting state; freshly
 * edited code drops to the warm end so edits read as heat moving through an
 * otherwise cold graph.
 */
function nodeScalar(dn: number, fanIn: number, fanOut: number, heat: number): number {
  const busy = Math.log2(1 + fanIn + fanOut) / 3.2;
  const cool = lerp(4.0, 7.9, clamp(0.28 + dn * 0.52 + busy * 0.38, 0, 1));
  return lerp(cool, -1.7, heat);
}

function place(analysis: AnalysisResult, now: number, cfg: LayoutConfig): Placed {
  const { graph } = analysis;
  const fanIn = new Map<string, number>();
  const fanOut = new Map<string, number>();
  const outbound = new Map<string, string[]>();
  const ids = new Set(graph.definitions.map((d) => d.id));

  for (const e of graph.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    fanOut.set(e.from, (fanOut.get(e.from) ?? 0) + 1);
    fanIn.set(e.to, (fanIn.get(e.to) ?? 0) + 1);
    const list = outbound.get(e.from);
    if (list) list.push(e.to);
    else outbound.set(e.from, [e.to]);
  }

  const maxDepth = Math.max(1, ...graph.depth.values());
  /**
   * Entry points as a set.
   *
   * This was `graph.entryPoints.includes(def.id)` inside the per-definition
   * map below. On a repository with a vendored dependency tree in it that is
   * 210k definitions against 96k entry points — a hundred billion string
   * comparisons, 110 seconds of a completely blocked event loop, and the
   * websocket "still working" message could not even leave the process. The
   * membership test is the same test; it just is not a linear scan.
   */
  const entryIds = new Set(graph.entryPoints);

  // ---- module lanes: files grouped by directory, directories ordered by name
  const filesInGraph = [...new Set(graph.definitions.map((d) => d.file))].sort((a, b) => {
    const da = dirOf(a);
    const db = dirOf(b);
    return da === db ? a.localeCompare(b) : da.localeCompare(db);
  });
  const fileLane = new Map<string, number>();
  filesInGraph.forEach((file, i) => {
    const t = filesInGraph.length === 1 ? 0.5 : i / (filesInGraph.length - 1);
    fileLane.set(file, (t - 0.5) * 2 * cfg.laneSpread);
  });

  // ---- within-file ordering, so a file's functions stack in source order
  const perFile = new Map<string, Definition[]>();
  for (const d of graph.definitions) {
    const list = perFile.get(d.file);
    if (list) list.push(d);
    else perFile.set(d.file, [d]);
  }
  const orderInFile = new Map<string, { index: number; total: number }>();
  for (const [, defs] of perFile) {
    const sorted = [...defs].sort((a, b) => a.startLine - b.startLine);
    sorted.forEach((d, i) => orderInFile.set(d.id, { index: i, total: sorted.length }));
  }

  const nodes: SceneNode[] = graph.definitions.map((def) => {
    const file = analysis.files.get(def.file);
    const heat = fileHeat(file, now, cfg.heatHalfLife, def);
    const depth = graph.depth.get(def.id) ?? Math.round(maxDepth * 0.5);
    const dn = clamp(depth / maxDepth, 0, 1);
    const fi = fanIn.get(def.id) ?? 0;
    const fo = fanOut.get(def.id) ?? 0;
    const order = orderInFile.get(def.id) ?? { index: 0, total: 1 };
    const lane = fileLane.get(def.file) ?? 0;

    // Y: source order within the file, with a little jitter so co-located
    // definitions at the same depth do not overlap exactly.
    const spread = order.total <= 1 ? 0.5 : order.index / (order.total - 1);
    const y = 0.28 + spread * 2.2 + rnd(def.id, 2) * 0.22;

    return {
      id: def.id,
      name: def.name,
      qualified: def.qualified,
      file: def.file,
      language: file?.language ?? "typescript",
      kind: def.kind,
      startLine: def.startLine,
      endLine: def.endLine,
      isEntry: entryIds.has(def.id),
      isExported: def.exported,
      isAsync: def.isAsync,
      container: def.container,
      fanIn: fi,
      fanOut: fo,
      depth,
      heat: q2(heat),
      scalar: q2(nodeScalar(dn, fi, fo, heat)),
      pos: [
        q3(lerp(cfg.xStart, cfg.xEnd, dn) + rnd2(def.id, 5) * 0.22),
        q3(clamp(y, 0.08, 3.4)),
        q3(lane + rnd2(def.id, 1) * 0.28),
      ],
    };
  });

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const byFile = new Map<string, SceneNode[]>();
  for (const n of nodes) {
    const list = byFile.get(n.file);
    if (list) list.push(n);
    else byFile.set(n.file, [n]);
  }

  const edges: SceneEdge[] = graph.edges
    .filter((e) => byId.has(e.from) && byId.has(e.to))
    .map((e) => ({
      from: e.from,
      to: e.to,
      line: e.line,
      kind: e.kind,
      confidence: e.confidence,
    }));

  // ---- module trunks: the anchor an edge is pulled toward when bundling
  const trunks = new Map<string, Map<number, [number, number, number]>>();
  const buckets = new Map<string, Map<number, [number, number, number, number]>>();
  for (const node of nodes) {
    const dir = dirOf(node.file) || ".";
    const bucket = Math.round((node.depth / Math.max(1, maxDepth)) * 8);
    let byBucket = buckets.get(dir);
    if (!byBucket) buckets.set(dir, (byBucket = new Map()));
    const acc = byBucket.get(bucket) ?? [0, 0, 0, 0];
    acc[0] += node.pos[0];
    acc[1] += node.pos[1];
    acc[2] += node.pos[2];
    acc[3] += 1;
    byBucket.set(bucket, acc);
  }
  for (const [dir, byBucket] of buckets) {
    const resolved = new Map<number, [number, number, number]>();
    for (const [bucket, [x, y, z, n]] of byBucket) {
      resolved.set(bucket, [x / n, y / n, z / n]);
    }
    trunks.set(dir, resolved);
  }

  return { nodes, byId, byFile, edges, outbound, trunks, fileLane, maxDepth };
}

// -------------------------------------------------------------- streamlines

/** Enumerate distinct root-to-leaf call paths through the real graph. */
function callPaths(placed: Placed, graph: CodeGraph, cfg: LayoutConfig): string[][] {
  const roots = new Set<string>(graph.entryPoints);
  if (!roots.size) {
    for (const n of [...placed.nodes].sort((a, b) => b.fanOut - a.fanOut).slice(0, 6)) roots.add(n.id);
  }

  const paths: string[][] = [];
  const MAX_LEN = 14;
  const walk = (id: string, trail: string[], seen: Set<string>) => {
    if (paths.length >= cfg.maxPaths * 5) return;
    const kids = (placed.outbound.get(id) ?? []).filter((k) => !seen.has(k));
    if (!kids.length || trail.length >= MAX_LEN) {
      if (trail.length >= 2) paths.push(trail);
      return;
    }
    for (const k of kids.slice(0, 5)) {
      seen.add(k);
      walk(k, [...trail, k], seen);
      seen.delete(k);
    }
  };
  for (const r of [...roots].sort()) walk(r, [r], new Set([r]));

  const heatOf = (path: string[]) =>
    path.reduce((m, id) => Math.max(m, placed.byId.get(id)?.heat ?? 0), 0);
  paths.sort((a, b) => heatOf(b) - heatOf(a) || b.length - a.length || a[0].localeCompare(b[0]));

  const seenKeys = new Set<string>();
  const unique: string[][] = [];
  for (const path of paths) {
    const key = path.join(">");
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    unique.push(path);
    if (unique.length >= cfg.maxPaths) break;
  }

  // A graph with few long chains still deserves its short edges drawn.
  if (unique.length < cfg.maxPaths) {
    for (const edge of placed.edges) {
      if (unique.length >= cfg.maxPaths) break;
      const key = `${edge.from}>${edge.to}`;
      if (seenKeys.has(key)) continue;
      const covered = unique.some((p) => {
        const i = p.indexOf(edge.from);
        return i >= 0 && p[i + 1] === edge.to;
      });
      if (covered) continue;
      seenKeys.add(key);
      unique.push([edge.from, edge.to]);
    }
  }
  return unique;
}

/**
 * Sample a path at t, blending the real node polyline toward the module trunk.
 * Endpoints are never moved — a streamline always starts and ends on the
 * definitions it actually connects.
 */
function samplePath(
  path: SceneNode[],
  t: number,
  placed: Placed,
  bundle: number,
): [number, number, number] {
  const u = t * (path.length - 1);
  const i = Math.min(path.length - 2, Math.floor(u));
  const f = path.length === 1 ? 0 : u - i;
  const a = path[i] ?? path[0];
  const b = path[Math.min(path.length - 1, i + 1)] ?? a;
  const s = f * f * (3 - 2 * f);

  const real: [number, number, number] = [
    lerp(a.pos[0], b.pos[0], s),
    lerp(a.pos[1], b.pos[1], s),
    lerp(a.pos[2], b.pos[2], s),
  ];
  if (bundle <= 0.001 || path.length < 3) return real;

  // Trunk of whichever module this stretch of the path is passing through.
  const dir = dirOf((s < 0.5 ? a : b).file) || ".";
  const depth = lerp(a.depth, b.depth, s);
  const bucket = Math.round((depth / Math.max(1, placed.maxDepth)) * 8);
  const trunk = placed.trunks.get(dir)?.get(bucket);
  if (!trunk) return real;

  // Pull hardest mid-path, not at all at the endpoints. Depth (X) is the one
  // axis that must survive bundling — it is what makes the graph readable as
  // a flow — so it is pulled far less than the two spatial axes.
  const grip = Math.sin(Math.PI * t) ** 1.5 * bundle;
  return [
    lerp(real[0], trunk[0], grip * 0.18),
    lerp(real[1], trunk[1], grip * 0.75),
    lerp(real[2], trunk[2], grip * 0.9),
  ];
}

function buildStreamlines(placed: Placed, graph: CodeGraph, cfg: LayoutConfig): Streamline[] {
  const paths = callPaths(placed, graph, cfg);
  const confidenceOf = new Map<string, GraphEdge["confidence"]>();
  for (const e of graph.edges) confidenceOf.set(`${e.from}>${e.to}`, e.confidence);

  const lines: Streamline[] = [];
  for (const ids of paths) {
    const nodes = ids.map((id) => placed.byId.get(id)).filter(Boolean) as SceneNode[];
    if (nodes.length < 2) continue;
    const key = ids.join(">");
    const heat = nodes.reduce((m, n) => Math.max(m, n.heat), 0);

    // A path is only as trustworthy as its weakest hop.
    let weakest: GraphEdge["confidence"] = "local";
    const rank: Record<string, number> = { import: 0, local: 1, member: 2, unique: 3, weak: 4 };
    for (let i = 0; i < ids.length - 1; i++) {
      const c = confidenceOf.get(`${ids[i]}>${ids[i + 1]}`) ?? "weak";
      if (rank[c] > rank[weakest]) weakest = c;
    }

    for (let k = 0; k < cfg.tracesPerPath; k++) {
      const seed = `${key}|${k}`;
      // Traces of one path differ only by a small offset, so the bundle's
      // thickness reads as how many calls travel that way.
      const jitterY = rnd2(seed, 11) * 0.06;
      const jitterZ = rnd2(seed, 12) * 0.09;
      const wobble = 0.03 + rnd(seed, 13) * 0.05;

      const points: number[] = [];
      const scalars: number[] = [];
      for (let s = 0; s < cfg.samples; s++) {
        const t = s / (cfg.samples - 1);
        const [x, y, z] = samplePath(nodes, t, placed, cfg.bundle);
        const taper = Math.sin(Math.PI * t);
        points.push(
          q3(x + noise1(seed, t, 2, 21) * wobble),
          q3(Math.max(0.05, y + jitterY * taper + noise1(seed, t, 2.5, 22) * wobble)),
          q3(z + jitterZ * taper + noise1(seed, t, 2.2, 23) * wobble),
        );

        const u = t * (nodes.length - 1);
        const i = Math.min(nodes.length - 2, Math.floor(u));
        const scalar = lerp(nodes[i].scalar, nodes[i + 1].scalar, u - i);
        scalars.push(q2(clamp(scalar + rnd2(seed, 16) * 0.35, DOMAIN[0], DOMAIN[1])));
      }

      lines.push({
        id: seed,
        nodeIds: ids,
        points,
        scalars,
        weight: q3(0.5 + Math.min(1, nodes.length / 8) * 0.55 + heat * 0.9 + rnd(seed, 30) * 0.2),
        flowId: ids[0],
        confidence: weakest,
      });
    }
  }
  return lines;
}

/** File-level import edges: the repository's actual dependency map. */
function buildImportLinks(placed: Placed, graph: CodeGraph): ImportLink[] {
  const centroid = new Map<string, [number, number, number, number]>();
  for (const n of placed.nodes) {
    const acc = centroid.get(n.file) ?? [0, 0, 0, 0];
    acc[0] += n.pos[0];
    acc[1] += n.pos[1];
    acc[2] += n.pos[2];
    acc[3] += 1;
    centroid.set(n.file, acc);
  }
  const at = (file: string): [number, number, number] | null => {
    const acc = centroid.get(file);
    return acc ? [acc[0] / acc[3], acc[1] / acc[3], acc[2] / acc[3]] : null;
  };

  const links: ImportLink[] = [];
  for (const edge of graph.imports) {
    const a = at(edge.from);
    const b = at(edge.to);
    if (!a || !b) continue;
    // A shallow arc, lifted so it reads above the call bundle.
    const points: number[] = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      const lift = Math.sin(Math.PI * t) * 1.15;
      points.push(
        q3(lerp(a[0], b[0], t)),
        q3(lerp(a[1], b[1], t) + lift),
        q3(lerp(a[2], b[2], t)),
      );
    }
    links.push({ from: edge.from, to: edge.to, weight: edge.weight, points });
  }
  return links;
}

// ------------------------------------------------------------- code panels

const PANEL_SLOTS: { pos: [number, number, number]; rotY: number; size: [number, number] }[] = [
  { pos: [-3.05, 2.3, -2.35], rotY: 0.34, size: [2.95, 2.12] },
  { pos: [-1.35, 1.95, -1.45], rotY: 0.34, size: [2.82, 2.02] },
  { pos: [0.3, 1.62, -0.55], rotY: 0.34, size: [2.72, 1.94] },
  { pos: [1.9, 1.3, 0.32], rotY: 0.34, size: [2.64, 1.88] },
  { pos: [2.45, 0.44, 1.2], rotY: 0.34, size: [2.1, 1.44] },
  { pos: [3.95, 0.92, 2.05], rotY: 0.34, size: [2.02, 1.38] },
];

/**
 * Per-file line marks: which lines open a definition that the traced flows
 * pass through, which lines contain a resolved call on those flows, and which
 * are simply inside such a definition. This is what lets the panel colour code
 * by what actually flows through it rather than by syntax alone.
 */
interface LineRoles {
  role: Map<number, FlowMark>;
  owner: Map<number, string>;
}

function computeLineRoles(
  placed: Placed,
  streamlines: Streamline[],
): Map<string, LineRoles> {
  const onFlow = new Set<string>();
  for (const line of streamlines) for (const id of line.nodeIds) onFlow.add(id);

  const byFile = new Map<string, LineRoles>();
  const rolesFor = (file: string): LineRoles => {
    let entry = byFile.get(file);
    if (!entry) byFile.set(file, (entry = { role: new Map(), owner: new Map() }));
    return entry;
  };

  for (const node of placed.nodes) {
    const roles = rolesFor(node.file);
    const flowing = onFlow.has(node.id);
    for (let line = node.startLine; line <= node.endLine; line++) {
      // Innermost definition wins ownership of the line.
      const current = roles.owner.get(line);
      if (current) {
        const other = placed.byId.get(current);
        if (other && other.endLine - other.startLine <= node.endLine - node.startLine) continue;
      }
      roles.owner.set(line, node.id);
      if (flowing && !roles.role.get(line)) roles.role.set(line, "body");
    }
    if (flowing) roles.role.set(node.startLine, "def");
  }

  // Call sites on a traced flow.
  for (const edge of placed.edges) {
    if (!onFlow.has(edge.from) || !onFlow.has(edge.to)) continue;
    const from = placed.byId.get(edge.from);
    if (!from) continue;
    rolesFor(from.file).role.set(edge.line, "call");
  }

  return byFile;
}

/**
 * The panels are a change log, not a sample of the repo: the N most recently
 * *changed* files, newest first, each opened on the hunk that changed. Before
 * anything has been edited they fall back to the graph's entry points, so the
 * first frame still shows the code the flow starts from.
 */
function buildPanels(
  analysis: AnalysisResult,
  placed: Placed,
  activeFile: string | null,
  now: number,
  cfg: LayoutConfig,
  roles: Map<string, LineRoles>,
  pinned: string[],
): CodePanel[] {
  const slots = Math.min(cfg.maxPanels, PANEL_SLOTS.length);
  const chosen: FileEntry[] = [];
  const taken = new Set<string>();

  // Pinned files hold their slot: you cannot edit a screen that keeps sliding
  // out from under you when something else changes.
  for (const file of pinned) {
    if (chosen.length >= slots) break;
    const entry = analysis.files.get(file);
    if (entry && !taken.has(file)) {
      chosen.push(entry);
      taken.add(file);
    }
  }

  for (const entry of analysis.recentlyChanged) {
    if (taken.has(entry.path)) continue;
    if (chosen.length >= slots) break;
    chosen.push(entry);
    taken.add(entry.path);
  }

  if (chosen.length < slots) {
    // Fall back to the files the entry points live in.
    const entryFiles = placed.nodes
      .filter((n) => n.isEntry)
      .sort((a, b) => b.fanOut - a.fanOut)
      .map((n) => n.file);
    const rest = [...new Set([...entryFiles, ...analysis.files.keys()])];
    for (const file of rest) {
      if (chosen.length >= slots) break;
      const entry = analysis.files.get(file);
      if (!entry || taken.has(file)) continue;
      chosen.push(entry);
      taken.add(file);
    }
  }

  return chosen.map((entry, i) => {
    const slot = PANEL_SLOTS[i];
    // While a buffer is dirty, the screen shows what the editor is holding
    // rather than what is on disk — that is the edit actually in progress.
    const live = entry.unsaved;
    const source = live?.content ?? entry.source;
    const diff = live?.diff ?? entry.diff;
    const totalLines = live?.lineCount ?? entry.lineCount;
    // Follow the *latest* change, the way a tail does — not the first one.
    const changes = diff.changes;
    const focusLine = changes.length
      ? changes[changes.length - 1].line
      : (diff.anchor ?? firstInterestingLine(entry, placed));
    const half = Math.floor(cfg.panelBuffer / 2);
    const from = Math.max(1, Math.min(focusLine - half, totalLines - cfg.panelBuffer + 1));
    const lines = highlight(source, entry.language, Math.max(1, from), cfg.panelBuffer);
    const fileRoles = roles.get(entry.path);
    return {
      id: entry.path,
      file: entry.path,
      language: entry.language,
      title: entry.path.split("/").pop() ?? entry.path,
      lines: markLines(lines, diff, cfg.panelBuffer, fileRoles),
      focusLine,
      rows: cfg.panelLines,
      totalLines,
      pos: slot.pos,
      rotY: slot.rotY,
      size: slot.size,
      heat: q2(live ? 1 : fileHeat(entry, now, cfg.heatHalfLife)),
      added: diff.added,
      removed: diff.removed,
      revisions: entry.revisions,
      changedAt: live?.at ?? (entry.revisions > 1 ? entry.changedAt : null),
      unsaved: Boolean(live),
      textOnly: entry.facts === null,
      firstLine: from,
      active: entry.path === activeFile,
    };
  });
}

/**
 * Attach change and flow marks, interleaving deleted lines into the window so
 * the panel shows the edit itself, not only its result.
 */
function markLines(
  lines: RawLine[],
  diff: FileEntry["diff"],
  budget: number,
  roles: LineRoles | undefined,
): CodeLine[] {
  const added = new Set<number>();
  const deletionsAt = new Map<number, string[]>();
  for (const change of diff.changes) {
    if (change.type === "add") added.add(change.line);
    else {
      const list = deletionsAt.get(change.line);
      if (list) list.push(change.text);
      else deletionsAt.set(change.line, [change.text]);
    }
  }

  const out: CodeLine[] = [];
  const cap = budget + 4;
  for (const line of lines) {
    for (const text of deletionsAt.get(line.n) ?? []) {
      if (out.length >= cap) break;
      out.push({ n: line.n, change: "del", flow: null, spans: [{ t: text.slice(0, 200), c: "plain" }] });
    }
    if (out.length >= cap) break;
    out.push({
      ...line,
      change: added.has(line.n) ? "add" : null,
      flow: roles?.role.get(line.n) ?? null,
      nodeId: roles?.owner.get(line.n),
    });
  }
  return out;
}

function firstInterestingLine(entry: FileEntry, placed: Placed): number {
  // Indexed by file: this used to scan every node in the graph, once per screen.
  const own = placed.byFile.get(entry.path) ?? [];
  const pick =
    own.find((n) => n.isEntry) ??
    own.find((n) => n.isExported) ??
    [...own].sort((a, b) => a.startLine - b.startLine)[0];
  return Math.max(1, pick?.startLine ?? 1);
}

// ------------------------------------------------------------- module tree

/** The directory tree, drawn as the small node-link diagram. */
function buildTree(analysis: AnalysisResult, now: number, cfg: LayoutConfig): TreeNode[] {
  interface T {
    name: string;
    children: Map<string, T>;
    isDir: boolean;
    path: string;
    changedAt: number;
  }
  const root: T = { name: ".", children: new Map(), isDir: true, path: "", changedAt: 0 };

  for (const entry of analysis.files.values()) {
    let cur = root;
    const parts = entry.path.split("/");
    parts.forEach((part, i) => {
      const isLast = i === parts.length - 1;
      const path = parts.slice(0, i + 1).join("/");
      let next = cur.children.get(part);
      if (!next) {
        next = { name: part, children: new Map(), isDir: !isLast, path, changedAt: 0 };
        cur.children.set(part, next);
      }
      if (entry.revisions > 1) next.changedAt = Math.max(next.changedAt, entry.changedAt);
      cur = next;
    });
  }

  const levels: T[][] = [];
  const parentOf = new Map<T, T | null>();
  const visit = (t: T, d: number) => {
    if (d > 3) return;
    (levels[d] ??= []).push(t);
    const kids = [...t.children.values()]
      .sort((x, y) => y.changedAt - x.changedAt || x.name.localeCompare(y.name))
      .slice(0, 7);
    for (const k of kids) {
      parentOf.set(k, t);
      visit(k, d + 1);
    }
  };
  parentOf.set(root, null);
  visit(root, 0);

  const ORIGIN: [number, number, number] = [-8.7, 3.95, -3.4];
  const SPAN_X = 4.3;
  const ROW_Y = -0.58;
  const out: TreeNode[] = [];
  levels.forEach((row, d) => {
    row.forEach((t, i) => {
      const frac = row.length === 1 ? 0.5 : i / (row.length - 1);
      out.push({
        id: t.path || ".",
        label: t.name,
        depth: d,
        isDir: t.isDir,
        parent: parentOf.get(t)?.path ?? (d === 0 ? null : "."),
        heat: t.changedAt ? q2(clamp(Math.pow(0.5, (now - t.changedAt) / cfg.heatHalfLife), 0, 1)) : 0,
        pos: [
          q3(ORIGIN[0] + (frac - 0.5) * SPAN_X * (d === 0 ? 0 : 1)),
          q3(ORIGIN[1] + d * ROW_Y),
          q3(ORIGIN[2] + rnd2(t.path || ".", 3) * 0.16 + d * 0.2),
        ],
      });
    });
  });
  return out;
}

// ----------------------------------------------------------------- reuse

/**
 * Everything a scene derives from the *graph* rather than from file content.
 *
 * Typing into a file changes its text, not its call graph — so on every
 * keystroke the streamlines, node placement, module trunks, import arcs and
 * line roles are all still exactly right. Recomputing them was ~30ms of the
 * ~33ms the server spent per keystroke. Holding them here and rebuilding only
 * the screens is what makes an unsaved edit feel immediate.
 *
 * The cache is invalidated by anything that could change that geometry: a
 * parse that altered the graph, a different set of files running hot (heat
 * feeds node colour), or a layout setting the user moved.
 */
export interface LayoutCache {
  key: string;
  /**
   * Which position revision the cached nodes carry. The geometry survives a
   * definition moving; the line stamps on the nodes do not, so they are
   * refreshed in place rather than throwing the whole layout away.
   */
  positionRevision: number;
  placed: Placed;
  streamlines: Streamline[];
  importLinks: ImportLink[];
  roles: Map<string, LineRoles>;
  tree: TreeNode[];
  nodes: SceneNode[];
  edges: SceneEdge[];
}

function cacheKey(analysis: AnalysisResult, cfg: LayoutConfig): string {
  // Which files are hot, not how hot — the continuous decay is animated on the
  // GPU, so it must not invalidate geometry on every cooldown tick.
  const hot: string[] = [];
  for (const f of analysis.files.values()) {
    if (f.unsaved) hot.push(f.path + "!");
    else if (f.revisions > 1) hot.push(f.path);
  }
  hot.sort();
  return [
    analysis.graphRevision,
    cfg.tracesPerPath,
    cfg.maxPaths,
    cfg.samples,
    cfg.bundle,
    cfg.laneSpread,
    cfg.heatHalfLife,
    hot.join(","),
  ].join("|");
}

// --------------------------------------------------------------- entry point

export function layout(
  analysis: AnalysisResult,
  opts: {
    root: string;
    projectName: string;
    activeFile: string | null;
    rev: number;
    cfg?: Partial<LayoutConfig>;
    now?: number;
    /** Files whose panels must keep their slot (open in the editor). */
    pinned?: string[];
    /** Previous graph-derived work, reused when the graph has not moved. */
    cache?: { current: LayoutCache | null };
    /** How live typing is being observed, for the viewer's diagnostics. */
    liveTyping?: { backupStores: number; unsavedSeen: number; pushedBuffers: number };
  },
): SceneGraph {
  const cfg = { ...DEFAULT_LAYOUT, ...opts.cfg };
  const now = opts.now ?? Date.now();
  const t0 = performance.now();
  const { graph } = analysis;

  const key = cacheKey(analysis, cfg);
  const reusable = opts.cache?.current?.key === key ? opts.cache.current : null;

  let placed: Placed;
  let streamlines: Streamline[];
  let importLinks: ImportLink[];
  let roles: Map<string, LineRoles>;
  let tree: TreeNode[];
  let sentNodes: SceneNode[];
  let sentEdges: SceneEdge[];

  if (reusable) {
    ({ placed, streamlines, importLinks, roles, tree, nodes: sentNodes, edges: sentEdges } = reusable);
    // The graph has the same shape, but definitions may have slid up or down
    // inside their files. Positions are derived from definition *order*, not
    // from absolute lines, so nothing has actually moved in space — only the
    // line ranges the viewer uses to colour a screen and to decide which
    // tethers are live. Refresh those and leave the geometry alone.
    if (reusable.positionRevision !== analysis.positionRevision) {
      const lines = new Map(graph.definitions.map((d) => [d.id, d]));
      const restamp = (n: SceneNode): SceneNode => {
        const def = lines.get(n.id);
        return !def || (def.startLine === n.startLine && def.endLine === n.endLine)
          ? n
          : { ...n, startLine: def.startLine, endLine: def.endLine };
      };
      sentNodes = sentNodes.map(restamp);
      const restamped = placed.nodes.map(restamp);
      // The per-file index points at node objects, so it has to follow the
      // restamp — otherwise a screen would open on a stale line number.
      const byFile = new Map<string, SceneNode[]>();
      for (const n of restamped) {
        const list = byFile.get(n.file);
        if (list) list.push(n);
        else byFile.set(n.file, [n]);
      }
      placed = { ...placed, nodes: restamped, byFile };
      // Line roles are keyed on those same ranges — which line of a screen
      // belongs to which definition, and whether it is on a live path. Leaving
      // them stale would colour the wrong lines.
      roles = computeLineRoles(placed, streamlines);
      reusable.positionRevision = analysis.positionRevision;
      reusable.nodes = sentNodes;
      reusable.placed = placed;
      reusable.roles = roles;
    }
  } else {
    placed = place(analysis, now, cfg);
    streamlines = buildStreamlines(placed, graph, cfg);
    importLinks = buildImportLinks(placed, graph);
    roles = computeLineRoles(placed, streamlines);
    tree = buildTree(analysis, now, cfg);

    // Trim what actually goes over the wire.
    //
    // The stats stay truthful about the whole graph, but the client only ever
    // touches nodes a streamline visits or that belong to a file on a screen —
    // glyphs, tethers and flat-mode line roles come from exactly those. On a
    // 2,700-file tree the untrimmed arrays were 11MB of a 13MB message,
    // re-sent on every save.
    const keep = new Set<string>();
    for (const line of streamlines) for (const id of line.nodeIds) keep.add(id);
    const panelHint = new Set(analysis.recentlyChanged.slice(0, 12).map((f) => f.path));
    for (const node of placed.nodes) if (panelHint.has(node.file)) keep.add(node.id);
    sentNodes = placed.nodes.filter((n) => keep.has(n.id));
    sentEdges = placed.edges.filter((e) => keep.has(e.from) && keep.has(e.to));

    if (opts.cache) {
      opts.cache.current = {
        key,
        positionRevision: analysis.positionRevision,
        placed,
        streamlines,
        importLinks,
        roles,
        tree,
        nodes: sentNodes,
        edges: sentEdges,
      };
    }
  }

  // Screens always rebuild: they are the file content, which is what moved.
  const panels = buildPanels(analysis, placed, opts.activeFile, now, cfg, roles, opts.pinned ?? []);

  const byConfidence: Record<string, number> = {};
  for (const e of graph.edges) byConfidence[e.confidence] = (byConfidence[e.confidence] ?? 0) + 1;

  const languages: Record<string, number> = {};
  for (const f of analysis.files.values()) languages[f.language] = (languages[f.language] ?? 0) + 1;

  return {
    rev: opts.rev,
    root: opts.root,
    projectName: opts.projectName,
    activeFile: opts.activeFile,
    nodes: sentNodes,
    edges: sentEdges,
    streamlines,
    importLinks,
    panels,
    tree,
    domain: DOMAIN,
    stats: {
      files: analysis.files.size,
      nodes: placed.nodes.length,
      edges: placed.edges.length,
      sentNodes: sentNodes.length,
      importEdges: graph.imports.length,
      externalDeps: graph.external.size,
      entryPoints: graph.entryPoints.length,
      streamlines: streamlines.length,
      unresolvedCalls: graph.unresolved,
      byConfidence,
      languages,
      backupStores: opts.liveTyping?.backupStores ?? 0,
      unsavedSeen: opts.liveTyping?.unsavedSeen ?? 0,
      pushedBuffers: opts.liveTyping?.pushedBuffers ?? 0,
      analyzeMs: Math.round(analysis.analyzeMs * 10) / 10,
      layoutMs: Math.round((performance.now() - t0) * 10) / 10,
      rev: opts.rev,
    },
  };
}
