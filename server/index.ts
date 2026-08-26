/**
 * CodeFlow3D backend: Bun.serve + native WebSockets.
 *
 *   local repo path -> chokidar -> tree-sitter (incremental) -> call graph
 *                   -> 3D layout -> WebSocket broadcast -> React/three viewer
 *
 * Run:  bun server/index.ts --path /abs/path/to/repo [--port 5177]
 */
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { ClientMsg, FileEvent, SceneGraph, ServerMsg } from "../shared/protocol";
import { RepoAnalyzer, isTracked } from "./analyzer";
import { UnsavedWatcher } from "./unsaved";
import { DEFAULT_LAYOUT, layout, type LayoutCache, type LayoutConfig } from "./layout";
import { IGNORED_DIRS, startWatcher, walkRepo, type WatcherHandle } from "./watcher";
import { Ignore } from "./ignore";

// ------------------------------------------------------------------ arguments

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`));
  return inline ? inline.split("=").slice(1).join("=") : fallback;
}

const PORT = Number(arg("port", process.env.PORT ?? "5189"));
const PROD = process.env.NODE_ENV === "production";
const HERE = new URL(".", import.meta.url).pathname;
const PROJECT_ROOT = resolve(HERE, "..");
const EXPORT_DIR = resolve(PROJECT_ROOT, "exports");
const CLIENT_DIST = resolve(PROJECT_ROOT, "client/dist");

// ------------------------------------------------------------------ live state

interface Session {
  root: string;
  projectName: string;
  analyzer: RepoAnalyzer;
  watcher: WatcherHandle | null;
  scene: SceneGraph | null;
  activeFile: string | null;
  rev: number;
  cfg: LayoutConfig;
  recent: FileEvent[];
  /** Watches editors' unsaved buffers, so edits show before they are saved. */
  unsaved: UnsavedWatcher | null;
  /** Graph-derived layout work, reused across content-only changes. */
  layoutCache: { current: LayoutCache | null };
  /** What each screen last looked like on the wire, so only changes are sent. */
  sentPanels: Map<string, string>;
  /** Content hash per scene section, so unchanged geometry never travels. */
  sentSections: Map<string, string>;
  /** True once a client has a full scene to patch against. */
  primed: boolean;
  /**
   * What this repository's graph does not include, and why.
   *
   * Reported rather than assumed: a scan that quietly drops two thirds of a
   * tree reads as "this project is small", which is a worse failure than being
   * slow — you cannot tell that the map is incomplete by looking at it.
   */
  omitted: { vendoredTrees: string[]; overBudget: number; budget: number };
  /**
   * How live typing is actually being observed.
   *
   * Worth reporting, because the answer is often "not at all": VS Code and
   * Cursor on desktop write unsaved buffers to disk when the window closes,
   * not while you type, so there is nothing to read until you save. The viewer
   * says so rather than looking silently broken.
   */
  liveTyping: { backupStores: number; unsavedSeen: number; pushedBuffers: number };
  /** Files open in the viewer's editor; their panels keep their slot. */
  pinned: string[];
  /**
   * Paths written by the viewer's own editor, so the resulting watcher event
   * can be labelled as such instead of looking like an outside change.
   */
  selfWrites: Map<string, number>;
}

let session: Session | null = null;
const sockets = new Set<Bun.ServerWebSocket<unknown>>();

/**
 * Edit heat is baked into the scene at layout time, so after a burst of writes
 * we re-emit a couple of scenes to let the warm colours visibly cool down
 * instead of freezing mid-flash. Layout is ~15ms, so this is nearly free.
 */
const COOLDOWN_MS = [1_400, 3_600, 8_000];
let cooldownTimers: ReturnType<typeof setTimeout>[] = [];

/**
 * Everything a screen draws, as a short string.
 *
 * The line *text* has to be in here. Metadata alone is not enough: replacing
 * one line with a different line of the same shape leaves the diff counts,
 * focus line and line count all identical, so a metadata-only signature would
 * call that "unchanged" and the screen would never update.
 */
/**
 * A content hash for one scene section.
 *
 * Only reached when the layout was rebuilt; a reused layout is settled by
 * object identity. Stringifying a few thousand nodes costs well under a
 * millisecond and saves sending a few hundred kilobytes that did not change.
 */
function hashOf(value: unknown): string {
  const json = JSON.stringify(value) ?? "";
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < json.length; i++) hash = Math.imul(hash ^ json.charCodeAt(i), 16777619);
  return `${json.length.toString(36)}:${(hash >>> 0).toString(36)}`;
}

function panelSignature(panel: SceneGraph["panels"][number]): string {
  let hash = 2166136261 >>> 0;
  for (const line of panel.lines) {
    hash = Math.imul(hash ^ line.n, 16777619);
    hash = Math.imul(hash ^ (line.change ? line.change.charCodeAt(0) : 0), 16777619);
    for (const span of line.spans) {
      for (let i = 0; i < span.t.length; i++) {
        hash = Math.imul(hash ^ span.t.charCodeAt(i), 16777619);
      }
    }
  }
  return [
    panel.revisions,
    panel.added,
    panel.removed,
    panel.focusLine,
    panel.firstLine,
    panel.unsaved,
    panel.heat,
    panel.active,
    panel.totalLines,
    (hash >>> 0).toString(36),
  ].join("|");
}

/**
 * Normalise a path an editor gave us to a repo-relative POSIX one.
 *
 * Accepts an absolute path, a `file://` URI or an already-relative path, and
 * returns null when the file is outside the watched tree.
 */
function toRepoRelative(root: string, raw: string): string | null {
  let path = raw;
  if (path.startsWith("file://")) {
    try {
      path = decodeURIComponent(new URL(path).pathname);
    } catch {
      return null;
    }
  }
  if (!isAbsolute(path)) return path.split(sep).join("/");
  const rel = relative(root, path).split(sep).join("/");
  return rel && !rel.startsWith("../") && rel !== ".." ? rel : null;
}

function rememberPanels(s: Session, panels: SceneGraph["panels"]) {
  s.sentPanels = new Map(panels.map((p) => [p.file, panelSignature(p)]));
}

function scheduleCooldown() {
  for (const t of cooldownTimers) clearTimeout(t);
  cooldownTimers = COOLDOWN_MS.map((ms) =>
    setTimeout(() => {
      if (!session) return;
      const hot = session.scene?.nodes.some((n) => n.heat > 0.02);
      if (hot) rebuild();
    }, ms),
  );
}

function send(ws: Bun.ServerWebSocket<unknown>, msg: ServerMsg) {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    /* socket closing */
  }
}

function broadcast(msg: ServerMsg) {
  const payload = JSON.stringify(msg);
  for (const ws of sockets) {
    try {
      ws.send(payload);
    } catch {
      sockets.delete(ws);
    }
  }
}

function log(msg: string) {
  console.log(msg);
  broadcast({ t: "log", level: "info", msg });
}

// ------------------------------------------------------------------ pipeline

function rebuild(events: FileEvent[] = []): SceneGraph {
  const s = session!;
  const analysis = s.analyzer.build();
  const previousKey = s.layoutCache.current?.key ?? null;
  const previousScene = s.scene;
  s.rev++;
  s.scene = layout(analysis, {
    root: s.root,
    projectName: s.projectName,
    activeFile: s.activeFile,
    rev: s.rev,
    cfg: s.cfg,
    pinned: s.pinned,
    cache: s.layoutCache,
    liveTyping: s.liveTyping,
  });
  s.recent = [...events, ...s.recent].slice(0, 60);
  // Point the watcher's fast lane at whatever is on screen. Done here rather
  // than in the watcher callback so it also follows a focus, a pin or a config
  // change, not just a save.
  s.watcher?.setHot(s.scene.panels.map((p) => p.file));

  // If the layout reused its graph-derived work, the only thing that changed
  // is the screens — send that slice rather than the whole scene. On this repo
  // it is ~75KB instead of ~420KB, which is most of the round trip on a
  // keystroke.
  // What the client already has is what decides the payload. Each section is
  // compared against the hash of the one last sent; unchanged sections are
  // simply omitted. When the layout cache was reused the geometry arrays are
  // the *same objects* as last time, so identity settles it without hashing.
  const reused = previousKey !== null && previousKey === s.layoutCache.current?.key;
  const patch: Record<string, unknown> = {};
  const scene = s.scene;

  const section = <T>(name: string, value: T, sameObject: boolean) => {
    if (sameObject && s.sentSections.has(name)) return;
    const hash = hashOf(value);
    if (s.sentSections.get(name) === hash) return;
    s.sentSections.set(name, hash);
    patch[name] = value;
  };

  section("nodes", scene.nodes, reused && previousScene?.nodes === scene.nodes);
  section("edges", scene.edges, reused && previousScene?.edges === scene.edges);
  section("streamlines", scene.streamlines, reused && previousScene?.streamlines === scene.streamlines);
  section("importLinks", scene.importLinks, reused && previousScene?.importLinks === scene.importLinks);
  section("tree", scene.tree, reused && previousScene?.tree === scene.tree);
  section("domain", scene.domain, false);

  // Screens are narrowed to the individual files whose rendered content moved.
  const changed = scene.panels.filter(
    (panel) => s.sentPanels.get(panel.file) !== panelSignature(panel),
  );
  const stage = scene.panels.map((p) => p.file);
  // A screen entering or leaving the stage is a layout change, not a content
  // one, so the client is told the whole running order.
  if (stage.join("\n") !== [...s.sentPanels.keys()].join("\n")) patch.stage = stage;
  if (changed.length) patch.panels = changed;
  rememberPanels(s, scene.panels);

  if (!s.primed) {
    s.primed = true;
    broadcast({ t: "scene", scene, events });
    return scene;
  }

  // The counters travel on every patch, but they also have to be able to *cause*
  // one — the live-typing diagnostic changes when a backup store is discovered,
  // and that is not a change to any geometry section.
  //
  // How long the last rebuild took is not a reason to send anything. Those
  // fields differ on every pass, so hashing them made "did anything change?"
  // always true and woke every client on each cooldown tick with an empty
  // payload.
  const { analyzeMs: _a, layoutMs: _l, rev: _r, ...meaningful } = scene.stats;
  const statsHash = hashOf(meaningful);
  const statsMoved = s.sentSections.get("stats") !== statsHash;
  s.sentSections.set("stats", statsHash);

  // Nothing moved and nothing to report: do not wake every client to say so.
  if (!Object.keys(patch).length && !statsMoved && !events.length) return scene;
  broadcast({
    ...patch,
    t: "patch",
    rev: scene.rev,
    stats: scene.stats,
    activeFile: scene.activeFile,
    events,
  } as ServerMsg);
  return s.scene;
}

/** Apply a watcher batch: re-parse only what changed, then relayout. */
async function applyBatch(events: FileEvent[]) {
  const s = session;
  if (!s) return;
  let touchedSource = false;

  for (const ev of events) {
    if (ev.kind === "unlinkDir") {
      if (s.analyzer.removeDir(ev.path).length) touchedSource = true;
      continue;
    }
    if (ev.kind === "addDir") continue;
    if (ev.kind === "unlink") {
      if (s.analyzer.remove(ev.path)) touchedSource = true;
      if (s.activeFile === ev.path) s.activeFile = null;
      continue;
    }
    // add | change
    const result = await s.analyzer.upsert(ev.path).catch((err) => {
      console.error("[parse]", ev.path, err?.message ?? err);
      return "failed" as const;
    });
    // A single write is often reported twice — once by the hot-file poll and
    // once by chokidar a few milliseconds later. The second report finds
    // byte-identical content, and forwarding it would put a duplicate entry in
    // the feed and wake every client for nothing.
    if (result === "unchanged") {
      ev.duplicate = true;
      continue;
    }
    if (result === "changed") {
      touchedSource = true;
      s.activeFile = ev.path;
      const entry = s.analyzer.fileMap.get(ev.path);
      if (entry) {
        ev.added = entry.diff.added;
        ev.removed = entry.diff.removed;
        ev.hunk = entry.diff.changes.slice(0, 8).map((c) => ({
          type: c.type,
          line: c.line,
          text: c.text.length > 160 ? c.text.slice(0, 160) + "…" : c.text,
        }));
      }
    }
    const wroteAt = s.selfWrites.get(ev.path);
    if (wroteAt && Date.now() - wroteAt < 4000) {
      ev.fromEditor = true;
      s.selfWrites.delete(ev.path);
    }
  }

  const real = events.filter((ev) => !ev.duplicate);
  if (touchedSource) {
    rebuild(real);
    scheduleCooldown();
  } else if (real.length) {
    // Non-source churn (assets, configs, docs) still streams to the feed.
    s.recent = [...real, ...s.recent].slice(0, 60);
    for (const ev of real) broadcast({ t: "event", event: ev });
  }
}

async function openRepo(rawPath: string) {
  const root = resolve(rawPath.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
  if (!existsSync(root)) throw new Error(`path does not exist: ${root}`);
  if (!(await stat(root)).isDirectory()) throw new Error(`not a directory: ${root}`);

  await session?.watcher?.close();
  session?.unsaved?.close();

  session = {
    root,
    projectName: basename(root) || root,
    analyzer: new RepoAnalyzer(root),
    watcher: null,
    unsaved: null,
    layoutCache: { current: null },
    sentPanels: new Map(),
    sentSections: new Map(),
    primed: false,
    liveTyping: { backupStores: 0, unsavedSeen: 0, pushedBuffers: 0 },
    scene: null,
    activeFile: null,
    rev: 0,
    cfg: { ...DEFAULT_LAYOUT },
    recent: [],
    pinned: [],
    selfWrites: new Map(),
    omitted: { vendoredTrees: [], overBudget: 0, budget: 0 },
  };

  broadcast({ t: "status", phase: "analyzing", detail: root });
  const t0 = performance.now();
  const walk = await walkRepo(root);
  let sources = walk.files.filter(isSource);
  log(
    `[scan] ${root}: ${walk.files.length} files, ${sources.length} analyzable` +
      (walk.skipped.length ? `, ${walk.skipped.length} ignored trees skipped` : "") +
      (walk.truncated ? " (walk truncated)" : ""),
  );
  if (walk.skipped.length) {
    // Worth naming: a forgotten virtualenv or vendor directory is the
    // difference between a two-second open and a two-minute one, and the
    // person watching cannot see what was skipped unless we say so.
    log(`[scan] skipped ${walk.skipped.slice(0, 8).join(", ")}${walk.skipped.length > 8 ? ", …" : ""}`);
  }

  /**
   * The work budget.
   *
   * Every stage after the parse is superlinear in *definitions*, and a scene
   * only ever shows a few dozen nodes, so past a certain size the extra files
   * buy nothing but latency. Truncating and saying so beats a progress bar that
   * reaches 100% and then appears to hang for two minutes.
   */
  const budget = Number(process.env.CODEFLOW_MAX_FILES ?? 4000);
  session.omitted = { vendoredTrees: walk.skipped, overBudget: 0, budget };
  let overBudget = 0;
  if (sources.length > budget) {
    overBudget = session.omitted.overBudget = sources.length - budget;
    // Keep the shallowest files: the top of a tree is where the code that
    // defines the shape of a project lives.
    sources = [...sources]
      .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))
      .slice(0, budget);
    log(`[scan] over budget: parsing ${budget} of ${budget + overBudget} files (CODEFLOW_MAX_FILES)`);
  }

  await session.analyzer.scan(sources, (done, total) => {
    if (done % 50 === 0 || done === total) {
      broadcast({ t: "status", phase: "analyzing", detail: `parsing ${done}/${total}`, progress: done / total });
    }
  });

  // Resolving and laying out are synchronous and can take a moment on a large
  // graph. Say so first, and yield, so the message is actually on the wire
  // before the event loop is busy — otherwise the last thing the viewer heard
  // is "parsing 9691/9691" and it looks wedged.
  broadcast({ t: "status", phase: "analyzing", detail: "resolving the call graph" });
  await new Promise((r) => setTimeout(r, 0));

  // Seed the change log from disk mtime.
  //
  // The feed only ever held what the watcher saw, so every fresh start — and
  // `bun --watch` restarts this process on its own source — showed "watching
  // for writes" and nothing else, however recently you had saved. These are
  // real writes with real timestamps; they just predate us, so they are marked
  // `seeded` rather than passed off as observed events.
  const seeded: FileEvent[] = [...session.analyzer.fileMap.values()]
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 12)
    .map((f) => ({
      kind: "change" as const,
      path: f.path,
      at: f.mtime,
      size: f.bytes,
      language: f.language,
      seeded: true,
    }));

  const scene = rebuild(seeded);
  log(
    `[scan] done in ${Math.round(performance.now() - t0)}ms — ` +
      `${scene.stats.nodes} defs, ${scene.stats.edges} calls ` +
      `(${scene.stats.byConfidence.import ?? 0} import-backed), ` +
      `${scene.stats.importEdges} file imports, ${scene.stats.entryPoints} entry points`,
  );

  // The watcher gets the walk's own ignore decisions, so a file the scan
  // refused to read cannot arrive through the watcher and be parsed anyway.
  if (overBudget) {
    broadcast({
      t: "status",
      phase: "watching",
      detail: `showing ${sources.length} of ${sources.length + overBudget} files — raise CODEFLOW_MAX_FILES to see the rest`,
    });
  }

  // The watcher gets the walk's own ignore decisions, so a file the scan
  // refused to read cannot arrive through the watcher and be parsed anyway.
  session.watcher = startWatcher(root, (events) => void applyBatch(events), { ignore: walk.ignore });

  // Unsaved buffers: what an editor is holding but has not written yet.
  const live = new UnsavedWatcher({
    root,
    onChange: (buffers) => {
      const s = session;
      if (!s) return;
      const touched = s.analyzer.applyUnsaved(buffers);
      s.liveTyping.unsavedSeen += touched.length;
      if (!touched.length) return;
      const at = Date.now();
      const events: FileEvent[] = touched.map((path) => {
        const entry = s.analyzer.fileMap.get(path);
        return {
          kind: "editing",
          path,
          at,
          size: entry?.unsaved?.content.length ?? 0,
          language: entry?.language ?? null,
          unsaved: Boolean(entry?.unsaved),
          added: entry?.unsaved?.diff.added,
          removed: entry?.unsaved?.diff.removed,
          hunk: entry?.unsaved?.diff.changes.slice(0, 8).map((c) => ({
            type: c.type,
            line: c.line,
            text: c.text.length > 160 ? c.text.slice(0, 160) + "…" : c.text,
          })),
        };
      });
      s.activeFile = touched[0] ?? s.activeFile;
      rebuild(events);
    },
  });
  session.unsaved = live;
  const dirs = await live.start();
  session.liveTyping.backupStores = dirs.length;
  // The first scene was built before the stores were counted; republish so the
  // viewer's live-typing panel is right from the start rather than after the
  // first edit.
  rebuild();
  log(
    dirs.length
      ? `[unsaved] watching ${dirs.length} editor backup ${dirs.length === 1 ? "store" : "stores"} ` +
          `— note that VS Code writes these on exit, not while typing`
      : "[unsaved] no editor backup store found",
  );

  broadcast({ t: "status", phase: "watching", detail: root });
}

/**
 * Join a repo-relative path onto the root, refusing anything that escapes it.
 * Editing is a write primitive, so this is the one check that must not be
 * merely conventional.
 */
function safeJoin(root: string, rel: string): string | null {
  if (rel.includes("\0")) return null;
  const abs = resolve(root, rel);
  const prefix = root.endsWith("/") ? root : root + "/";
  return abs === root || abs.startsWith(prefix) ? abs : null;
}

/**
 * Apply a buffer pushed from outside — the event-driven route.
 *
 * Dispatched by an editor (over the socket or `POST /api/buffer`) the instant
 * its text changes, this skips the backup-store scan entirely and updates the
 * scene in one hop: push, diff, relayout screens, broadcast.
 */
function pushBuffer(rawFile: string, content: string | null) {
  const s = session;
  if (!s?.unsaved) return false;
  // An editor knows a document by its absolute path and should not have to
  // learn where the repo root is to talk to us. Anything outside the watched
  // tree is simply not ours — a quiet no-op, not an error, because an editor
  // pushes every buffer it has and most of them will be other projects.
  const file = toRepoRelative(s.root, rawFile);
  if (!file || !safeJoin(s.root, file)) return false;

  if (content === null) s.unsaved.drop(file);
  else {
    s.unsaved.push(file, content);
    s.liveTyping.pushedBuffers++;
  }

  const touched = s.analyzer.applyUnsaved(s.unsaved.current);
  if (!touched.length) return true;

  const at = Date.now();
  s.activeFile = touched[0] ?? s.activeFile;
  rebuild(
    touched.map((path) => {
      const entry = s.analyzer.fileMap.get(path);
      return {
        kind: "editing" as const,
        path,
        at,
        size: entry?.unsaved?.content.length ?? 0,
        language: entry?.language ?? null,
        unsaved: Boolean(entry?.unsaved),
        added: entry?.unsaved?.diff.added,
        removed: entry?.unsaved?.diff.removed,
        hunk: entry?.unsaved?.diff.changes.slice(0, 8).map((c) => ({
          type: c.type,
          line: c.line,
          text: c.text.length > 160 ? c.text.slice(0, 160) + "…" : c.text,
        })),
      };
    }),
  );
  return true;
}

/** Every file the analyzer tracks: parsed source plus diffed text files. */
function isSource(path: string): boolean {
  return isTracked(path);
}

const REPO_MARKERS = [".git", "package.json", "pyproject.toml", "go.mod", "Cargo.toml", "pom.xml", "build.gradle"];

export interface DirInfo {
  name: string;
  path: string;
  /** Analyzable files directly inside (not recursive) — a cheap "worth opening" hint. */
  sourceFiles: number;
  /** Subdirectories, so the picker can show whether it is worth descending. */
  subdirs: number;
  /** Which repo marker was found, if any. */
  marker: string | null;
  readable: boolean;
}

/**
 * One shallow readdir per row: enough signal for the picker, cheap enough to
 * batch.
 *
 * `ignore` is the browsed directory's own rules and `prefix` says where this row
 * sits inside it, so the subdirectory count means the same thing the walk would
 * mean by it — a repository that gitignores its `dist/` does not advertise it
 * here as something worth descending into.
 */
async function describeDir(abs: string, name: string, ignore: Ignore, prefix: string): Promise<DirInfo> {
  try {
    const entries = await readdir(abs, { withFileTypes: true });
    let sourceFiles = 0;
    let subdirs = 0;
    let marker: string | null = null;
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!ignore.ignores(rel, true) && !e.name.startsWith(".")) subdirs++;
        if (!marker && REPO_MARKERS.includes(e.name)) marker = e.name;
      } else if (e.isFile()) {
        if (isSource(e.name)) sourceFiles++;
        if (!marker && REPO_MARKERS.includes(e.name)) marker = e.name;
      }
    }
    return { name, path: abs, sourceFiles, subdirs, marker, readable: true };
  } catch {
    return { name, path: abs, sourceFiles: 0, subdirs: 0, marker: null, readable: false };
  }
}

// ------------------------------------------------------------------ http/ws

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".glb": "model/gltf-binary",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}

async function serveStatic(pathname: string): Promise<Response | null> {
  if (!PROD) return null;
  const rel = pathname === "/" ? "/index.html" : pathname;
  const file = Bun.file(resolve(CLIENT_DIST, "." + rel));
  if (await file.exists()) {
    const ext = rel.slice(rel.lastIndexOf("."));
    return new Response(file, { headers: { "content-type": MIME[ext] ?? file.type } });
  }
  // SPA fallback
  const index = Bun.file(resolve(CLIENT_DIST, "index.html"));
  if (await index.exists()) return new Response(index, { headers: { "content-type": MIME[".html"] } });
  return null;
}

await mkdir(EXPORT_DIR, { recursive: true });

const server = Bun.serve({
  port: PORT,
  idleTimeout: 120,
  maxRequestBodySize: 512 * 1024 * 1024,

  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;

    if (pathname === "/ws") {
      if (server.upgrade(req)) return undefined as unknown as Response;
      return new Response("expected websocket upgrade", { status: 400 });
    }

    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "content-type,x-filename",
        },
      });
    }

    // ---- API
    if (pathname === "/api/status") {
      return json({
        watching: session?.root ?? null,
        project: session?.projectName ?? null,
        rev: session?.rev ?? 0,
        stats: session?.scene?.stats ?? null,
        clients: sockets.size,
        // What the graph leaves out: ignored trees, and anything past the
        // per-repo file budget.
        omitted: session?.omitted ?? null,
        wasmDir: resolve(PROJECT_ROOT, "wasm"),
      });
    }

    if (pathname === "/api/scene") {
      if (!session?.scene) return json({ error: "no repo open" }, 409);
      return json(session.scene);
    }

    if (pathname === "/api/events") {
      return json(session?.recent ?? []);
    }

    if (pathname === "/api/watch" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { path?: string };
      if (!body.path) return json({ error: "path required" }, 400);
      try {
        await openRepo(body.path);
        return json({ ok: true, root: session!.root, stats: session!.scene?.stats });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        broadcast({ t: "status", phase: "error", detail: msg });
        return json({ error: msg }, 400);
      }
    }

    /**
     * Directory listing for the folder picker. Each child carries enough
     * metadata for the picker to be useful without a round trip per row:
     * whether it looks like a repository, and how many analyzable files sit
     * directly inside it.
     */
    if (pathname === "/api/browse") {
      const requested = url.searchParams.get("path") || process.env.HOME || "/";
      const showHidden = url.searchParams.get("hidden") === "1";
      const abs = resolve(requested.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
      try {
        const entries = await readdir(abs, { withFileTypes: true });
        // The rules of the directory being browsed, so the picker hides what
        // opening it would refuse to walk. A directory that is not a git
        // checkout has no rules and nothing is hidden — which is the honest
        // answer, since opening it would walk all of it too.
        const ignore = new Ignore(abs);
        const dirs = entries
          .filter((e) => e.isDirectory())
          .filter((e) => showHidden || !e.name.startsWith("."))
          .filter((e) => !ignore.ignores(e.name, true) && !IGNORED_DIRS.has(e.name))
          .map((e) => e.name)
          .sort((a, b) => a.localeCompare(b))
          .slice(0, 500);

        const described = await Promise.all(
          dirs.map((name) => describeDir(resolve(abs, name), name, ignore, name)),
        );
        return json({
          path: abs,
          parent: abs === "/" ? null : resolve(abs, ".."),
          home: process.env.HOME ?? "/",
          self: await describeDir(abs, basename(abs) || abs, ignore, ""),
          dirs: described,
        });
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    }

    /** Receive a GLB serialized in the browser and persist it. */
    if (pathname === "/api/glb" && req.method === "POST") {
      const bytes = new Uint8Array(await req.arrayBuffer());
      if (bytes.byteLength < 20) return json({ error: "empty glb" }, 400);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const name = `${(session?.projectName ?? "scene").replace(/[^\w.-]/g, "_")}-${stamp}.glb`;
      await writeFile(resolve(EXPORT_DIR, name), bytes);
      log(`[glb] wrote exports/${name} (${(bytes.byteLength / 1e6).toFixed(2)} MB)`);
      return json({ ok: true, name, url: `/exports/${name}`, bytes: bytes.byteLength });
    }

    if (pathname === "/api/exports") {
      const files = await readdir(EXPORT_DIR).catch(() => [] as string[]);
      const out = await Promise.all(
        files
          .filter((f) => f.endsWith(".glb"))
          .map(async (f) => {
            const st = await stat(resolve(EXPORT_DIR, f));
            return { name: f, url: `/exports/${f}`, bytes: st.size, at: st.mtimeMs };
          }),
      );
      return json(out.sort((a, b) => b.at - a.at));
    }

    if (pathname.startsWith("/exports/")) {
      const file = Bun.file(resolve(EXPORT_DIR, pathname.slice("/exports/".length)));
      if (await file.exists()) {
        return new Response(file, {
          headers: {
            "content-type": "model/gltf-binary",
            "access-control-allow-origin": "*",
            "content-disposition": `inline; filename="${basename(pathname)}"`,
          },
        });
      }
      return new Response("not found", { status: 404 });
    }

    /** Full source of a file in the open repo, for the in-scene editor. */
    if (pathname === "/api/source") {
      const rel = url.searchParams.get("file");
      if (!session || !rel) return json({ error: "no repo open" }, 400);
      const abs = safeJoin(session.root, rel);
      if (!abs) return json({ error: "path escapes the repo" }, 400);
      const entry = session.analyzer.fileMap.get(rel);
      if (entry) {
        return json({
          file: rel,
          language: entry.language,
          source: entry.source,
          revisions: entry.revisions,
          readOnly: false,
        });
      }
      const f = Bun.file(abs);
      if (await f.exists()) {
        /*
         * A file the analyser never took is either a text file it does not
         * classify or not text at all, and the difference matters: handing an
         * image's bytes to the highlighter produced two thousand lines of
         * mojibake labelled "typescript". Decide it the way the rest of this
         * server decides things — on evidence in the file rather than on its
         * name. A NUL byte in the first few KB is what every diff tool in
         * existence uses to mean "not text", and no UTF-8 text contains one.
         */
        const head = new Uint8Array(await f.slice(0, 8192).arrayBuffer());
        if (head.includes(0)) {
          return json({ file: rel, binary: true, bytes: f.size, source: "", language: null, revisions: 0, readOnly: true });
        }
        return json({ file: rel, language: null, source: await f.text(), revisions: 0, readOnly: false });
      }
      return json({ error: "not found" }, 404);
    }

    /**
     * Push a buffer's current text without writing it.
     *
     * For editors that cannot hold a websocket. Same effect as the `buffer`
     * socket message: the scene updates in one hop, no polling involved.
     * `content: null` withdraws the buffer.
     */
    if (pathname === "/api/buffer" && req.method === "POST") {
      if (!session) return json({ error: "no repo open" }, 409);
      const body = (await req.json().catch(() => ({}))) as {
        file?: string;
        content?: string | null;
      };
      if (!body.file) return json({ error: "file required" }, 400);
      if (typeof body.content === "string" && body.content.length > 4_000_000) {
        return json({ error: "buffer too large" }, 413);
      }
      // An editor pushes every buffer it has, and most of them belong to other
      // projects. That is the normal case, not a failure — answering with an
      // error would make a well-behaved extension conclude the viewer is broken
      // and back off while you work anywhere else.
      const ok = pushBuffer(body.file, body.content ?? null);
      return json(ok ? { ok: true, file: body.file } : { ok: true, ignored: "outside the watched repo" });
    }

    /**
     * Save an edit made in the viewer back to disk.
     *
     * Writes are confined to the watched repository — the path is resolved and
     * checked against the root, so nothing outside it can be touched — and the
     * resulting watcher event flows through the normal pipeline, which is what
     * makes an in-scene edit update the graph the same way an outside one does.
     */
    if (pathname === "/api/write" && req.method === "POST") {
      if (!session) return json({ error: "no repo open" }, 409);
      const body = (await req.json().catch(() => ({}))) as { file?: string; content?: string };
      if (!body.file || typeof body.content !== "string") {
        return json({ error: "file and content required" }, 400);
      }
      const abs = safeJoin(session.root, body.file);
      if (!abs) return json({ error: "path escapes the repo" }, 400);
      if (body.content.length > 4_000_000) return json({ error: "file too large" }, 413);
      try {
        session.selfWrites.set(body.file, Date.now());
        await writeFile(abs, body.content, "utf8");
        return json({ ok: true, file: body.file, bytes: Buffer.byteLength(body.content) });
      } catch (err) {
        session.selfWrites.delete(body.file);
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    const stat_ = await serveStatic(pathname);
    if (stat_) return stat_;

    return new Response("CodeFlow3D API. Dev UI: http://localhost:5188", { status: 404 });
  },

  websocket: {
    open(ws) {
      sockets.add(ws);
      send(ws, {
        t: "hello",
        watching: session?.root ?? null,
        rev: session?.rev ?? 0,
        languages: session?.analyzer.readyLanguages ?? [],
      });
      if (session?.scene) send(ws, { t: "scene", scene: session.scene, events: session.recent.slice(0, 12) });
      else send(ws, { t: "status", phase: "idle" });
    },
    close(ws) {
      sockets.delete(ws);
    },
    async message(ws, raw) {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.t === "watch") {
        try {
          await openRepo(msg.path);
        } catch (err) {
          send(ws, { t: "status", phase: "error", detail: err instanceof Error ? err.message : String(err) });
        }
      } else if (msg.t === "reanalyze" && session) {
        const sources = (await walkRepo(session.root)).files.filter(isSource);
        await session.analyzer.scan(sources);
        rebuild();
      } else if (msg.t === "focus" && session) {
        session.activeFile = msg.file;
        rebuild();
      } else if (msg.t === "buffer" && session) {
        pushBuffer(msg.file, msg.content);
      } else if (msg.t === "bufferClosed" && session) {
        pushBuffer(msg.file, null);
      } else if (msg.t === "pin" && session) {
        session.pinned = msg.files.slice(0, 6);
        rebuild();
      } else if (msg.t === "config" && session) {
        if (msg.tracesPerPath) session.cfg.tracesPerPath = Math.max(1, Math.min(8, msg.tracesPerPath));
        if (msg.maxPanels) session.cfg.maxPanels = Math.max(1, Math.min(6, msg.maxPanels));
        if (msg.bundle !== undefined) session.cfg.bundle = Math.max(0, Math.min(1, msg.bundle));
        session.layoutCache.current = null;
        rebuild();
      }
    },
  },
});

console.log(`\n  CodeFlow3D server  http://localhost:${server.port}`);
console.log(`  websocket          ws://localhost:${server.port}/ws`);
console.log(`  exports            ${EXPORT_DIR}`);

// With no path given, trace this project's own source.
const initial = arg("path") ?? process.env.CODEFLOW_PATH ?? PROJECT_ROOT;
if (initial) {
  const target = isAbsolute(initial) ? initial : resolve(process.cwd(), initial);
  console.log(`  watching           ${target}\n`);
  openRepo(target).catch((err) => console.error("[open]", err));
}
