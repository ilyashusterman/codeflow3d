/**
 * The live pipeline, end to end over a real socket.
 *
 * These are integration tests on purpose. Every bug this file exists to catch
 * was invisible to a unit test: a cached graph handing out stale line numbers,
 * a watcher reporting one write twice, a panel signature that compared equal
 * for two different edits. They only show up once a real save travels through
 * a real server to a real client.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 7931;
let root: string;
let proc: ReturnType<typeof Bun.spawn>;
let ws: WebSocket;
const inbox: any[] = [];

const HTTP_TS = `const BASE = "https://api.example.com";

export function buildUrl(path: string): string {
  return \`\${BASE}\${path}\`;
}

export async function parseBody(res: Response) {
  return res.json();
}
`;

const CLIENT_TS = `import { buildUrl, parseBody } from "./http";

export async function fetchUser(id: number) {
  return parseBody(await fetch(buildUrl(\`/users/\${id}\`)));
}
`;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "codeflow3d-live-"));
  await Bun.write(join(root, "src/http.ts"), HTTP_TS);
  await Bun.write(join(root, "src/client.ts"), CLIENT_TS);
  await Bun.write(join(root, "package.json"), '{ "name": "fixture" }\n');

  proc = Bun.spawn(["bun", "server/index.ts"], {
    env: { ...process.env, PORT: String(PORT) },
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`http://localhost:${PORT}/api/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(50);
  }

  ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  await new Promise<void>((r) => (ws.onopen = () => r()));
  ws.onmessage = (e) => inbox.push(JSON.parse(String(e.data)));
  ws.send(JSON.stringify({ t: "watch", path: root }));
  await Bun.sleep(900);
}, 60_000);

afterAll(async () => {
  ws?.close();
  proc?.kill();
  if (root) await rm(root, { recursive: true, force: true });
});

/** Collect everything that arrives while `act` runs, plus a settling window. */
async function capture(act: () => Promise<unknown>, settle = 500) {
  inbox.length = 0;
  await act();
  await Bun.sleep(settle);
  return [...inbox];
}

const scene = () => fetch(`http://localhost:${PORT}/api/scene`).then((r) => r.json());
const panelsIn = (m: any) => (m.t === "scene" ? m.scene.panels : (m.panels ?? []));
const textOf = (p: any) =>
  p.lines.map((l: any) => l.spans.map((s: any) => s.t).join("")).join("\n");

test("a save reaches the client", async () => {
  const msgs = await capture(() =>
    writeFile(join(root, "src/http.ts"), HTTP_TS.replace("example.com", "example.org")),
  );
  const hit = msgs.find((m) => panelsIn(m).some((p: any) => textOf(p).includes("example.org")));
  expect(hit).toBeDefined();
}, 30_000);

test("one write produces exactly one feed entry", async () => {
  const msgs = await capture(async () => {
    for (let i = 0; i < 5; i++) {
      await writeFile(join(root, "src/http.ts"), HTTP_TS.replace("example.com", `host-${i}.test`));
      await Bun.sleep(220);
    }
  });
  const events = msgs
    .flatMap((m) => m.events ?? [])
    .filter((e: any) => e.path === "src/http.ts" && !e.duplicate);
  // The hot-file poll and chokidar both see every write; only one may survive.
  expect(events.length).toBe(5);
}, 30_000);

test("an edit that changes no rendered line sends nothing", async () => {
  const body = await Bun.file(join(root, "src/http.ts")).text();
  const msgs = await capture(() => writeFile(join(root, "src/http.ts"), body));
  expect(msgs.filter((m) => m.t === "patch" || m.t === "scene")).toHaveLength(0);
}, 30_000);

test("inserting lines moves the node stamps but reuses the geometry", async () => {
  const body = await Bun.file(join(root, "src/http.ts")).text();
  const before = await scene();
  const stamps = (s: any) =>
    s.nodes
      .filter((n: any) => n.file === "src/http.ts")
      .map((n: any) => `${n.name}@${n.startLine}`)
      .sort()
      .join(" ");
  const geometry = (s: any) => JSON.stringify(s.streamlines);

  await writeFile(join(root, "src/http.ts"), "\n\n\n" + body);
  await Bun.sleep(600);
  const after = await scene();

  // Every definition slid down by exactly three lines...
  const expected = stamps(before).replace(/@(\d+)/g, (_m: string, n: string) => `@${Number(n) + 3}`);
  expect(stamps(after)).toBe(expected);
  // ...while the streamlines, which are 60% of a scene message, did not move.
  expect(geometry(after)).toBe(geometry(before));
}, 30_000);

test("a structural edit does re-send the geometry", async () => {
  const before = await scene();
  await writeFile(
    join(root, "src/client.ts"),
    CLIENT_TS + '\nexport function fetchTeam(id: number) {\n  return buildUrl(`/teams/${id}`);\n}\n',
  );
  await Bun.sleep(600);
  const after = await scene();
  expect(after.stats.nodes).toBeGreaterThan(before.stats.nodes);
  expect(JSON.stringify(after.streamlines)).not.toBe(JSON.stringify(before.streamlines));
}, 30_000);

test("a pushed buffer shows unsaved text without touching disk", async () => {
  const abs = join(root, "src/http.ts");
  const onDisk = await Bun.file(abs).text();
  const msgs = await capture(() =>
    fetch(`http://localhost:${PORT}/api/buffer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Absolute, the way an editor knows the file.
      body: JSON.stringify({ file: abs, content: "const MARKER = 1;\n" }),
    }),
  );
  const panel = msgs.flatMap(panelsIn).find((p: any) => textOf(p).includes("MARKER"));
  expect(panel).toBeDefined();
  expect(panel.unsaved).toBe(true);
  expect(await Bun.file(abs).text()).toBe(onDisk);

  await fetch(`http://localhost:${PORT}/api/buffer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file: abs, content: null }),
  });
}, 30_000);

test("a buffer from another project is ignored, not rejected", async () => {
  const res = await fetch(`http://localhost:${PORT}/api/buffer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file: "/etc/hosts", content: "nope" }),
  });
  // An editor streams every buffer it has; an error here would make it back off.
  expect(res.status).toBe(200);
  expect((await res.json()).ignored).toBeTruthy();
}, 30_000);

test("a new file earns a screen", async () => {
  const msgs = await capture(() =>
    writeFile(join(root, "src/retry.ts"), 'import { buildUrl } from "./http";\n\nexport function retryUrl(p: string) {\n  return buildUrl(p);\n}\n'),
  );
  const panel = msgs.flatMap(panelsIn).find((p: any) => p.file === "src/retry.ts");
  expect(panel).toBeDefined();
}, 30_000);

test("a deleted file leaves the graph", async () => {
  const before = await scene();
  await rm(join(root, "src/retry.ts"));
  await Bun.sleep(600);
  const after = await scene();
  expect(after.stats.files).toBe(before.stats.files - 1);
  expect(after.panels.some((p: any) => p.file === "src/retry.ts")).toBe(false);
}, 30_000);

test("nothing is broadcast while idle", async () => {
  const msgs = await capture(async () => {}, 3000);
  expect(msgs.filter((m) => m.t === "patch" && (m.nodes || m.streamlines))).toHaveLength(0);
}, 30_000);
