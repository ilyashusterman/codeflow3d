/**
 * Incremental whole-repo code graph.
 *
 * Each file is parsed once with tree-sitter and its facts cached; a save
 * re-parses exactly that file and the graph is reassembled from the cache.
 * Assembly is pure CPU over in-memory facts, so a keystroke-level save costs a
 * parse (~1-3ms) rather than a rescan.
 */
import { readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { extract, warmup, type FileFacts } from "./parse/extract";
import { buildGraph, type CodeGraph } from "./parse/resolve";
import { specForPath, textLanguageOf, SOURCE_EXTENSIONS, type LangId } from "./parse/languages";
import { diffLines, type FileDiff } from "./diff";

const WASM_DIR = new URL("../wasm/", import.meta.url).pathname;
export const SOURCE_EXTS = SOURCE_EXTENSIONS;

export function languageOf(path: string): string | null {
  return specForPath(path)?.id ?? textLanguageOf(path);
}

/** Every file worth tracking: parsed source, plus text we only diff. */
export function isTracked(path: string): boolean {
  return Boolean(specForPath(path) ?? textLanguageOf(path));
}

export function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

export interface FileEntry {
  path: string;
  /** Tree-sitter language, or a display-only label for files we do not parse. */
  language: string;
  /** Null for text files that are tracked and diffed but not parsed. */
  facts: FileFacts | null;
  /** Current source, so panels render real lines without re-reading. */
  source: string;
  lineCount: number;
  bytes: number;
  /** Epoch ms of the last observed write. */
  mtime: number;
  /** Epoch ms when this process last saw the content change. */
  changedAt: number;
  /**
   * True when this file appeared *while we were watching* rather than during
   * the initial scan. Creating a file is one of the most notable things you can
   * do to a repository, but a new file has only one revision, so without this
   * it was indistinguishable from a file that had simply always been there —
   * and it never earned a screen.
   */
  born: boolean;
  /** What changed on that write. */
  diff: FileDiff;
  /** How many times this file has changed since the repo was opened. */
  revisions: number;
  /**
   * Content an editor is holding but has not written yet, and the diff from
   * what is on disk. Present only while a buffer is genuinely dirty.
   */
  unsaved: { content: string; at: number; diff: FileDiff; lineCount: number } | null;
}

export interface AnalysisResult {
  graph: CodeGraph;
  /** Identity of the parsed graph; unchanged by unsaved edits. */
  graphRevision: number;
  /** Bumped when definitions move within their files but the graph is unchanged. */
  positionRevision: number;
  files: Map<string, FileEntry>;
  /** Files whose content changed, most recent first. */
  recentlyChanged: FileEntry[];
  analyzeMs: number;
}

/** Files this large are indexed but not parsed — they are generated, not written. */
const MAX_SOURCE_BYTES = 800_000;

function fnv(parts: string[]): string {
  const json = parts.join("\u0002");
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < json.length; i++) hash = Math.imul(hash ^ json.charCodeAt(i), 16777619);
  return `${json.length.toString(36)}:${(hash >>> 0).toString(36)}`;
}

/**
 * A fingerprint of a file's *graph structure* — what calls what, what imports
 * what — with every line number deliberately left out.
 *
 * The distinction earns its keep. Node placement and streamline geometry are
 * derived from structure alone: depth from the entry points, fan-in, fan-out.
 * Inserting a blank line at the top of a file moves every definition below it
 * without changing any of that, so invalidating the layout would re-send a
 * quarter of a megabyte of geometry that is pixel-identical. Streamlines are
 * 62% of a scene message; this is the difference between a save costing 380KB
 * and costing 20KB.
 */
function structureDigest(facts: FileFacts | null): string {
  if (!facts) return "";
  const parts: string[] = [facts.language];
  for (const d of facts.definitions)
    parts.push(`d${d.id}\u0001${d.kind}\u0001${d.exported ? 1 : 0}\u0001${d.isAsync ? 1 : 0}`);
  for (const i of facts.imports)
    parts.push(
      `i${i.source}\u0001${i.isModuleDecl ? 1 : 0}\u0001` +
        i.bindings.map((b) => `${b.local}=${b.imported}`).join(","),
    );
  for (const c of facts.calls) parts.push(`c${c.callee}\u0001${c.kind}\u0001${c.receiver ?? ""}`);
  parts.push(`x${[...facts.exports.keys()].join(",")}`, `f${facts.defaultExport?.name ?? ""}`);
  return fnv(parts);
}

/**
 * A fingerprint of where everything *sits*.
 *
 * Line numbers are not decoration: the viewer colours a screen's lines by which
 * definition owns them and decides which tethers are live from whether an edited
 * line falls inside a node's range. So they must still travel — just as cheap
 * node metadata, without dragging the geometry along.
 */
function positionDigest(facts: FileFacts | null): string {
  if (!facts) return "";
  const parts: string[] = [];
  for (const d of facts.definitions) parts.push(`${d.id}\u0001${d.startLine}\u0001${d.endLine}`);
  return fnv(parts);
}

/** Outcome of an {@link RepoAnalyzer.upsert}. */
export type UpsertResult = "changed" | "unchanged" | "skipped" | "failed";

export class RepoAnalyzer {
  readonly root: string;
  private files = new Map<string, FileEntry>();
  private ready: Promise<unknown> | null = null;
  private languages: LangId[] = [];
  /**
   * Bumped only when a parse changes the graph's shape.
   *
   * Unsaved edits move file *content* without touching definitions or calls,
   * which lets the layout reuse everything it derived from the graph and
   * rebuild only the screens — the difference between ~30ms and ~1ms per
   * keystroke.
   */
  private graphRev = 0;
  /** True once the initial scan has finished, so later arrivals are creations. */
  private scanned = false;
  /** Bumped when a definition moves without the graph changing shape. */
  private posRev = 0;
  /** Last assembled graph, reused while neither revision has moved. */
  private assembled: { rev: number; graph: CodeGraph } | null = null;

  constructor(root: string) {
    this.root = root;
  }

  private init() {
    this.ready ??= warmup(WASM_DIR).then((langs) => {
      this.languages = langs;
      return langs;
    });
    return this.ready;
  }

  get fileMap() {
    return this.files;
  }

  get readyLanguages() {
    return this.languages;
  }

  /** Changes whenever the parsed graph does, and not otherwise. */
  get graphRevision() {
    return this.graphRev;
  }

  /** Bumped when definitions move within their files. See {@link positionDigest}. */
  get positionRevision() {
    return this.posRev;
  }

  /**
   * Read (and if it is source, parse) one file.
   *
   * Text files — `package.json`, `requirements.txt`, a README — are tracked
   * the same way minus the parse: they get content, diffs and screens, they
   * just contribute nothing to the graph.
   *
   * @returns what happened, so a caller can tell a real edit from a duplicate
   * notification of one it has already seen.
   */
  async upsert(rel: string): Promise<UpsertResult> {
    const spec = specForPath(rel);
    const textLanguage = spec ? null : textLanguageOf(rel);
    if (!spec && !textLanguage) return "skipped";
    if (spec) await this.init();

    const abs = join(this.root, rel);
    let source: string;
    let mtime: number;
    try {
      source = await readFile(abs, "utf8");
      // Real disk mtime, not now(): a cold repo must render cold on first load.
      mtime = (await stat(abs)).mtimeMs;
    } catch {
      this.files.delete(rel);
      return "skipped";
    }
    if (source.length > MAX_SOURCE_BYTES) return "skipped";

    const previous = this.files.get(rel);
    if (previous?.source === source) {
      // Byte-identical, so there is nothing to re-parse and nothing to report.
      // This is the common case for the second notification of a single write:
      // the hot-file poll sees it first and chokidar follows a few
      // milliseconds later.
      previous.mtime = mtime;
      return "unchanged";
    }

    let facts: FileFacts | null = null;
    if (spec) {
      try {
        facts = await extract({ file: rel, source, spec, wasmDir: WASM_DIR });
      } catch (err) {
        console.error(`[parse] ${rel}:`, err instanceof Error ? err.message : err);
        return "failed";
      }
    }

    this.files.set(rel, {
      path: rel,
      language: spec?.id ?? textLanguage!,
      facts,
      source,
      lineCount: facts?.lineCount ?? countLines(source),
      bytes: Buffer.byteLength(source),
      mtime,
      changedAt: previous ? Date.now() : this.scanned ? Date.now() : mtime,
      diff: previous ? diffLines(previous.source, source) : { changes: [], added: 0, removed: 0, touched: new Set(), anchor: null },
      revisions: (previous?.revisions ?? 0) + 1,
      born: previous?.born ?? this.scanned,
      unsaved: previous?.unsaved ?? null,
    });
    // Two revisions, because two different things can change and they cost
    // wildly different amounts to publish. Editing a string literal moves
    // neither. Inserting a line moves only positions. Adding a call moves the
    // structure, and only then is the cached geometry actually wrong.
    const before = previous?.facts ?? null;
    if (structureDigest(facts) !== structureDigest(before)) this.graphRev++;
    if (positionDigest(facts) !== positionDigest(before)) this.posRev++;
    return "changed";
  }

  /**
   * Apply the set of buffers editors are holding unsaved.
   *
   * A backup whose content matches what is on disk is not a pending edit —
   * editors leave stale backups behind — so those are dropped rather than
   * shown as perpetual unsaved changes.
   *
   * @returns the paths whose unsaved state changed.
   */
  applyUnsaved(buffers: Map<string, { content: string; at: number }>): string[] {
    const touched: string[] = [];

    for (const [path, entry] of this.files) {
      const buffer = buffers.get(path);
      const pending = buffer && buffer.content !== entry.source ? buffer : null;

      if (!pending) {
        if (entry.unsaved) {
          entry.unsaved = null;
          touched.push(path);
        }
        continue;
      }
      if (entry.unsaved?.content === pending.content) continue;

      entry.unsaved = {
        content: pending.content,
        at: pending.at,
        diff: diffLines(entry.source, pending.content),
        lineCount: countLines(pending.content),
      };
      touched.push(path);
    }
    return touched;
  }

  remove(rel: string): boolean {
    const had = this.files.get(rel);
    if (had?.facts) this.graphRev++;
    return this.files.delete(rel);
  }

  removeDir(relDir: string): string[] {
    const prefix = relDir.endsWith("/") ? relDir : relDir + "/";
    const gone: string[] = [];
    for (const key of this.files.keys()) {
      if (key === relDir || key.startsWith(prefix)) {
        if (this.files.get(key)?.facts) this.graphRev++;
        this.files.delete(key);
        gone.push(key);
      }
    }
    return gone;
  }

  /**
   * Assemble the graph from cached per-file facts. Pure CPU, no I/O.
   *
   * An unsaved edit cannot change the graph, so the assembly is reused while
   * the revision holds — otherwise every keystroke re-resolved every call site
   * in the repository to arrive at the identical answer.
   *
   * Keyed on the position revision as well as the structural one. Definitions
   * carry their line ranges, so a graph reused across a line insert would hand
   * out stale positions — which is exactly the drift that would colour the
   * wrong lines on a screen. Re-resolving is about a millisecond; being wrong
   * is not worth saving it.
   */
  build(): AnalysisResult {
    const t0 = performance.now();
    let graph: CodeGraph;
    const rev = this.graphRev * 1_000_003 + this.posRev;
    if (this.assembled?.rev === rev) {
      graph = this.assembled.graph;
    } else {
      // Only parsed files contribute to the graph; text files are along for the
      // screens and the change log.
      const facts = [...this.files.values()]
        .map((f) => f.facts)
        .filter((f): f is FileFacts => f !== null);
      graph = buildGraph(facts);
      this.assembled = { rev, graph };
    }
    // Every file, most recently written first.
    //
    // This used to be filtered to files that changed *during the session*,
    // which meant a freshly opened repo had no recent list at all and the
    // screens fell back to the graph's entry points — so the first thing you
    // saw was never the file you had just been editing. `changedAt` is disk
    // mtime for a file the scan read and a real clock for one that changed
    // since (see `upsert`), so a single sort spans both: your last edits are on
    // screen from the first frame, and a live save moves to the front of them.
    //
    // A file being typed into right now outranks one that was saved a moment
    // ago — the unsaved edit is the more current thing to be looking at.
    const recentlyChanged = [...this.files.values()]
      .sort((a, b) => (b.unsaved?.at ?? b.changedAt) - (a.unsaved?.at ?? a.changedAt));
    return {
      graph,
      graphRevision: this.graphRev,
      positionRevision: this.posRev,
      files: this.files,
      recentlyChanged,
      analyzeMs: performance.now() - t0,
    };
  }

  /** Full scan: parse every analyzable file under root. */
  async scan(paths: string[], onProgress?: (done: number, total: number) => void) {
    await this.init();
    let done = 0;
    // The WASM parsers are single-threaded, but file reads overlap.
    const queue = [...paths];
    const workers = Array.from({ length: 6 }, async () => {
      for (let rel = queue.pop(); rel; rel = queue.pop()) {
        await this.upsert(rel).catch(() => "failed" as const);
        onProgress?.(++done, paths.length);
      }
    });
    await Promise.all(workers);
    // Anything that turns up from here on is a file someone just made.
    this.scanned = true;
  }

  relativize(abs: string): string {
    return toPosix(relative(this.root, abs));
  }
}

export type { CodeGraph, FileFacts, LangId };

function countLines(text: string): number {
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}
