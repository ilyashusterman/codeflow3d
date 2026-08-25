/**
 * Turns per-file facts into a real graph.
 *
 * Module specifiers are resolved to actual files in the repo (Node-style
 * relative/index resolution, Python dotted packages, Rust `mod`/`crate`
 * paths, Go package directories). Call sites are then resolved against the
 * bindings actually in scope in that file — a local definition, or a name the
 * file explicitly imported — before any repo-wide guessing is allowed.
 *
 * Every edge carries how it was resolved, so the viewer can show which
 * connections are import-backed fact and which are name-match inference.
 */
import type { FileFacts, Definition, CallSite } from "./extract";
import type { LangId, ModuleStyle } from "./languages";
import { LANGUAGES } from "./languages";

export type EdgeConfidence =
  /** Callee is defined in the same file. */
  | "local"
  /** Callee arrived through an explicit import of that name. */
  | "import"
  /** Method call on a value that came from the target file. */
  | "member"
  /** Name is unique across the repo; no import backs it. */
  | "unique"
  /** Ambiguous name, best guess by proximity. */
  | "weak";

export interface GraphEdge {
  from: string;
  to: string;
  line: number;
  kind: CallSite["kind"];
  confidence: EdgeConfidence;
}

export interface ImportEdge {
  from: string;
  to: string;
  /** How many bound names travel this edge. */
  weight: number;
}

export interface CodeGraph {
  definitions: Definition[];
  byId: Map<string, Definition>;
  edges: GraphEdge[];
  /** File-level import graph — observed, not inferred. */
  imports: ImportEdge[];
  /** Specifiers that left the repo (packages, stdlib), by specifier. */
  external: Map<string, number>;
  entryPoints: string[];
  /** Longest distance from any entry point. */
  depth: Map<string, number>;
  unresolved: number;
}

const NODE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const NODE_EXT_RE = /\.[cm]?[jt]sx?$/;

/** Strip a source extension so `./auth.js` can match `auth.ts`. */
function withoutExt(path: string): string {
  const m = NODE_EXT_RE.exec(path);
  return m ? path.slice(0, -m[0].length) : path;
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

function normalizeJoin(base: string, rel: string): string {
  const parts = (base ? base.split("/") : []).concat(rel.split("/"));
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/**
 * Resolve one module specifier to a repo file.
 * @returns the repo-relative file path, or null if it leaves the repo.
 */
function resolveModule(
  specifier: string,
  fromFile: string,
  style: ModuleStyle,
  files: Set<string>,
  roots: string[],
): string | null {
  const firstExisting = (candidates: string[]): string | null => {
    for (const c of candidates) if (files.has(c)) return c;
    return null;
  };

  if (style === "node") {
    if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
      // Bare specifier: a package, unless the repo uses a path alias that
      // happens to name a real directory (e.g. "shared/protocol").
      const direct = firstExisting([
        ...NODE_EXTS.map((e) => specifier + e),
        ...NODE_EXTS.map((e) => specifier + "/index" + e),
      ]);
      if (direct) return direct;
      const aliased = specifier.replace(/^@?[~]?\//, "").replace(/^@([\w-]+)\//, "$1/");
      if (aliased !== specifier) {
        return firstExisting([
          ...NODE_EXTS.map((e) => aliased + e),
          ...NODE_EXTS.map((e) => aliased + "/index" + e),
        ]);
      }
      return null;
    }
    const joined = normalizeJoin(dirOf(fromFile), specifier);
    const bare = withoutExt(joined);
    return firstExisting([
      joined,
      ...NODE_EXTS.map((e) => bare + e),
      ...NODE_EXTS.map((e) => bare + "/index" + e),
    ]);
  }

  if (style === "python") {
    // Leading dots are relative package levels.
    const dots = /^\.+/.exec(specifier)?.[0].length ?? 0;
    const rest = specifier.slice(dots).replace(/\./g, "/");
    let base = dirOf(fromFile);
    for (let i = 1; i < dots; i++) base = dirOf(base);
    const candidates: string[] = [];
    if (dots > 0) {
      const joined = rest ? normalizeJoin(base, rest) : base;
      candidates.push(joined + ".py", joined + "/__init__.py");
    } else {
      for (const root of roots) {
        const joined = normalizeJoin(root, rest);
        candidates.push(joined + ".py", joined + "/__init__.py");
      }
      // Also try as a sibling, which is how flat scripts import each other.
      const sibling = normalizeJoin(dirOf(fromFile), rest);
      candidates.push(sibling + ".py", sibling + "/__init__.py");
    }
    return firstExisting(candidates);
  }

  if (style === "rust") {
    const segments = specifier.split("::").filter((s) => s && s !== "self");
    if (!segments.length) return null;
    const crateRooted = segments[0] === "crate" || segments[0] === "super";
    const path = segments.filter((s) => s !== "crate" && s !== "super").join("/");
    if (!path) return null;
    const here = dirOf(fromFile);
    // A `mod x;` inside foo.rs looks for foo/x.rs as well as ./x.rs.
    const selfModuleDir = withoutExt(fromFile);
    const candidates = [
      normalizeJoin(here, path) + ".rs",
      normalizeJoin(here, path) + "/mod.rs",
      normalizeJoin(selfModuleDir, path) + ".rs",
      normalizeJoin(selfModuleDir, path) + "/mod.rs",
    ];
    if (crateRooted) {
      for (const root of roots) {
        candidates.push(normalizeJoin(root, path) + ".rs", normalizeJoin(root, path) + "/mod.rs");
      }
    }
    const found = firstExisting(candidates);
    if (found) return found;
    // Last resort: any file whose stem matches the final path segment.
    const leaf = segments[segments.length - 1];
    for (const f of files) {
      if (f === leaf + ".rs" || f.endsWith("/" + leaf + ".rs")) return f;
    }
    return null;
  }

  // Go: imports name a package directory; map to any file in it.
  const tail = specifier.split("/").slice(1).join("/");
  for (const candidate of [specifier, tail]) {
    if (!candidate) continue;
    for (const f of files) {
      if (!f.endsWith(".go")) continue;
      if (f.startsWith(candidate + "/") || dirOf(f).endsWith(candidate)) return f;
    }
  }
  return null;
}

/** Common source roots, so package-absolute specifiers can be resolved. */
function detectRoots(files: Set<string>): string[] {
  const roots = new Set<string>([""]);
  const known = ["src", "lib", "app", "server", "client", "packages", "crates"];
  for (const f of files) {
    const first = f.split("/")[0];
    if (known.includes(first)) roots.add(first);
  }
  return [...roots];
}

export function buildGraph(facts: FileFacts[]): CodeGraph {
  const files = new Set(facts.map((f) => f.file));
  const roots = detectRoots(files);
  const byFile = new Map(facts.map((f) => [f.file, f]));

  const definitions = facts.flatMap((f) => f.definitions);
  const byId = new Map(definitions.map((d) => [d.id, d]));

  // Repo-wide name index, for the inference tiers only.
  const byName = new Map<string, Definition[]>();
  for (const d of definitions) {
    const list = byName.get(d.name);
    if (list) list.push(d);
    else byName.set(d.name, [d]);
  }

  // ---- module resolution: what each file actually has in scope
  interface Bound {
    file: string;
    imported: string;
    namespace: boolean;
  }
  const scopes = new Map<string, Map<string, Bound>>();
  const importEdges = new Map<string, ImportEdge>();
  const external = new Map<string, number>();

  for (const file of facts) {
    const style = LANGUAGES[file.language].style;
    const scope = new Map<string, Bound>();
    scopes.set(file.file, scope);

    for (const record of file.imports) {
      const target = resolveModule(record.source, file.file, style, files, roots);
      if (!target || target === file.file) {
        if (!target) external.set(record.source, (external.get(record.source) ?? 0) + 1);
        continue;
      }
      for (const binding of record.bindings) {
        scope.set(binding.local, {
          file: target,
          imported: binding.imported,
          namespace: binding.namespace,
        });
      }
      const key = file.file + " " + target;
      const existing = importEdges.get(key);
      const weight = Math.max(1, record.bindings.length);
      if (existing) existing.weight += weight;
      else importEdges.set(key, { from: file.file, to: target, weight });
    }
  }

  // ---- call resolution
  const edges: GraphEdge[] = [];
  const edgeKeys = new Set<string>();
  let unresolved = 0;

  const pushEdge = (from: string, to: string, call: CallSite, confidence: EdgeConfidence) => {
    if (from === to) return;
    const key = from + " " + to + " " + call.kind;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ from, to, line: call.line, kind: call.kind, confidence });
  };

  for (const file of facts) {
    const scope = scopes.get(file.file)!;

    // Innermost definition containing a byte offset.
    const sorted = [...file.definitions].sort(
      (a, b) => a.startByte - b.startByte || b.endByte - a.endByte,
    );
    const enclosing = (byte: number): Definition | null => {
      let best: Definition | null = null;
      for (const d of sorted) {
        if (d.startByte > byte) break;
        if (byte < d.endByte && (!best || d.startByte >= best.startByte)) best = d;
      }
      return best;
    };

    const localByName = new Map<string, Definition[]>();
    for (const d of file.definitions) {
      const list = localByName.get(d.name);
      if (list) list.push(d);
      else localByName.set(d.name, [d]);
    }

    for (const call of file.calls) {
      const caller = enclosing(call.byte);
      // A call at file scope is not an edge between definitions.
      if (!caller) continue;

      // 1. Defined in this same file.
      const local = localByName.get(call.callee)?.find((d) => d.id !== caller.id);
      if (local) {
        pushEdge(caller.id, local.id, call, "local");
        continue;
      }

      // 2. A name this file explicitly imported.
      const bound = scope.get(call.callee);
      if (bound) {
        const target = byFile.get(bound.file);
        const wanted =
          bound.imported === "default" || bound.imported === "*" ? call.callee : bound.imported;
        const hit =
          target?.exports.get(wanted) ??
          target?.definitions.find((d) => d.name === wanted) ??
          (bound.imported === "default" ? target?.defaultExport ?? undefined : undefined);
        if (hit) {
          pushEdge(caller.id, hit.id, call, "import");
          continue;
        }
      }

      // 3. Member call whose receiver came from an import
      //    (`store.query()` where `store` is an imported module or class).
      if (call.receiver) {
        const receiverRoot = /^[A-Za-z_$][\w$]*/.exec(call.receiver)?.[0];
        const viaReceiver = receiverRoot ? scope.get(receiverRoot) : undefined;
        if (viaReceiver) {
          const target = byFile.get(viaReceiver.file);
          const hit =
            target?.definitions.find((d) => d.name === call.callee) ??
            target?.definitions.find(
              (d) =>
                d.qualified.endsWith("." + call.callee) ||
                d.qualified.endsWith("::" + call.callee),
            );
          if (hit) {
            pushEdge(caller.id, hit.id, call, "member");
            continue;
          }
        }
        // A method on a class defined in this file.
        const localMethod = file.definitions.find((d) => d.container && d.name === call.callee);
        if (localMethod) {
          pushEdge(caller.id, localMethod.id, call, "local");
          continue;
        }
      }

      // 4. Inference tiers, labelled as such.
      const candidates = (byName.get(call.callee) ?? []).filter((d) => d.id !== caller.id);
      if (candidates.length === 1) {
        pushEdge(caller.id, candidates[0].id, call, "unique");
        continue;
      }
      if (candidates.length > 1) {
        const importedFiles = new Set([...scope.values()].map((v) => v.file));
        const preferred =
          candidates.find((d) => importedFiles.has(d.file)) ??
          candidates.find((d) => d.exported) ??
          candidates[0];
        pushEdge(caller.id, preferred.id, call, "weak");
        continue;
      }
      unresolved++;
    }
  }

  // ---- entry points and depth
  const inbound = new Map<string, number>();
  const outbound = new Map<string, string[]>();
  for (const e of edges) {
    inbound.set(e.to, (inbound.get(e.to) ?? 0) + 1);
    const list = outbound.get(e.from);
    if (list) list.push(e.to);
    else outbound.set(e.from, [e.to]);
  }

  const entryPoints = definitions
    .filter((d) => (inbound.get(d.id) ?? 0) === 0 && (outbound.get(d.id)?.length ?? 0) > 0)
    .map((d) => d.id);

  const depth = new Map<string, number>();
  let frontier = [...entryPoints];
  for (const id of frontier) depth.set(id, 0);
  for (let level = 0; frontier.length && level < 64; level++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const to of outbound.get(id) ?? []) {
        if ((depth.get(to) ?? -1) < level + 1) {
          depth.set(to, level + 1);
          next.push(to);
        }
      }
    }
    frontier = next;
  }

  return {
    definitions,
    byId,
    edges,
    imports: [...importEdges.values()],
    external,
    entryPoints,
    depth,
    unresolved,
  };
}

export type { LangId };
