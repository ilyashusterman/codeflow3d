/**
 * Reading edits that have not been saved yet.
 *
 * A file watcher only ever sees writes, so a file being typed into is
 * invisible until someone hits save. But VS Code and everything built on it —
 * Cursor, VSCodium, Windsurf, Insiders — persist their dirty editors to disk
 * for hot exit, and those backups are readable: the first line is the file's
 * URI, everything after it is the unsaved buffer. Watching that directory
 * gives genuinely live, unsaved content.
 *
 * The honest limits, because they matter — and the first one is severe enough
 * that this file is a fallback, not the primary route:
 *
 *  - Desktop VS Code and Cursor write these backups when a *window closes*,
 *    not while you type. Measured directly: a dirty editor produced zero
 *    backup writes over ten seconds. So on a default desktop setup there is
 *    nothing here to read until you save, and the viewer says so rather than
 *    appearing broken (see `stats.unsavedSeen`). Where backups *are* written
 *    continuously — remote and web workspaces, and some forks — this works.
 *  - It only covers VS Code-family editors. Vim, Emacs and JetBrains keep
 *    their own formats; for those, and for anything else, turning on autosave
 *    gives the same result through the normal watcher.
 *  - The routes that always work are autosave (a real write, ~8ms to the
 *    screen) and {@link UnsavedWatcher.push} via `POST /api/buffer`.
 *  - The format is undocumented. Everything here fails soft: if a backup
 *    cannot be parsed it is skipped, and the app behaves exactly as it did
 *    before this file existed.
 */
import { watch, type FSWatcher } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";

/** VS Code-family application-support directory names. */
const EDITORS = [
  "Code",
  "Code - Insiders",
  "Cursor",
  "VSCodium",
  "Windsurf",
  "Antigravity",
  "Antigravity IDE",
  "Trae",
];

/** Backups larger than this are not something anyone is hand-editing. */
const MAX_BACKUP_BYTES = 2_000_000;

function backupRoots(): string[] {
  // An escape hatch for editors installed somewhere unusual — and the only way
  // to exercise this path without writing into a real editor's data directory.
  const extra = (process.env.CODEFLOW_BACKUP_DIRS ?? "")
    .split(":")
    .map((d) => d.trim())
    .filter(Boolean);

  const home = homedir();
  const bases =
    process.platform === "darwin"
      ? [join(home, "Library", "Application Support")]
      : process.platform === "win32"
        ? [join(process.env.APPDATA ?? join(home, "AppData", "Roaming"))]
        : [join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"))];

  const roots: string[] = [...extra];
  for (const base of bases) {
    for (const editor of EDITORS) roots.push(join(base, editor, "Backups"));
  }
  return roots;
}

export interface UnsavedBuffer {
  /** Repo-relative POSIX path. */
  path: string;
  /** The unsaved buffer's full text. */
  content: string;
  /** Epoch ms the editor last wrote this backup. */
  at: number;
}

/**
 * Parse one backup file.
 *
 * The header line is `<uri>` optionally followed by a space and a JSON blob.
 * There are two content layouts in the wild: usually the buffer follows the
 * header on the next line, but some working copies serialize themselves into
 * the header JSON's `content` field instead and leave the body empty. Both
 * appear on the same machine, so both are handled.
 */
function parseBackup(raw: string): { uri: string; content: string } | null {
  const newline = raw.indexOf("\n");
  const header = newline === -1 ? raw : raw.slice(0, newline);
  const body = newline === -1 ? "" : raw.slice(newline + 1);

  const space = header.indexOf(" ");
  const uri = (space === -1 ? header : header.slice(0, space)).trim();
  if (!uri.startsWith("file://")) return null;

  if (body.trim()) return { uri, content: body };

  if (space !== -1) {
    try {
      const meta = JSON.parse(header.slice(space + 1));
      if (meta && typeof meta.content === "string") return { uri, content: meta.content };
    } catch {
      /* not the JSON variant */
    }
  }
  return body ? { uri, content: body } : null;
}

function uriToPath(uri: string): string {
  try {
    return decodeURIComponent(new URL(uri).pathname);
  } catch {
    return "";
  }
}

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

export interface UnsavedWatcherOptions {
  root: string;
  /** Fired when the set of unsaved buffers under `root` changes. */
  onChange: (buffers: Map<string, UnsavedBuffer>) => void;
  /** Batching window, ms. */
  debounceMs?: number;
}

/**
 * Watches every editor's backup directory and reports the unsaved buffers that
 * belong to the given repository.
 *
 * Buffers can also be pushed in directly with {@link UnsavedWatcher.push},
 * which is the only route to genuinely keystroke-level updates — see the
 * `/api/buffer` endpoint.
 */
export class UnsavedWatcher {
  private readonly root: string;
  private readonly onChange: UnsavedWatcherOptions["onChange"];
  private readonly debounceMs: number;
  private watchers: FSWatcher[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private buffers = new Map<string, UnsavedBuffer>();
  private scanning = false;
  private rescanQueued = false;
  private poll: ReturnType<typeof setInterval> | null = null;
  /** mtime+size per backup file, so an unchanged one is never re-read. */
  private seen = new Map<string, { at: number; size: number; parsed: UnsavedBuffer | null }>();

  constructor(options: UnsavedWatcherOptions) {
    this.root = options.root;
    this.onChange = options.onChange;
    // Deliberately tiny. The editor's own backup cadence is the dominant delay
    // in this path; anything added on top is pure latency.
    this.debounceMs = options.debounceMs ?? 8;
  }

  get current() {
    return this.buffers;
  }

  /**
   * Accept a buffer pushed from outside, e.g. an editor extension.
   *
   * Scanning a backup store can only ever be as live as the editor's own write
   * cadence — about a second after you stop typing. An editor that pushes its
   * buffer as it changes bypasses that entirely, which is the difference
   * between "live" and "realtime".
   */
  push(path: string, content: string) {
    const next = new Map(this.buffers);
    next.set(path, { path, content, at: Date.now() });
    this.pushed.set(path, next.get(path)!);
    this.buffers = next;
    this.onChange(next);
  }

  /** Withdraw a pushed buffer: the editor saved it, or closed it unchanged. */
  drop(path: string) {
    if (!this.pushed.delete(path)) return;
    const next = new Map(this.buffers);
    next.delete(path);
    this.buffers = next;
    this.onChange(next);
  }

  /** Buffers supplied by a push, which outrank anything found on disk. */
  private pushed = new Map<string, UnsavedBuffer>();

  async start(): Promise<string[]> {
    const found: string[] = [];
    for (const dir of backupRoots()) {
      try {
        if (!(await stat(dir)).isDirectory()) continue;
      } catch {
        continue;
      }
      found.push(dir);
      try {
        // Recursive watch covers the per-workspace subdirectories the editor
        // creates and destroys as windows open and close.
        const w = watch(dir, { recursive: true }, () => this.schedule());
        w.on("error", () => {});
        this.watchers.push(w);
      } catch {
        /* platform without recursive watch — the poll below covers it */
      }
    }

    if (found.length) {
      // Polled deliberately fast rather than trusting the watch.
      //
      // Recursive fs.watch goes through FSEvents on macOS, which coalesces
      // with a latency Node does not expose — the reason edits felt laggy even
      // though the work was quick. Unchanged backups are now a bare stat call
      // thanks to the mtime cache, so a tight poll costs microseconds and gives
      // a predictable ceiling instead of an opaque one.
      this.poll = setInterval(() => this.schedule(), 40);
      await this.rescan();
    }
    return found;
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.rescan(), this.debounceMs);
  }

  private async rescan() {
    if (this.scanning) {
      this.rescanQueued = true;
      return;
    }
    this.scanning = true;
    try {
      const next = new Map<string, UnsavedBuffer>();
      for (const dir of backupRoots()) {
        await this.collect(dir, next);
      }
      // A pushed buffer is always fresher than a scanned one.
      for (const [path, buffer] of this.pushed) next.set(path, buffer);
      if (!sameBuffers(this.buffers, next)) {
        this.buffers = next;
        this.onChange(next);
      }
    } finally {
      this.scanning = false;
      if (this.rescanQueued) {
        this.rescanQueued = false;
        void this.rescan();
      }
    }
  }

  private async collect(dir: string, into: Map<string, UnsavedBuffer>) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.collect(full, into);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const info = await stat(full);
        if (info.size > MAX_BACKUP_BYTES || info.size === 0) continue;

        // The safety-net poll would otherwise re-read every dirty buffer every
        // few seconds; stat is enough to know nothing moved.
        const cached = this.seen.get(full);
        let buffer: UnsavedBuffer | null;
        if (cached && cached.at === info.mtimeMs && cached.size === info.size) {
          buffer = cached.parsed;
        } else {
          const parsed = parseBackup(await readFile(full, "utf8"));
          const abs = parsed ? uriToPath(parsed.uri) : "";
          const rel = abs ? toPosix(relative(this.root, abs)) : "";
          buffer =
            parsed && rel && !rel.startsWith("..")
              ? { path: rel, content: parsed.content, at: info.mtimeMs }
              : null;
          this.seen.set(full, { at: info.mtimeMs, size: info.size, parsed: buffer });
        }
        if (!buffer) continue;

        const existing = into.get(buffer.path);
        // If the same file is open in two windows, the newer backup wins.
        if (!existing || buffer.at > existing.at) into.set(buffer.path, buffer);
      } catch {
        /* a backup being rewritten as we read it — the next scan catches it */
      }
    }
  }

  close() {
    if (this.timer) clearTimeout(this.timer);
    if (this.poll) clearInterval(this.poll);
    for (const w of this.watchers) w.close();
    this.watchers = [];
    this.buffers = new Map();
    this.seen.clear();
    this.pushed.clear();
  }
}

function sameBuffers(a: Map<string, UnsavedBuffer>, b: Map<string, UnsavedBuffer>): boolean {
  if (a.size !== b.size) return false;
  for (const [path, buffer] of a) {
    const other = b.get(path);
    if (!other || other.content !== buffer.content) return false;
  }
  return true;
}
