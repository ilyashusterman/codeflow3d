/**
 * Runs the Bun API/watcher and the Vite dev server together.
 *
 * Vite owns the browser-facing port (the harness may pin it via PORT); the API
 * always sits on API_PORT so the proxy target in vite.config.ts stays valid.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(new URL(".", import.meta.url).pathname, "..");
// No argument: trace this project's own source. Pass a path to point it
// anywhere else, or switch repositories from the viewer at runtime.
const target = process.argv[2] ?? process.env.CODEFLOW_PATH ?? root;
const apiPort = process.env.API_PORT ?? "5189";
const uiPort = process.env.PORT ?? "5188";

// The child API server must not inherit PORT, or it fights Vite for it.
const serverEnv = { ...process.env };
delete serverEnv.PORT;

const procs = [
  spawn("bun", ["--watch", "server/index.ts", "--path", target, "--port", apiPort], {
    cwd: root,
    stdio: "inherit",
    env: serverEnv,
  }),
  spawn("bunx", ["--bun", "vite", "--config", "client/vite.config.ts", "--port", uiPort, "--host", "127.0.0.1"], {
    cwd: root,
    stdio: "inherit",
  }),
];

const bye = () => {
  for (const p of procs) p.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", bye);
process.on("SIGTERM", bye);
for (const p of procs) p.on("exit", (code) => code && bye());

console.log(`\n  viewer  http://localhost:${uiPort}\n  api     http://localhost:${apiPort}\n  target  ${target}\n`);
