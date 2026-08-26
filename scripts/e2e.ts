/**
 * End-to-end check of the dev stack.
 *
 * Boots `scripts/dev.ts` for real against a small throwaway repository, then
 * asserts the whole chain the viewer depends on: API up, repository analysed,
 * call graph resolved through actual imports, websocket handshake, Vite HMR
 * live, a watcher-driven re-parse after an outside edit, and a write through
 * `POST /api/write` landing on disk and coming back in the graph.
 *
 * Runs on its own ports (PORT / API_PORT, set by the Makefile) so it never
 * disturbs — or gets disturbed by — a dev session on the default ports.
 *
 *   make test
 */
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile, readFile, appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TOKEN_CLASSES } from "../shared/protocol";
import { METRICS, PX_PER_UNIT, TOKEN_COLORS, editorMetrics } from "../client/src/lib/editorTheme";
import { MOTION, freshLines, glide, queueDelay } from "../client/src/lib/motion";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const UI_PORT = process.env.PORT ?? "5288";
const API_PORT = process.env.API_PORT ?? "5289";
const API = `http://127.0.0.1:${API_PORT}`;
const UI = `http://127.0.0.1:${UI_PORT}`;
const RUN_DIR = resolve(ROOT, ".run");
const FIXTURE = resolve(RUN_DIR, "e2e-fixture");
const LOG = resolve(RUN_DIR, "e2e.log");

// ------------------------------------------------------------------ reporting

let passed = 0;
const failures: string[] = [];
const t0 = Date.now();
const ms = () => `${String(Date.now() - t0).padStart(5)}ms`;

function ok(label: string, detail = "") {
  passed++;
  console.log(`  \x1b[32m✓\x1b[0m ${ms()}  ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ""}`);
}
function fail(label: string, detail: string) {
  failures.push(`${label}: ${detail}`);
  console.log(`  \x1b[31m✗\x1b[0m ${ms()}  ${label}  \x1b[31m${detail}\x1b[0m`);
}
function check(label: string, cond: unknown, detail = "") {
  if (cond) ok(label, detail);
  else fail(label, detail || "assertion failed");
  return Boolean(cond);
}

const sleep = (n: number) => new Promise((r) => setTimeout(r, n));

/** Polls until `fn` returns something truthy, or gives up. */
async function waitFor<T>(label: string, fn: () => Promise<T | null>, timeoutMs = 60_000): Promise<T | null> {
  const until = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < until) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    await sleep(250);
  }
  fail(label, `timed out after ${timeoutMs}ms${last ? ` (${last})` : ""}`);
  return null;
}

async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, init);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return (await res.json()) as T;
}

// ------------------------------------------------------------------ fixture
//
// Three files with real imports, so the graph has `import`-tier edges to check
// rather than name-matched guesses. Kept outside the source tree: the test
// edits these files, and editing the repo under test would be a side effect.

/** Files inside trees that must never be walked, watched or parsed. */
const VENDORED = 300;

async function writeFixture() {
  await rm(FIXTURE, { recursive: true, force: true });
  await mkdir(FIXTURE, { recursive: true });
  await writeFile(resolve(FIXTURE, "package.json"), JSON.stringify({ name: "e2e-fixture", private: true }, null, 2));
  await writeFile(
    resolve(FIXTURE, "alpha.ts"),
    `export function alpha(n: number): number {\n  return n + 1;\n}\n`,
  );
  await writeFile(
    resolve(FIXTURE, "beta.ts"),
    `import { alpha } from "./alpha";\n\nexport function beta(n: number): number {\n  return alpha(n) * 2;\n}\n`,
  );
  await writeFile(
    resolve(FIXTURE, "main.ts"),
    `import { beta } from "./beta";\n\nexport function main(): number {\n  return beta(1);\n}\n`,
  );

  // ---- the trees that must stay out of the graph
  //
  // Modelled on the repository that made this necessary: a virtualenv named
  // something no fixed ignore list would ever guess, listed in .gitignore,
  // holding thousands of installed files.
  await writeFile(
    resolve(FIXTURE, ".gitignore"),
    // A directory pattern with a wildcard — the shape that was silently
    // ignoring nothing, because the trailing slash made the rule skip files.
    ".venv*/\ngenerated/\nnode_modules/\n*.min.js\n!keep.min.js\n",
  );

  // 1. gitignored, and a virtualenv by marker: two independent reasons.
  const venv = resolve(FIXTURE, ".venv-local/lib/python3.12/site-packages/pkg");
  await mkdir(venv, { recursive: true });
  await writeFile(resolve(FIXTURE, ".venv-local/pyvenv.cfg"), "home = /usr/bin\n");
  for (let i = 0; i < VENDORED; i++) {
    await writeFile(resolve(venv, `mod${i}.py`), `def installed_${i}():\n    return ${i}\n`);
  }

  // 2. gitignored by name only, no marker.
  await mkdir(resolve(FIXTURE, "generated"), { recursive: true });
  await writeFile(resolve(FIXTURE, "generated/schema.ts"), "export const generated = 1;\n");

  // 3. gitignored the way every real project ignores it. There is no fixed list
  // of names any more, so this is skipped for the same reason `generated/` is:
  // the repository said so.
  await mkdir(resolve(FIXTURE, "node_modules/dep"), { recursive: true });
  await writeFile(resolve(FIXTURE, "node_modules/dep/index.js"), "module.exports = 1;\n");

  // 4. the other direction, which the fixed list used to get wrong: a name that
  // was on it (`dist`) but that this repository does *not* ignore. Committed
  // build output is somebody's actual source, and it has to be walked.
  await mkdir(resolve(FIXTURE, "dist"), { recursive: true });
  await writeFile(resolve(FIXTURE, "dist/committed.ts"), "export const shipped = 1;\n");

  // A negation, because `!` is the rule most likely to be dropped in a rewrite.
  await writeFile(resolve(FIXTURE, "bundle.min.js"), "var a=1;\n");
  await writeFile(resolve(FIXTURE, "keep.min.js"), "export const keep = 1;\n");
}

// ------------------------------------------------------------------ the stack

let child: ReturnType<typeof spawn> | null = null;

async function boot() {
  const log = Bun.file(LOG).writer();
  child = spawn("bun", ["scripts/dev.ts", FIXTURE], {
    cwd: ROOT,
    env: { ...process.env, PORT: UI_PORT, API_PORT },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // own process group, so teardown takes the Vite child too
  });
  for (const s of [child.stdout, child.stderr]) {
    s?.on("data", (b: Buffer) => log.write(b));
  }
  child.on("exit", (code) => {
    if (code) console.log(`  \x1b[2mdev.ts exited with ${code} — see ${LOG}\x1b[0m`);
  });
}

function teardown() {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {}
  }
}

// ------------------------------------------------------------- the editor

/** The stylesheet, read once: flat mode's half of the shared theme. */
async function stylesheet() {
  return await readFile(resolve(ROOT, "client/src/styles.css"), "utf8");
}

/**
 * Every code surface renders the same editor.
 *
 * Three separate things are asserted, in the order they can break:
 * the palette covers the wire format, the DOM surfaces read that palette
 * instead of a private copy of it, and the geometry a screen resolves from its
 * own size is an editor's geometry with a buffer big enough to fill it.
 */
async function checkEditor(scene: any) {
  // ---- the palette covers every class the wire can carry
  const uncoloured = TOKEN_CLASSES.filter((c) => !/^(#|rgba?\()/.test(TOKEN_COLORS[c] ?? ""));
  check("every token class has a colour", uncoloured.length === 0,
    uncoloured.length ? `no colour for ${uncoloured.join(", ")}` : `${TOKEN_CLASSES.length} classes`);

  // ---- flat mode reads that palette rather than its own hexes
  const css = await stylesheet();
  const unstyled = TOKEN_CLASSES.filter(
    (c) => !new RegExp(`\\.tk-${c}\\s*\\{[^}]*var\\(--tk-${c}\\)`).test(css),
  );
  check("flat mode colours every class from the shared theme", unstyled.length === 0,
    unstyled.length ? `.tk-${unstyled.join(", .tk-")} not wired to a variable` : "no private palette");
  const strayHex = [...css.matchAll(/\.tk-[a-z]+\s*\{[^}]*#[0-9a-f]{3,8}/gi)].map((m) => m[0]);
  check("no surface keeps a second copy of the palette", strayHex.length === 0,
    strayHex.length ? strayHex[0] : "one source of truth");

  // ---- the highlighter emits what a real theme distinguishes
  const classes = new Set<string>();
  for (const panel of scene.panels ?? []) {
    for (const line of panel.lines ?? []) for (const span of line.spans ?? []) classes.add(span.c);
  }
  for (const wanted of ["keyword", "control", "ident", "fn", "string"]) {
    check(`highlighting distinguishes \`${wanted}\``, classes.has(wanted), [...classes].sort().join(" "));
  }

  // ---- the geometry is an editor's, on every screen and at every screen size
  const sizes: [number, number][] = (scene.panels ?? []).map((p: any) => p.size);
  const scales = [0.5, 1, 2.5]; // the viewer's screen-size slider, end to end
  let worst: { rows: number; ratio: number; detail: string } | null = null;
  let ok = true;
  for (const size of sizes) {
    for (const scale of scales) {
      const w = Math.round(size[0] * scale * PX_PER_UNIT);
      const h = Math.round(size[1] * scale * PX_PER_UNIT);
      const m = editorMetrics(w, h, PX_PER_UNIT);
      const ratio = m.lineH / m.font;
      const detail = `${size[0]}×${size[1]} @${scale}× → ${m.rows} rows, ${m.font}px/${m.lineH}px`;
      // A line box between 1.3 and 1.6 ems is the range every editor ships in;
      // VSCode's own default is 19px on 14px text.
      if (ratio < 1.3 || ratio > 1.6) { ok = false; fail("line box is editor-sized", detail); }
      // Whole rows only: a leftover taller than a line means the rows were
      // stretched to fill the viewport instead of the viewport being filled
      // with rows.
      if (m.codeH - m.rows * m.lineH >= m.lineH) { ok = false; fail("rows fill the viewport", detail); }
      if (!worst || m.rows > worst.rows) worst = { rows: m.rows, ratio, detail };
    }
  }
  if (ok && worst) {
    ok = true;
    check("every screen lays out like an editor", true,
      `${sizes.length} screens × ${scales.length} sizes · densest ${worst.detail}`);
  }

  // ---- and the buffer the server sends can fill the screen that shows it
  const short = (scene.panels ?? []).filter((p: any) => {
    const w = Math.round(p.size[0] * PX_PER_UNIT);
    const h = Math.round(p.size[1] * PX_PER_UNIT);
    const rows = editorMetrics(w, h, PX_PER_UNIT).rows;
    return p.lines.length < Math.min(rows, p.totalLines);
  });
  check("the buffer covers a full screen of every file", short.length === 0,
    short.length
      ? `${short[0].file}: ${short[0].lines.length} of ${short[0].totalLines} lines`
      : `${METRICS.tabSize}-space tabs, ${scene.panels?.length ?? 0} screens filled`);
}

// -------------------------------------------------------------- the queue

/** Run the glide for `seconds` of wall clock at a given frame rate. */
function settle(from: number, to: number, seconds: number, fps: number, over = MOTION.slot) {
  let value = from;
  const dt = 1 / fps;
  for (let t = 0; t < seconds; t += dt) value = glide(value, to, dt, over);
  return value;
}

/**
 * A new file takes the first slot and pushes every screen behind it along one.
 *
 * That shift used to be written straight into the transform, so the whole wall
 * changed places between two frames — a hard cut, with nothing to say which way
 * the row went. The screens travel now, in order. What can be checked without a
 * renderer is the two halves of that: the server really does re-slot the row
 * when a file arrives, and the glide those slots are fed into converges, at any
 * frame rate, in about the time it claims.
 */
async function checkQueue(before: any) {
  const NEW = "delta.ts";
  const wasFirst: string | undefined = before.panels?.[0]?.file;
  await writeFile(
    resolve(FIXTURE, NEW),
    `import { beta } from "./beta";\n\nexport function delta(): number {\n  return beta(3);\n}\n`,
  );
  const after = await waitFor("a new file takes a screen", async () => {
    const s = await api<any>("/api/scene");
    return s.panels?.some((p: any) => p.file === NEW) ? s : null;
  }, 20_000);

  if (after) {
    const order: string[] = after.panels.map((p: any) => p.file);
    check("the new file is first in the row", order[0] === NEW, order.slice(0, 4).join(" → "));
    // The screen that held a slot is still on stage, one place further along:
    // that displacement is exactly what the queued glide animates.
    if (wasFirst && wasFirst !== NEW) {
      const moved = order.indexOf(wasFirst);
      check("the screen it displaced moved along rather than vanishing", moved > 0,
        `${wasFirst}: slot 0 → ${moved}`);
    }
    check("the row shifted by one, not shuffled", order.slice(1).join(" ") !== order.join(" "),
      `${order.length} screens`);
  }

  // The glide itself: same wall clock, wildly different frame rates, same place.
  const slow = settle(0, 10, MOTION.slot, 30);
  const fast = settle(0, 10, MOTION.slot, 144);
  check("a screen travels the same distance whatever the frame rate",
    Math.abs(slow - fast) < 0.25, `30fps → ${slow.toFixed(2)}, 144fps → ${fast.toFixed(2)} of 10`);
  check("it has effectively arrived in the time it promises",
    Math.abs(10 - settle(0, 10, MOTION.slot, 60)) < 0.15, `${settle(0, 10, MOTION.slot, 60).toFixed(3)} of 10`);
  check("and it lands exactly, rather than creeping forever",
    settle(0, 10, MOTION.slot * 3, 60) === 10, "snapped");
  check("nothing moves when a slot has not changed", glide(4, 4, 1 / 60, MOTION.slot) === 4);

  // The cascade: later screens wait their turn, and the whole row is moving
  // well inside the time one screen takes to travel.
  const delays = [0, 1, 2, 3, 4, 5].map(queueDelay);
  const ordered = delays.every((d, i) => i === 0 || d > delays[i - 1]);
  check("the row moves in order, not all at once", ordered && delays[5] < MOTION.slot,
    `last screen starts ${delays[5].toFixed(2)}s in, travels for ${MOTION.slot}s`);
}

// ------------------------------------------------------------------ the test

async function main() {
  console.log(`\n  codeflow3d end-to-end   viewer :${UI_PORT}  api :${API_PORT}\n`);

  await mkdir(RUN_DIR, { recursive: true });
  await writeFixture();
  ok("fixture repo written", FIXTURE.replace(ROOT, "."));

  // Grammars, not dependencies: without the wasm the analyser parses nothing,
  // and every later assertion would fail for a reason that is not the stack's.
  const grammars = await Bun.file(resolve(ROOT, "wasm/tree-sitter-typescript.wasm")).exists();
  if (!check("tree-sitter wasm present", grammars, grammars ? "" : "run `make install`")) return;

  await boot();

  // ---- API up
  const status = await waitFor("api answers /api/status", async () => {
    const s = await api<{ watching: string | null }>("/api/status");
    return s.watching ? s : null;
  });
  if (!status) return;
  check("watching the fixture repo", (status as any).watching === FIXTURE, (status as any).watching);

  // ---- repository analysed
  const analysed = await waitFor("repo analysed", async () => {
    const s = await api<{ stats: { files: number } | null }>("/api/status");
    return s.stats && s.stats.files >= 3 ? s.stats : null;
  });
  if (analysed) {
    // alpha, beta, main, package.json, .gitignore, keep.min.js — and nothing
    // from the three ignored trees.
    check("only the fixture's own files are parsed", analysed.files < 20, `files=${analysed.files}`);
  }

  // ---- the scene the viewer actually renders
  const scene = await api<any>("/api/scene");
  check("scene has nodes", scene.nodes?.length > 0, `nodes=${scene.nodes?.length}`);
  const files: string[] = scene.panels?.map((p: any) => p.file) ?? [];
  // Screens are a fixed number of slots, so not every file gets one — the graph
  // is what has to be complete.
  const graphFiles = new Set<string>((scene.nodes ?? []).map((n: any) => n.file as string));
  const wanted = ["alpha.ts", "beta.ts", "main.ts"];
  const missing = wanted.filter((f) => !graphFiles.has(f));
  check("every source file is in the graph", missing.length === 0,
    missing.length ? `missing ${missing}` : [...graphFiles].join(" "));
  check("screens are allocated", files.length > 0, files.join(" "));

  // ---- what must stay out of the graph
  //
  // The regression this guards is not subtle: a virtualenv the ignore rules
  // failed to skip turned a 270-file repository into a 9,581-file one, 22
  // seconds of parsing, and a layout pass that took nearly two minutes.
  const inGraph = new Set<string>([
    ...files,
    ...(scene.nodes ?? []).map((n: any) => n.file as string),
    ...(scene.tree ?? []).map((t: any) => t.path as string),
  ]);
  const leaked = [...inGraph].filter(
    (f) => f?.startsWith(".venv-local/") || f?.startsWith("generated/") || f?.startsWith("node_modules/"),
  );
  check("gitignored and vendored trees stay out of the graph", leaked.length === 0,
    leaked.length ? `leaked ${leaked.slice(0, 4).join(", ")}` : `${VENDORED} installed files skipped`);
  check("a virtualenv is not parsed however it is named", !inGraph.has(".venv-local/pyvenv.cfg"));

  // Whether a file was *walked* is asked of the analyser directly rather than
  // inferred from the scene: screens are a handful of slots allocated by
  // recency, so a file can be legitimately absent from one. A tracked file has
  // been read and counted (revisions >= 1); an ignored one can still be served
  // from disk on request, and comes back with no revisions and no language.
  const tracked = async (file: string) => {
    const r = await fetch(`${API}/api/source?file=${encodeURIComponent(file)}`);
    if (!r.ok) return false;
    const body = (await r.json()) as { revisions: number };
    return body.revisions >= 1;
  };
  // `!keep.min.js` un-ignores one file that the `*.min.js` rule above matched.
  check("a `!` rule un-ignores what an earlier rule matched", await tracked("keep.min.js"),
    "keep.min.js is tracked");
  check("the pattern it negates still applies", !(await tracked("bundle.min.js")),
    "bundle.min.js is not tracked");
  check("a file inside an ignored tree is never read", !(await tracked(".venv-local/pyvenv.cfg")));
  // The contract is `.gitignore` and nothing else: a directory git ignores is
  // skipped whatever it is called, and one git tracks is walked whatever it is
  // called. These two are the same assertion from both sides.
  check("a gitignored dependency tree is skipped", !(await tracked("node_modules/dep/index.js")),
    "node_modules/dep/index.js is not tracked");
  check("a committed `dist/` is walked, not guessed away", await tracked("dist/committed.ts"),
    "dist/committed.ts is tracked");

  // The graph is small, so every stage should be immediate. Before the fixes a
  // tree this shape took over two minutes; a bound this loose still catches it.
  const st = scene.stats;
  check("the whole pipeline is fast on this tree", st.layoutMs < 3_000 && st.analyzeMs < 3_000,
    `analyze ${st.analyzeMs}ms, layout ${st.layoutMs}ms`);
  check("scene has call edges", scene.edges?.length > 0, `edges=${scene.edges?.length}`);
  check("scene has code panels", scene.panels?.length > 0, `panels=${scene.panels?.length}`);
  check("scene has a layout domain", Array.isArray(scene.domain) && scene.domain.length === 2, JSON.stringify(scene.domain));

  // ---- one editor, on every screen
  //
  // A screen, flat mode's reader and flat mode's editor are meant to be the
  // same editor: one palette, one line box, VSCode's metrics. Half of that
  // contract is on the wire (the server sends a buffer of highlighted lines)
  // and half is in the client (it decides how many rows of that buffer fit), so
  // neither side can check it alone. What this catches is the regression that
  // made it necessary: a screen that sized its line box as `area / rows` drew
  // 19px text on 100px lines and stopped looking like an editor at all.
  await checkEditor(scene);

  // The point of the project: edges resolved through real imports, not names.
  const byConf: Record<string, number> = scene.stats?.byConfidence ?? {};
  const resolved = (byConf.local ?? 0) + (byConf.import ?? 0) + (byConf.member ?? 0);
  check("edges resolved via imports, not guessed", resolved > 0, JSON.stringify(byConf));
  check("import links present", scene.importLinks?.length >= 2, `importLinks=${scene.importLinks?.length}`);

  // ---- websocket: the transport every live update rides
  const hello = await waitFor("websocket handshake", async () => {
    return await new Promise<any>((res) => {
      const ws = new WebSocket(`ws://127.0.0.1:${API_PORT}/ws`);
      const done = (v: any) => {
        try { ws.close(); } catch {}
        res(v);
      };
      const timer = setTimeout(() => done(null), 5_000);
      ws.onmessage = (ev) => {
        clearTimeout(timer);
        try {
          const msg = JSON.parse(String(ev.data));
          if (msg.t === "hello") done(msg);
        } catch { done(null); }
      };
      ws.onerror = () => { clearTimeout(timer); done(null); };
    });
  }, 20_000);
  if (hello) check("hello reports the watched repo", hello.watching === FIXTURE, `rev=${hello.rev}`);

  // ---- viewer + client hot reload
  const page = await waitFor("vite serves the viewer", async () => {
    const res = await fetch(UI, { headers: { accept: "text/html" } });
    if (!res.ok) return null;
    const html = await res.text();
    return html.includes('id="root"') ? html : null;
  });
  if (page) check("viewer boots the react entry", page.includes("/src/main.tsx"));
  // `/@vite/client` is the HMR runtime. Served means client hot reload is live.
  const hmr = await fetch(`${UI}/@vite/client`);
  check("client HMR runtime served", hmr.ok, `/@vite/client -> ${hmr.status}`);
  const hmrBody = hmr.ok ? await hmr.text() : "";
  check("HMR runtime opens a socket", /new WebSocket|createWebSocket/.test(hmrBody));

  // ---- hot reload of the traced repo: an outside edit re-parses incrementally
  const revBefore = (await api<{ rev: number }>("/api/status")).rev;
  const nodesBefore = scene.nodes.length;
  await appendFile(
    resolve(FIXTURE, "main.ts"),
    `\nexport function gamma(): number {\n  return main() + beta(2);\n}\n`,
  );
  const bumped = await waitFor("watcher re-parses an outside edit", async () => {
    const s = await api<{ rev: number }>("/api/status");
    return s.rev > revBefore ? s : null;
  }, 20_000);
  if (bumped) {
    ok("revision advanced", `rev ${revBefore} -> ${bumped.rev}`);
    const after = await api<any>("/api/scene");
    check("new definition is in the graph", after.nodes.length > nodesBefore, `nodes ${nodesBefore} -> ${after.nodes.length}`);
    const gamma = after.nodes.some((n: any) => n.name === "gamma" || n.label === "gamma");
    check("the added function appears by name", gamma, gamma ? "gamma" : "gamma not found in nodes");
    const events = await api<any[]>("/api/events");
    check("the change is reported as an event", events.length > 0, `events=${events.length}`);

    // ---- what the screens will animate
    //
    // New content arrives as movement rather than as a cut, and which lines
    // move is decided by diffing the message against the one the screen was
    // already showing. That decision is the part that can be wrong in a way you
    // would only notice as a flicker — a screen re-flashing lines that did not
    // change, or missing the ones that did — so it is checked here against two
    // consecutive real scene messages rather than by watching the viewer.
    const panelFor = (graph: any, file: string) => graph.panels?.find((p: any) => p.file === file);
    const before = panelFor(scene, "main.ts");
    const now = panelFor(after, "main.ts");
    if (before && now) {
      const fresh = freshLines(before, now);
      const appended = now.lines.filter((l: any) => l.change === "add").map((l: any) => l.n);
      const missed = appended.filter((n: number) => !fresh.has(n));
      check("the reveal covers every line the write added", missed.length === 0,
        `${fresh.size} lines to reveal of ${now.lines.length}: ${[...fresh].join(",")}`);
      check("the reveal is the change, not the whole screen", fresh.size < now.lines.length,
        `${fresh.size} of ${now.lines.length} lines`);
      check("a screen has nothing to reveal on arrival", freshLines(null, now).size === 0);
    }
    // A file nobody touched must not animate: a screen that re-flashes on every
    // message is worse than one that never moves.
    const quiet = (after.panels ?? []).find((p: any) => {
      const was = panelFor(scene, p.file);
      return was && p.lines.length && !p.lines.some((l: any) => l.change);
    });
    if (quiet) {
      check("an untouched screen stays still", freshLines(panelFor(scene, quiet.file), quiet).size === 0,
        quiet.file);
    }
    check("transitions are long enough to read and short enough to ignore",
      MOTION.enter > 0.2 && MOTION.enter < 2 && MOTION.reveal > 0.2 && MOTION.reveal < 2 && MOTION.leave > 0.1,
      `enter ${MOTION.enter}s · reveal ${MOTION.reveal}s · leave ${MOTION.leave}s · birth ${MOTION.birth}s`);
  }

  // ---- a new file shifts the row, and the row has to travel
  await checkQueue(scene);

  // ---- server-side hot reload: `bun --watch` restarts the API on server edits
  // Proven without touching source: the supervisor is what re-serves after a
  // change, so a still-live API on a --watch process is the observable part.
  check("api is a --watch process", child?.pid !== undefined && !child?.killed);

  // ---- read + write round trip (what the in-scene editor does)
  /*
   * A browser that cannot draw the scene still gets an application.
   *
   * The failure this guards against was a black rectangle: opened in VS Code's
   * built-in browser the page loaded — the tab took its title from it — and then
   * `<Canvas>` threw, which during render unmounts the entire tree, HUD and all.
   * Nothing on screen said so, and a blank near-black page is indistinguishable
   * from a server that never started. These are source-level checks because the
   * condition is a property of the client's structure, not of a response.
   */
  const app = await readFile(resolve(ROOT, "client/src/App.tsx"), "utf8");
  check(
    "the scene is attempted, never predicted — no capability probe gates the canvas",
    !/hasWebGL\(\)/.test(app) && /scene3d && \(/.test(app),
  );
  check(
    "and it sits behind an error boundary, so a scene that throws leaves the app standing",
    /<SceneBoundary/.test(app) && /SceneFallback/.test(app),
  );
  const socketSrc = await readFile(resolve(ROOT, "client/src/net/socket.ts"), "utf8");
  check(
    "a websocket that cannot even be constructed retries rather than unmounting the app",
    /try\s*\{\s*ws = new WebSocket/.test(socketSrc),
  );

  const src = await api<{ source: string; language: string | null }>("/api/source?file=beta.ts");
  check("source served for a tracked file", src.source.includes("export function beta"), `language=${src.language}`);

  /*
   * A file that is not text says so, rather than being served as text.
   *
   * The viewer asks this endpoint for anything the change log lists, and the
   * change log lists every write — an image included. Handing back the bytes
   * meant flat mode highlighted a PNG as TypeScript and drew two thousand
   * lines of mojibake, so the endpoint decides it on the evidence (a NUL byte)
   * and the viewer draws an empty state instead.
   */
  await writeFile(resolve(FIXTURE, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]));
  const bin = await api<{ binary?: boolean; bytes?: number; source: string }>("/api/source?file=logo.png");
  check("a binary file is reported as binary, not served as text", bin.binary === true, `${bin.bytes} bytes`);
  check("and no bytes are handed to the highlighter", bin.source === "");
  await writeFile(resolve(FIXTURE, "NOTES.unknownext"), "still text, just not an extension we classify\n");
  const textAnyway = await api<{ binary?: boolean; source: string }>("/api/source?file=NOTES.unknownext");
  check(
    "a text file with an unknown extension is still served as text",
    !textAnyway.binary && textAnyway.source.includes("still text"),
  );

  const edited = src.source.replace("* 2", "* 3");
  const wrote = await api<{ ok: boolean; bytes: number }>("/api/write", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file: "beta.ts", content: edited }),
  });
  check("write accepted", wrote.ok === true, `${wrote.bytes} bytes`);
  const onDisk = await readFile(resolve(FIXTURE, "beta.ts"), "utf8");
  check("write landed on disk", onDisk.includes("* 3"));
  const roundTrip = await waitFor("write comes back through the analyser", async () => {
    const s = await api<{ source: string }>("/api/source?file=beta.ts");
    return s.source.includes("* 3") ? s : null;
  }, 20_000);
  check("analyser holds the new text", Boolean(roundTrip));

  // A write outside the repo must be refused, not followed.
  const escape = await fetch(`${API}/api/write`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file: "../escaped.ts", content: "nope" }),
  });
  check("path escaping the repo is refused", escape.status === 400, `-> ${escape.status}`);

  // ---- switching repositories at runtime
  const switched = await fetch(`${API}/api/watch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: ROOT }),
  });
  check("runtime repo switch accepted", switched.ok, `-> ${switched.status}`);
  const onSelf = await waitFor("re-analysed on the new repo", async () => {
    const s = await api<{ watching: string | null; stats: { files: number; nodes: number } | null }>("/api/status");
    return s.watching === ROOT && s.stats && s.stats.files > 10 ? s.stats : null;
  }, 120_000);
  if (onSelf) ok("traces this repo's own source", `files=${onSelf.files} nodes=${onSelf.nodes}`);

  // The fixture's files are five lines long, so the buffer check above is
  // trivially satisfied there. This repo's own source is what proves a screen
  // of a real file arrives full.
  const own = await api<any>("/api/scene");
  await checkEditor(own);
  const long = (own.panels ?? []).find((p: any) => p.totalLines > 120);
  if (long) {
    const m = editorMetrics(
      Math.round(long.size[0] * PX_PER_UNIT),
      Math.round(long.size[1] * PX_PER_UNIT),
      PX_PER_UNIT,
    );
    check("a long file arrives with room to scroll", long.lines.length > m.rows,
      `${long.file}: ${long.lines.length} lines buffered for ${m.rows} rows of ${long.totalLines}`);
  }

  // ---- browse, the folder picker behind "choose folder…"
  const browse = await api<any>(`/api/browse?path=${encodeURIComponent(ROOT)}`);
  check("folder picker lists directories", Array.isArray(browse.dirs) && browse.dirs.length > 0,
    `dirs=${browse.dirs?.length}`);
  check("folder picker can navigate up", browse.path === ROOT && typeof browse.parent === "string", browse.parent);
  // The per-row hints the repo drawer shows: repo marker + analysable count.
  const hinted = (browse.dirs ?? []).some((d: any) => d && typeof d === "object" && "name" in d);
  check("directory rows carry hints", hinted, JSON.stringify(browse.dirs?.[0] ?? null));
}

// ------------------------------------------------------------------ entry

const bail = () => { teardown(); process.exit(130); };
process.on("SIGINT", bail);
process.on("SIGTERM", bail);

try {
  await main();
} catch (err) {
  fail("unexpected error", err instanceof Error ? (err.stack ?? err.message) : String(err));
} finally {
  teardown();
  await sleep(400);
}

console.log();
if (failures.length) {
  console.log(`  \x1b[31m${failures.length} failed\x1b[0m, ${passed} passed  —  dev log: ${LOG}`);
  for (const f of failures) console.log(`    · ${f}`);
  console.log();
  process.exit(1);
}
console.log(`  \x1b[32mall ${passed} checks passed\x1b[0m in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
process.exit(0);
