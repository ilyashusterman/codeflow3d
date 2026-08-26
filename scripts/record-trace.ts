/**
 * Record the README's live-trace GIF, for real.
 *
 * The recording in the README is the one thing about this project nobody can
 * check by reading the source: it claims that files arrive as movement while an
 * agent writes them. So it is recorded the same way it is claimed — by booting
 * the actual stack against a throwaway repository, writing real files into it
 * on a schedule, and filming the viewer while it reacts. Nothing is staged in
 * the client, and no frame is drawn by anything but the app.
 *
 *   bun scripts/record-trace.ts            # docs/live-trace.gif
 *   bun scripts/record-trace.ts --stills   # the stills in docs/architecture.md
 *   bun scripts/record-trace.ts --out x.gif --seconds 14 --show
 *
 * Requires Google Chrome (driven over the DevTools Protocol — no browser
 * automation dependency) and ffmpeg (frames to GIF). Both are checked up
 * front so a missing one fails in a second rather than after the take.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, rm, writeFile, appendFile, utimes, link } from "node:fs/promises";
import { resolve, join } from "node:path";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const RUN = resolve(ROOT, ".run");
const STAGE = resolve(RUN, "stage/codeflow3d"); // the repository being "worked on"
const RAW = resolve(RUN, "record-raw");
const FRAMES = resolve(RUN, "record-frames");
const LOG = resolve(RUN, "record.log");

const CHROME = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

// ------------------------------------------------------------------ options

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
};
const OPT = {
  out: resolve(ROOT, flag("out", "docs/live-trace.gif")),
  /*
   * Wide enough for the strip along the bottom to be the whole strip.
   *
   * The recording this replaces was 880×550, and at 880 CSS pixels the HUD
   * sheds almost everything it has to say — no counts, no legend, no latest
   * write — so the GIF showed a bar with four buttons on it. 1160 is the first
   * width at which the read-outs, the colour ramp and the controls are all
   * present, which is the layout worth recording.
   */
  width: Number(flag("width", "1160")),
  height: Number(flag("height", "725")),
  fps: Number(flag("fps", "12.5")),
  seconds: Number(flag("seconds", "14")),
  /** Retina capture, downscaled by ffmpeg — small text has to stay readable. */
  scale: Number(flag("scale", "2")),
  uiPort: flag("ui-port", "5388"),
  apiPort: flag("api-port", "5389"),
  show: argv.includes("--show"),
  keepFrames: argv.includes("--keep-frames"),
  noPulses: argv.includes("--no-pulses"),
  stills: argv.includes("--stills"),
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (msg: string) => console.log(`  ${msg}`);

// ------------------------------------------------------------------- the set
//
// The stage is a copy of this repository's own tracked files — the same thing
// `bun run dev` traces by default. A synthetic fixture was tried first and it
// looked wrong for two reasons that matter: a seven-file graph has nothing to
// bundle into streamlines, and files written seconds ago are all *hot*, so the
// whole scene came out warm and the arrivals had nothing cool to arrive into.
//
// So the copy is backdated. The analyser reads real disk mtimes precisely so a
// cold repository renders cold, and that is what gives the take its subject:
// settled blue code, and the writes landing on it warm.

const SETTLED_AGE_MS = 6 * 60 * 60 * 1000;

async function stageRepo() {
  await rm(resolve(STAGE, ".."), { recursive: true, force: true });
  await mkdir(STAGE, { recursive: true });

  const tracked = Bun.spawnSync(["git", "ls-files"], { cwd: ROOT }).stdout.toString().trim().split("\n");
  const when = new Date(Date.now() - SETTLED_AGE_MS);
  let copied = 0;
  for (const rel of tracked) {
    // The recording itself is tracked, and a 3 MB GIF is not source.
    if (!rel || rel.startsWith("docs/")) continue;
    const from = Bun.file(resolve(ROOT, rel));
    if (!(await from.exists())) continue;
    const to = join(STAGE, rel);
    await mkdir(resolve(to, ".."), { recursive: true });
    await Bun.write(to, from);
    await utimes(to, when, when);
    copied++;
  }
  return copied;
}

/**
 * The take, as a script.
 *
 * Each beat is a real write into the staged repository, spaced so the viewer
 * has time to finish the movement the previous one started — a new screen
 * slides into the row, the others travel to their new slots, and the write
 * reveals itself line by line. `at` is milliseconds from the first frame.
 *
 * The writes are plausible additions to the thing being traced, and they import
 * from it, so each arrival lands somewhere real in the graph rather than
 * floating on its own.
 */
const BEATS: { at: number; file: string; append?: string; content?: string; note: string }[] = [
  {
    at: 1200,
    file: "client/src/lib/ease.ts",
    note: "a new module arrives",
    content: `/**
 * The curves the HUD moves on.
 *
 * Kept next to the motion constants rather than in the stylesheet: the DOM
 * chrome and the canvas screens are supposed to move on the same timing, and
 * two lists of magic numbers drift.
 */
export const EASE = {
  out: (t: number) => 1 - Math.pow(1 - t, 3),
  inOut: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  drawer: (t: number) => 1 - Math.pow(1 - t, 4),
} as const;

export function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
`,
  },
  {
    at: 3500,
    file: "client/src/lib/motion.ts",
    note: "an existing file is edited — the write reveals itself line by line",
    append: `
/** Where a screen is along its glide, on the drawer curve rather than linearly. */
export function glideEased(from: number, to: number, t: number): number {
  const k = Math.min(1, Math.max(0, t));
  return from + (to - from) * (1 - Math.pow(1 - k, 4));
}
`,
  },
  {
    at: 5800,
    file: "client/src/lib/rhythm.ts",
    note: "another arrival, pushing the row along",
    content: `import { MOTION } from "./motion";

/**
 * How long the HUD waits before it believes the camera has stopped.
 *
 * Long enough that a pause mid-flight does not flash the chrome back on, short
 * enough that letting go of the keys feels like it did something.
 */
export const SETTLE_MS = 260;

export function queued(index: number, gap = MOTION.slot): number {
  return index * gap * 500;
}

export function settled(sinceMs: number): boolean {
  return sinceMs > SETTLE_MS;
}
`,
  },
  {
    at: 8100,
    file: "client/src/lib/colormap.ts",
    note: "a second edit, deeper in the graph",
    append: `
/** The ramp as CSS stops, for the strip along the bottom of the HUD. */
export function rampStops(steps = 12): string[] {
  return Array.from({ length: steps }, (_, i) => \`\${((i / (steps - 1)) * 100).toFixed(0)}%\`);
}
`,
  },
  {
    at: 10200,
    file: "client/src/ui/Reticle.tsx",
    note: "the entry point picks the new code up",
    content: `import { EASE } from "../lib/ease";
import { useStore } from "../state/store";

/**
 * The crosshair, sized by how fast you are moving.
 *
 * A fixed reticle reads as a sticker on the glass; one that opens up under
 * speed reads as part of the instrument.
 */
export function Reticle() {
  const moving = useStore((s) => s.moving);
  const spread = EASE.out(moving ? 1 : 0) * 4;
  return (
    <div className="crosshair" style={{ transform: \`scale(\${1 + spread / 14})\` }} />
  );
}
`,
  },
  {
    at: 11900,
    file: "client/src/lib/depth.ts",
    note: "one more arrival — the row is full, so a screen leaves",
    content: `import { mix } from "./ease";

/** How far back a screen sits, per arrangement. */
export function lane(index: number, layout: "stagger" | "wall" | "arc"): number {
  if (layout === "wall") return 0;
  if (layout === "arc") return mix(0, 1.4, Math.abs(index - 2) / 2);
  return index * 0.9;
}
`,
  },
];

// ------------------------------------------------------------- prerequisites

async function chromePath(): Promise<string> {
  for (const p of CHROME) if (await Bun.file(p).exists()) return p;
  const which = Bun.spawnSync(["sh", "-c", "command -v google-chrome-stable || command -v chromium || true"]);
  const found = which.stdout.toString().trim();
  if (found) return found;
  throw new Error("Google Chrome or Chromium is required to record — install one, or record by hand");
}

// ---------------------------------------------------------------- the stack

let stack: ChildProcess | null = null;

async function bootStack() {
  const copied = await stageRepo();
  log(`staged ${copied} tracked files, backdated ${SETTLED_AGE_MS / 3_600_000}h so the repo renders settled`);
  const writer = Bun.file(LOG).writer();
  stack = spawn("bun", ["scripts/dev.ts", STAGE], {
    cwd: ROOT,
    env: { ...process.env, PORT: OPT.uiPort, API_PORT: OPT.apiPort },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  for (const s of [stack.stdout, stack.stderr]) s?.on("data", (b: Buffer) => writer.write(b));

  const until = Date.now() + 90_000;
  while (Date.now() < until) {
    try {
      const res = await fetch(`http://127.0.0.1:${OPT.apiPort}/api/scene`);
      if (res.ok) {
        const scene: any = await res.json();
        if (scene?.stats?.files > 0) return scene;
      }
    } catch {}
    await sleep(400);
  }
  throw new Error(`the stack never came up — see ${LOG}`);
}

function killStack() {
  if (!stack?.pid) return;
  try {
    process.kill(-stack.pid, "SIGTERM");
  } catch {
    try { stack.kill("SIGTERM"); } catch {}
  }
}

// ------------------------------------------------------- Chrome, over CDP
//
// A tiny DevTools Protocol client. Only four commands are needed, and writing
// them by hand keeps a browser-automation dependency out of a project whose
// only job is to watch files.

class Cdp {
  private ws: WebSocket;
  private next = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private handlers = new Map<string, (params: any) => void>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String((ev as MessageEvent).data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        this.handlers.get(msg.method)?.(msg.params);
      }
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("could not attach to Chrome")), { once: true });
    });
    return new Cdp(ws);
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.next++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise<T>((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  on(method: string, fn: (params: any) => void) {
    this.handlers.set(method, fn);
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

/** The page's websocket target, from Chrome's own HTTP endpoint. */
async function pageTarget(port: number): Promise<string> {
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    try {
      const list: any[] = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error("Chrome never reported a page target");
}

// -------------------------------------------------------------------- stills
//
// The five screenshots in docs/architecture.md are of the same surfaces this
// records, so they are taken from the same staged repository by the same
// browser rather than by hand. Otherwise they drift the moment the HUD changes
// — which is exactly what happened to the set they replace.

/*
 * Driven through the DOM, and idempotently.
 *
 * The first version toggled tabs, which meant a step that wanted the change log
 * open closed it instead whenever the previous step had left it open — and the
 * flat-mode screenshot came out as a picture of the scene. Each step now states
 * the state it wants rather than the click that usually gets there.
 */
const PAGE_HELPERS = `
  window.__shot = {
    tab(label) {
      return [...document.querySelectorAll('.hud-tabs button')].find((b) => b.textContent.startsWith(label));
    },
    open(label) {
      const b = window.__shot.tab(label);
      if (b && !b.classList.contains('on')) b.click();
    },
    closeAll() {
      const on = document.querySelector('.hud-tabs button.on');
      if (on) on.click();
      document.querySelector('.flat-close')?.click();
    },
    /** Poll for an element, then act on it. */
    when(selector, fn, tries = 25) {
      const el = document.querySelector(selector);
      if (el) return fn(el);
      if (tries > 0) setTimeout(() => window.__shot.when(selector, fn, tries - 1), 120);
    },
  };
`;

const STILLS: { name: string; note: string; steps: string }[] = [
  {
    name: "live-graph",
    note: "the wall, the call bundle and the module tree, no chrome open",
    steps: `window.__shot.closeAll();`,
  },
  {
    name: "repo-drawer",
    note: "the repo drawer: what is watched, what reports unsaved edits, edge confidence",
    steps: `window.__shot.closeAll(); window.__shot.open('repo');`,
  },
  {
    name: "change-log",
    note: "the changes drawer, with the diff under a row open",
    steps: `window.__shot.closeAll();
            window.__shot.open('changes');
            window.__shot.when('.ev button.ev-expand', (el) => el.click());`,
  },
  {
    name: "flat-editor",
    note: "a file open flat, at the line the screen was following",
    // A long file on purpose: the caption is about line numbers, the palette
    // and the flow rails, and an eighteen-line module shows one of the three.
    steps: `window.__shot.open('changes');
            window.__shot.when('.ev-path', () => {
              const rows = [...document.querySelectorAll('.ev-path')].map((b) => ({ b, p: b.textContent }));
              // The files this take just wrote are short by design. Prefer one
              // that was already there, and the deeper in the tree the better.
              const written = /(ease|rhythm|depth|motion|colormap|Reticle)\./;
              const settled = rows.filter((r) => !written.test(r.p) && /\.tsx?$/.test(r.p));
              const pick = settled.sort((a, b) => b.p.split('/').length - a.p.split('/').length)[0] ?? rows[0];
              pick?.b.click();
            });`,
  },
];

async function shootStills(cdp: Cdp, dir: string) {
  await cdp.send("Runtime.evaluate", { expression: PAGE_HELPERS });
  for (const still of STILLS) {
    await cdp.send("Runtime.evaluate", { expression: `(() => { ${still.steps} })()`, awaitPromise: false });
    // Long enough for a drawer to finish rising and for flat mode to fetch and
    // paint the file it was sent to.
    await sleep(1600);
    const shot = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(join(dir, `${still.name}.png`), Buffer.from(shot.data, "base64"));
    log(`  ${still.name}.png — ${still.note}`);
    await cdp.send("Runtime.evaluate", { expression: `document.querySelector('.flat-close')?.click();` });
    await sleep(700);
  }

  /*
   * The zoomed screen has to be driven through the canvas, because that is the
   * only way in: a double-click on a screen is what flies the camera until it
   * fills the frame. The wall layout puts a screen across the middle of the
   * window, so the middle of the window is where the click goes.
   */
  for (const y of [0.42, 0.5, 0.34]) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: OPT.width * 0.52, y: OPT.height * y, button: "left", clickCount: 2, buttons: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: OPT.width * 0.52, y: OPT.height * y, button: "left", clickCount: 2, buttons: 0 });
    await sleep(2600);
    const zoomed = await cdp.send<any>("Runtime.evaluate", {
      expression: `!!document.querySelector('.zoom-hud')`,
      returnByValue: true,
    });
    if (zoomed?.result?.value === true) break;
  }
  const shot = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
  await writeFile(join(dir, "screen-zoom.png"), Buffer.from(shot.data, "base64"));
  log(`  screen-zoom.png — one screen flown into until it fills the frame`);
}

// -------------------------------------------------------------------- record

async function record() {
  const chrome = await chromePath();
  const hasFfmpeg = Bun.spawnSync(["sh", "-c", "command -v ffmpeg"]).exitCode === 0;
  if (!hasFfmpeg) throw new Error("ffmpeg is required to assemble the GIF (brew install ffmpeg)");

  const scene = await bootStack();
  log(`stack up · ${scene.stats.files} files · ${scene.stats.nodes} defs · ${scene.stats.edges} calls`);

  const port = 9222 + (Number(OPT.uiPort) % 100);
  const profile = resolve(RUN, "record-chrome");
  await rm(profile, { recursive: true, force: true });
  const browser = spawn(
    chrome,
    [
      OPT.show ? "--new-window" : "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      `--window-size=${OPT.width},${OPT.height}`,
      // Software WebGL, so the take does not depend on which machine records it.
      "--enable-unsafe-swiftshader",
      "--hide-scrollbars",
      "--mute-audio",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=Translate,MediaRouter",
      `http://127.0.0.1:${OPT.uiPort}`,
    ],
    { stdio: "ignore", detached: true },
  );

  let cdp: Cdp | null = null;
  /*
   * Frames go to disk as they arrive, as PNG.
   *
   * Both halves of that matter. JPEG was the obvious choice and it made the GIF
   * six times larger than it needed to be: the screencast recompresses every
   * frame, so a completely still scene still differs everywhere by a unit or
   * two of luma, and GIF's frame differencing — which is the whole reason a
   * mostly-static clip can be small — finds no unchanged region to skip. PNG
   * frames of a still scene are bit-identical. And streaming them out keeps a
   * thirteen-second take from holding a couple of gigabytes of bitmaps in
   * memory at once.
   */
  const frames: { file: string; at: number }[] = [];
  let writing: Promise<unknown> = Promise.resolve();
  try {
    cdp = await Cdp.connect(await pageTarget(port));
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: OPT.width,
      height: OPT.height,
      deviceScaleFactor: OPT.scale,
      mobile: false,
    });

    /*
     * The composition, chosen rather than inherited.
     *
     * View settings are stored per repository in localStorage, so seeding that
     * key before the first paint is how the take gets a fixed framing. The one
     * that matters is `tail`: on by default, the camera glides toward whatever
     * just changed, which is right when you are watching an agent work and
     * wrong for a recording — every pixel in the frame is then in motion for
     * the whole clip, the arrivals stop reading as arrivals against a moving
     * background, and the GIF triples in size for the privilege.
     */
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `
        try {
          localStorage.setItem("codeflow3d.settings.v1", JSON.stringify({
            ${JSON.stringify(STAGE)}: {
              view: { tail: false, autoOrbit: false, screenLayout: "wall", preset: "cinematic"${OPT.noPulses ? ', pulses: false' : ""} },
              at: Date.now(),
            },
          }));
        } catch {}
      `,
    });
    await cdp.send("Page.reload", { ignoreCache: false });

    // Let the scene parse, lay out and settle before the camera rolls: the GIF
    // is about change arriving, and a still first frame is what makes the first
    // arrival read as movement.
    log("waiting for the viewer to settle…");
    const ready = Date.now() + 60_000;
    while (Date.now() < ready) {
      const r = await cdp.send<any>("Runtime.evaluate", {
        expression: `!!document.querySelector('canvas') && !document.querySelector('.boot') && document.querySelectorAll('.hud-bar').length === 1`,
        returnByValue: true,
      });
      if (r?.result?.value === true) break;
      await sleep(500);
    }
    await sleep(2500);

    await rm(RAW, { recursive: true, force: true });
    await mkdir(RAW, { recursive: true });

    let started = 0;
    let seq = 0;
    cdp.on("Page.screencastFrame", (p) => {
      const at = Date.now() - started;
      const file = join(RAW, `r${String(seq++).padStart(5, "0")}.png`);
      const data = Buffer.from(p.data, "base64");
      frames.push({ file, at });
      writing = writing.then(() => writeFile(file, data));
      cdp!.send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
    });

    if (OPT.stills) {
      // A few real writes first: the change log and the diffs in it are only
      // worth photographing once something has actually landed.
      for (const beat of BEATS.slice(0, 3)) {
        const abs = join(STAGE, beat.file);
        await mkdir(resolve(abs, ".."), { recursive: true });
        if (beat.content) await writeFile(abs, beat.content);
        else if (beat.append) await appendFile(abs, beat.append);
        await sleep(1400);
      }
      await sleep(1200);
      log("stills:");
      await shootStills(cdp, resolve(ROOT, "docs"));
      return [];
    }

    started = Date.now();
    await cdp.send("Page.startScreencast", {
      format: "png",
      // ~25 frames a second reaching us, resampled down to the GIF's rate. The
      // page paints far faster than that and every extra frame is a PNG write.
      everyNthFrame: 4,
      maxWidth: OPT.width * OPT.scale,
      maxHeight: OPT.height * OPT.scale,
    });
    log(`rolling · ${OPT.seconds}s`);

    // The take. Beats land on the clock, not after the previous one finished,
    // so the rhythm of the recording is the rhythm written above.
    for (const beat of BEATS) {
      const wait = beat.at - (Date.now() - started);
      if (wait > 0) await sleep(wait);
      const abs = join(STAGE, beat.file);
      await mkdir(resolve(abs, ".."), { recursive: true });
      if (beat.content) await writeFile(abs, beat.content);
      else if (beat.append) await appendFile(abs, beat.append);
      log(`  ${String(((Date.now() - started) / 1000).toFixed(1)).padStart(5)}s  ${beat.file} — ${beat.note}`);
    }

    // The last beat lands with a couple of seconds to spare: a screen leaving
    // takes about a second, and a loop that cuts mid-movement reads as a glitch
    // rather than a repeat.
    const left = OPT.seconds * 1000 - (Date.now() - started);
    if (left > 0) await sleep(left);
    await cdp.send("Page.stopScreencast");
    await writing;
    log(`captured ${frames.length} frames in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } finally {
    cdp?.close();
    try { if (browser.pid) process.kill(-browser.pid, "SIGTERM"); } catch {}
    killStack();
  }

  if (frames.length < 20) throw new Error(`only ${frames.length} frames captured — see ${LOG}`);
  return frames;
}

// --------------------------------------------------------------- to a GIF
//
// The screencast delivers frames when the page paints, not on a clock, so they
// are resampled onto an even timeline before ffmpeg sees them: without this a
// pause in painting becomes a pause in the GIF at the wrong moment.

async function assemble(frames: { file: string; at: number }[]) {
  await rm(FRAMES, { recursive: true, force: true });
  await mkdir(FRAMES, { recursive: true });
  const step = 1000 / OPT.fps;
  const total = Math.floor((OPT.seconds * 1000) / step);
  let cursor = 0;
  for (let i = 0; i < total; i++) {
    const t = i * step;
    while (cursor + 1 < frames.length && frames[cursor + 1]!.at <= t) cursor++;
    const out = join(FRAMES, `f${String(i).padStart(4, "0")}.png`);
    // Hard link rather than copy: one bitmap often serves several slots of the
    // output timeline, and ffmpeg only reads them.
    try {
      await link(frames[cursor]!.file, out);
    } catch {
      await Bun.write(out, Bun.file(frames[cursor]!.file));
    }
  }
  log(`resampled to ${total} frames at ${OPT.fps}fps`);

  await mkdir(resolve(OPT.out, ".."), { recursive: true });
  // One shared palette for the whole clip: a per-frame palette makes the dark
  // background crawl. Bayer dithering keeps the gradients from banding without
  // the file size that error-diffusion costs on 150 frames.
  const filter =
    `fps=${OPT.fps},scale=${OPT.width}:${OPT.height}:flags=lanczos,split[a][b];` +
    `[a]palettegen=max_colors=128:stats_mode=diff[p];` +
    // No dithering: a dither pattern is noise, and noise is what stops
    // `diff_mode=rectangle` from finding the large unchanged areas that make a
    // clip of a mostly-still scene small. The scene is dark and smooth enough
    // that 128 colours land on it cleanly.
    `[b][p]paletteuse=dither=none:diff_mode=rectangle`;
  const ff = Bun.spawnSync([
    "ffmpeg", "-y",
    "-framerate", String(OPT.fps),
    "-i", join(FRAMES, "f%04d.png"),
    "-filter_complex", filter,
    "-loop", "0",
    OPT.out,
  ], { stderr: "pipe", stdout: "pipe" });
  if (ff.exitCode !== 0) throw new Error(`ffmpeg failed:\n${ff.stderr.toString().split("\n").slice(-12).join("\n")}`);
}

// ------------------------------------------------------------------- main

const t0 = Date.now();
try {
  await mkdir(RUN, { recursive: true });
  const frames = await record();
  if (OPT.stills) {
    console.log(`\n  \x1b[32m✓\x1b[0m docs/ screenshots refreshed in ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
    process.exit(0);
  }
  await assemble(frames);
  const size = Bun.file(OPT.out).size;
  console.log(
    `\n  \x1b[32m✓\x1b[0m ${OPT.out.replace(ROOT + "/", "")} — ` +
      `${OPT.width}×${OPT.height}, ${OPT.fps}fps, ${(size / 1024 / 1024).toFixed(2)} MB ` +
      `in ${((Date.now() - t0) / 1000).toFixed(0)}s\n`,
  );
} catch (err) {
  killStack();
  console.error(`\n  \x1b[31m✗\x1b[0m ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
} finally {
  if (!OPT.keepFrames) {
    await rm(FRAMES, { recursive: true, force: true });
    await rm(RAW, { recursive: true, force: true });
  } else {
    log(`frames kept in ${FRAMES.replace(ROOT + "/", "")}`);
  }
}
