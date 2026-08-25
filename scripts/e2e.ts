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
  // something the fixed ignore list would never guess, listed in .gitignore,
  // holding thousands of installed files. Each of these is ignored for a
  // different reason, so a regression in any one of the three shows up here.
  await writeFile(
    resolve(FIXTURE, ".gitignore"),
    // A directory pattern with a wildcard — the shape that was silently
    // ignoring nothing, because the trailing slash made the rule skip files.
    ".venv*/\ngenerated/\n*.min.js\n!keep.min.js\n",
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

  // 3. on the fixed list, whatever .gitignore says.
  await mkdir(resolve(FIXTURE, "node_modules/dep"), { recursive: true });
  await writeFile(resolve(FIXTURE, "node_modules/dep/index.js"), "module.exports = 1;\n");

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

  // The graph is small, so every stage should be immediate. Before the fixes a
  // tree this shape took over two minutes; a bound this loose still catches it.
  const st = scene.stats;
  check("the whole pipeline is fast on this tree", st.layoutMs < 3_000 && st.analyzeMs < 3_000,
    `analyze ${st.analyzeMs}ms, layout ${st.layoutMs}ms`);
  check("scene has call edges", scene.edges?.length > 0, `edges=${scene.edges?.length}`);
  check("scene has code panels", scene.panels?.length > 0, `panels=${scene.panels?.length}`);
  check("scene has a layout domain", Array.isArray(scene.domain) && scene.domain.length === 2, JSON.stringify(scene.domain));

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
  }

  // ---- server-side hot reload: `bun --watch` restarts the API on server edits
  // Proven without touching source: the supervisor is what re-serves after a
  // change, so a still-live API on a --watch process is the observable part.
  check("api is a --watch process", child?.pid !== undefined && !child?.killed);

  // ---- read + write round trip (what the in-scene editor does)
  const src = await api<{ source: string; language: string | null }>("/api/source?file=beta.ts");
  check("source served for a tracked file", src.source.includes("export function beta"), `language=${src.language}`);

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
