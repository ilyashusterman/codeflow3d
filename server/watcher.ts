/**
 * Filesystem watcher. Reports *every* file event under the repo (adds, writes,
 * deletes, directory removals) so the viewer's activity feed shows real editor
 * and agent activity, while only source files are handed to the analyzer.
 */
import chokidar, { type FSWatcher } from "chokidar";
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { FileEvent, FileEventKind } from "../shared/protocol";
import { languageOf, toPosix } from "./analyzer";
import { Ignore, IGNORED_DIRS, isIgnoreFile } from "./ignore";

export { IGNORED_DIRS };

/** What one walk found, and the ignore decisions it made getting there. */
export interface WalkResult {
  files: string[];
  /** Hand this to {@link startWatcher} so both agree on what is out of scope. */
  ignore: Ignore;
  /** True when `limit` cut the walk short — the caller should say so. */
  truncated: boolean;
  /** Directories skipped as installed rather than authored, for the log. */
  skipped: string[];
}

/**
 * List repo-relative file paths, skipping what the repository itself ignores.
 *
 * Directories are decided *before* descending, which is the whole point: a
 * vendored tree costs one `.gitignore` check rather than a walk of everything
 * inside it. `.gitignore` files are read as the walk reaches them, so a nested
 * one governs its own subtree exactly as git would.
 */
export async function walkRepo(root: string, limit = 20_000): Promise<WalkResult> {
  const ignore = new Ignore(root);
  const files: string[] = [];
  const skipped: string[] = [];
  const stack: string[] = [""];
  let truncated = false;

  while (stack.length) {
    if (files.length >= limit) {
      truncated = true;
      break;
    }
    const dir = stack.pop()!;
    // Rules declared here apply to this directory's children.
    ignore.loadDir(dir);
    let entries;
    try {
      entries = await readdir(join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (ignore.isVendoredDir(rel, e.name)) {
          skipped.push(rel);
          continue;
        }
        if (ignore.ignores(rel, true)) {
          skipped.push(rel);
          continue;
        }
        stack.push(rel);
      } else if (e.isFile() && !ignore.ignores(rel, false)) {
        files.push(rel);
      }
    }
  }
  return { files, ignore, truncated, skipped };
}

export interface WatcherHandle {
  /**
   * Aim the fast lane at the files that matter right now — the ones on screen.
   * Called after every rebuild, so it follows you as you work.
   */
  setHot(paths: string[]): void;
  close(): Promise<void>;
}

/**
 * How often a hot file is stat-ed.
 *
 * Measured on this machine: chokidar's FSEvents path reports a write in 12-17ms
 * and a 5ms poll reports it in 3-6ms, because FSEvents coalesces with a latency
 * that is not exposed to us. Polling the whole tree to win that back would be
 * the "CPU work" this project set out to avoid — but polling only what is on
 * screen is a handful of stat calls, which is microseconds, and it makes the
 * file you are actually editing the fastest one in the repo.
 */
const HOT_POLL_MS = 5;
/** Never fast-lane more than this, however many screens are up. */
const MAX_HOT = 24;

/**
 * Start watching `root`. Events are batched: `onBatch` fires once per quiet
 * window so a multi-file agent edit lands as a single scene revision.
 */
export function startWatcher(
  root: string,
  onBatch: (events: FileEvent[]) => void,
  opts: { debounceMs?: number; ignore?: Ignore } = {},
): WatcherHandle {
  // Reuse the walk's decisions when given them: a file the scan refused to read
  // must not arrive later through the watcher and be parsed after all.
  const ignore = opts.ignore ?? new Ignore(root);
  const isIgnored = (rel: string, isDir?: boolean) => ignore.ignores(rel, isDir);
  /**
   * Batching, on a leading edge with a bounded tail.
   *
   * This was a plain trailing debounce, which is the wrong shape for a save.
   * Every new event *extended* the wait, so saving two files was slower than
   * saving one, and a single save paid the full window for no benefit —
   * batching only helps when there is something to batch with.
   *
   * Now the first event after a quiet period flushes on the next tick, so a
   * save you make by hand is limited by the filesystem rather than by us. Bursts
   * still coalesce: events arriving inside the tail window join one batch, and
   * the tail is capped so a steady stream of writes cannot defer a flush
   * indefinitely.
   */
  const tailMs = opts.debounceMs ?? 12;
  /** A batch is never held longer than this from its first event. */
  const maxHoldMs = tailMs * 2;
  let pending = new Map<string, FileEvent>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** When the oldest pending event arrived, to bound the tail. */
  let openedAt = 0;

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!pending.size) return;
    const batch = [...pending.values()].sort((a, b) => a.at - b.at);
    pending = new Map();
    openedAt = 0;
    onBatch(batch);
  };

  /** Re-aim the flush: quiet-for-`tailMs`, but never past `maxHoldMs`. */
  const arm = () => {
    const now = Date.now();
    if (!openedAt) {
      openedAt = now;
      // Leading edge: nothing was pending, so there is nothing to wait for.
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, 0);
      return;
    }
    const remaining = maxHoldMs - (now - openedAt);
    if (remaining <= 0) return flush();
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, Math.min(tailMs, remaining));
  };

  const push = async (kind: FileEventKind, abs: string) => {
    const rel = toPosix(relative(root, abs));
    if (!rel || rel.startsWith("..")) return;
    // A `.gitignore` changed: every decision below it changed with it. Re-read
    // before deciding this event, and re-offer the tree to chokidar — a path
    // the old rules excluded was never watched, so un-ignoring it has to be
    // followed by a traversal or it stays invisible until the next scan.
    if (isIgnoreFile(rel)) {
      ignore.reload();
      watcher.add(root);
    }
    if (isIgnored(rel)) return;
    let size = 0;
    if (kind === "add" || kind === "change") {
      size = await stat(abs).then((s) => s.size).catch(() => 0);
    }
    // Latest event per path wins, but a delete after an add cancels nothing —
    // the analyzer applies them in order and the feed shows the final state.
    pending.set(`${kind}:${rel}`, { kind, path: rel, at: Date.now(), size, language: languageOf(rel) });
    arm();
  };

  /**
   * The fast lane: stat a small set of paths directly.
   *
   * chokidar still watches the whole tree and is still the source of truth for
   * adds, deletes and anything off-screen. This only ever gets there first, and
   * a write it reports is dropped as a duplicate when chokidar repeats it —
   * the analyzer compares content, so a double report costs one string compare.
   */
  let hot = new Map<string, { mtime: number; size: number }>();
  let hotTimer: ReturnType<typeof setInterval> | null = null;

  const pollHot = async () => {
    if (!hot.size) return;
    await Promise.all(
      [...hot.keys()].map(async (rel) => {
        try {
          // A rules change can make an on-screen file ignored under us.
          if (isIgnored(rel, false)) return;
          const info = await stat(join(root, rel));
          const seen = hot.get(rel);
          if (!seen) return;
          if (seen.mtime === info.mtimeMs && seen.size === info.size) return;
          // A first sighting (mtime 0) is the baseline, not an edit.
          const baseline = seen.mtime === 0;
          hot.set(rel, { mtime: info.mtimeMs, size: info.size });
          if (baseline) return;
          pending.set(`change:${rel}`, {
            kind: "change",
            path: rel,
            at: Date.now(),
            size: info.size,
            language: languageOf(rel),
          });
          arm();
        } catch {
          /* gone, or unreadable — chokidar's unlink event handles it */
        }
      }),
    );
  };

  const watcher: FSWatcher = chokidar.watch(root, {
    ignoreInitial: true,
    persistent: true,
    followSymlinks: false,
    depth: 12,
    // Editors write atomically via rename, so there is no half-written state to
    // wait for; this window exists only for the tools that stream a file out in
    // chunks. Kept as small as chokidar allows, because every millisecond here
    // is pure latency between the save and the graph — and a torn read is
    // self-correcting anyway, since the next event re-parses the file.
    awaitWriteFinish: { stabilityThreshold: 4, pollInterval: 2 },
    usePolling: false,
    ignored: (p, stats) => {
      const rel = toPosix(relative(root, p));
      return rel !== "" && isIgnored(rel, stats?.isDirectory());
    },
  });

  watcher
    .on("add", (p) => void push("add", p))
    .on("change", (p) => void push("change", p))
    .on("unlink", (p) => void push("unlink", p))
    .on("addDir", (p) => void push("addDir", p))
    .on("unlinkDir", (p) => void push("unlinkDir", p))
    .on("error", (err) => console.error("[watch]", err));

  return {
    setHot(paths) {
      const next = new Map<string, { mtime: number; size: number }>();
      for (const rel of paths.slice(0, MAX_HOT)) {
        // Carry the last known stamp over, so a file that stays on screen is
        // not re-baselined and its next edit is caught.
        next.set(rel, hot.get(rel) ?? { mtime: 0, size: -1 });
      }
      hot = next;
      if (hot.size && !hotTimer) hotTimer = setInterval(() => void pollHot(), HOT_POLL_MS);
      else if (!hot.size && hotTimer) {
        clearInterval(hotTimer);
        hotTimer = null;
      }
    },
    async close() {
      if (timer) clearTimeout(timer);
      if (hotTimer) clearInterval(hotTimer);
      await watcher.close();
    },
  };
}

