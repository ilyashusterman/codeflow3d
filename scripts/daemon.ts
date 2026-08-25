/**
 * Background lifecycle for the dev stack: start it detached, or report on it.
 *
 * This lives here rather than in the Makefile because macOS ships GNU Make
 * 3.81, which ignores `.ONESHELL` — every recipe line would be its own shell,
 * so a guard clause could not stop the lines after it. Detaching also has to be
 * done properly: a backgrounded shell keeps the caller's stdout open, and
 * `make up` would never return. Spawned with its own session and the log as
 * stdio, nothing is left holding anything.
 *
 *   PORT=5188 API_PORT=5189 bun scripts/daemon.ts start [repo]
 *   bun scripts/daemon.ts status
 */
import { spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const RUN_DIR = resolve(ROOT, ".run");
const LOG = resolve(RUN_DIR, "dev.log");
const PIDFILE = resolve(RUN_DIR, "dev.pid");
const UI_PORT = process.env.PORT ?? "5188";
const API_PORT = process.env.API_PORT ?? "5189";
const API = `http://127.0.0.1:${API_PORT}`;

const sleep = (n: number) => new Promise((r) => setTimeout(r, n));

async function apiStatus(timeoutMs = 1000): Promise<any | null> {
  try {
    const res = await fetch(`${API}/api/status`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** True if anything at all is accepting connections on that port. */
async function portTaken(port: string): Promise<boolean> {
  try {
    const socket = await Bun.connect({ hostname: "127.0.0.1", port: Number(port), socket: { data() {} } });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

function pid(): number | null {
  if (!existsSync(PIDFILE)) return null;
  const n = Number(readFileSync(PIDFILE, "utf8").trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  try {
    process.kill(n, 0);
    return n;
  } catch {
    return null;
  }
}

async function start(repo: string | undefined) {
  // A listening port is the honest test — it also catches a stack started with
  // `make run` in another terminal, which leaves no pidfile behind.
  if ((await portTaken(UI_PORT)) || (await portTaken(API_PORT))) {
    console.log(`already running on ${UI_PORT}/${API_PORT} — \`make restart\` to replace it`);
    return 0;
  }

  mkdirSync(RUN_DIR, { recursive: true });
  const log = openSync(LOG, "a");
  const child = spawn("bun", ["scripts/dev.ts", ...(repo ? [repo] : [])], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  if (!child.pid) {
    console.error("failed to spawn the dev stack");
    return 1;
  }
  writeFileSync(PIDFILE, String(child.pid));
  child.unref();

  for (let i = 0; i < 120; i++) {
    const s = await apiStatus();
    if (s) {
      const files = s.stats?.files ?? 0;
      console.log(`up  viewer http://localhost:${UI_PORT}  api http://localhost:${API_PORT}`);
      console.log(`    pid ${child.pid}  watching ${s.watching ?? "(nothing yet)"}${files ? `  ${files} files` : ""}`);
      console.log(`    log ${LOG}`);
      return 0;
    }
    // The dev stack dying early is the common failure; say so instead of waiting.
    try {
      process.kill(child.pid, 0);
    } catch {
      console.error(`the dev stack exited during startup — last lines of ${LOG}:\n`);
      console.error(tailLog());
      return 1;
    }
    await sleep(500);
  }
  console.error(`API never answered on ${API_PORT} — last lines of ${LOG}:\n`);
  console.error(tailLog());
  return 1;
}

function tailLog(lines = 20): string {
  if (!existsSync(LOG)) return "(no log)";
  return readFileSync(LOG, "utf8").split("\n").slice(-lines).join("\n");
}

async function status() {
  const p = pid();
  console.log(`  pidfile  ${p ? `${p} (running)` : "no live process"}`);
  for (const [name, port] of [["viewer", UI_PORT], ["api", API_PORT]] as const) {
    console.log(`  ${name.padEnd(8)} port ${port} ${(await portTaken(port)) ? "listening" : "free"}`);
  }
  const s = await apiStatus(2000);
  // Reporting "not running" is a successful answer to `make status`, not a
  // failure — exiting non-zero would make it look like a broken build step.
  if (!s) {
    console.log(`  api      not answering — \`make up\` to start it`);
    return 0;
  }
  const st = s.stats;
  console.log(`  watching ${s.watching ?? "(nothing)"}  rev ${s.rev}  clients ${s.clients}`);
  if (st) {
    console.log(`  graph    ${st.files} files, ${st.nodes} defs, ${st.edges} calls, ${st.entryPoints} entry points`);
    console.log(`  resolved ${JSON.stringify(st.byConfidence)}`);
  }
  return 0;
}

const cmd = process.argv[2] ?? "start";
const code = cmd === "status" ? await status() : await start(process.argv[3]);
process.exit(code);
