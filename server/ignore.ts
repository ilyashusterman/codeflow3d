/**
 * What not to walk, watch, or parse.
 *
 * The motivating case: a repository with a Python virtualenv in it, under a name
 * the fixed list below would never have guessed. `.gitignore` listed it as a
 * `.venv*` directory, git never showed it, and it had been forgotten — but it
 * held 15,988 installed `.py` files. Walking it turned a 270-file project into a
 * 9,581-file one: 22 seconds of parsing to build a graph of library code.
 *
 * So the rule is the one the repository already states: if git ignores it, we
 * ignore it. On top of that sit two safety nets, because not every checkout is
 * a git repository and not every vendored tree is listed:
 *
 *   - a fixed list of directory names that are never source (node_modules, …)
 *   - markers that identify a tree as installed rather than written: a
 *     `pyvenv.cfg` beside it, or a `site-packages` segment in the path
 *
 * Patterns are matched with gitignore semantics, scoped to the directory of the
 * `.gitignore` that declared them, including negation with `!`.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Directory names that are never worth walking or watching. */
export const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "out", ".next",
  ".nuxt", ".turbo", ".cache", "coverage", "target", "vendor", "__pycache__",
  ".venv", "venv", ".mypy_cache", ".pytest_cache", ".idea", ".vscode-test",
  ".gradle", "Pods", "DerivedData", ".terraform", ".svelte-kit", ".parcel-cache",
  // Installed packages, whatever the surrounding directory is called. A venv
  // named `.venv-whatever` is not in this list, but its site-packages is.
  "site-packages", "dist-packages",
  // Tool-managed trees that hold copies of other people's code.
  ".tox", ".nox", ".direnv", ".yarn", ".pnpm-store", "bower_components",
  ".serverless", ".output", ".astro", ".docusaurus", ".expo", ".dart_tool",
  ".bundle", ".stack-work", ".cargo", ".conda", "Carthage",
  // codeflow3d's own artifacts, so pointing it at itself stays quiet.
  "exports", "wasm",
]);

/** Noise that would otherwise flood the activity feed. */
const IGNORED_FILE_RE = /(^|\/)(\.DS_Store|.*\.swp|.*~|\.#.*|[0-9]+\.tmp)$/;

/**
 * A virtualenv, whatever it is called.
 *
 * `pyvenv.cfg` is written by `python -m venv` and by nothing else, so its
 * presence identifies the directory beside it as installed rather than authored
 * — which is the one thing a name-based list cannot tell us.
 */
function isVirtualenv(abs: string): boolean {
  return existsSync(join(abs, "pyvenv.cfg"));
}

/** One `.gitignore` line, compiled. */
interface Rule {
  /** Matches the path the pattern names. */
  re: RegExp;
  /** Matches anything strictly below it. */
  under: RegExp;
  /** A `!` line: this un-ignores what an earlier rule matched. */
  negated: boolean;
  /** A trailing `/`: matches directories only. */
  dirOnly: boolean;
  /** Repo-relative directory the declaring `.gitignore` sits in ("" at root). */
  base: string;
}

/**
 * Compile one gitignore pattern to a regex over repo-relative paths.
 *
 * Supports what real `.gitignore` files use: comments, negation, a trailing
 * slash for directories, a leading or embedded slash for anchoring, `*` (which
 * does not cross a slash), `?`, `**`, and character classes.
 */
function compile(line: string, base: string): Rule | null {
  let pattern = line.trim();
  if (!pattern || pattern.startsWith("#")) return null;
  // An escaped leading '#' or '!' is a literal.
  if (pattern.startsWith("\\")) pattern = pattern.slice(1);

  const negated = pattern.startsWith("!");
  if (negated) pattern = pattern.slice(1).trim();
  if (!pattern) return null;

  const dirOnly = pattern.endsWith("/");
  if (dirOnly) pattern = pattern.slice(0, -1);

  // A slash anywhere but the end anchors the pattern to the .gitignore's
  // directory; without one it matches at any depth below it.
  const anchored = pattern.includes("/");
  if (pattern.startsWith("/")) pattern = pattern.slice(1);

  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` spans directories, including none at all.
        if (pattern[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) re += "\\[";
      else {
        re += pattern.slice(i, close + 1).replace("[!", "[^");
        i = close;
      }
    } else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }

  const prefix = base ? `${base}/` : "";
  const body = anchored ? `${prefix}${re}` : `${prefix}(?:.*/)?${re}`;
  // Two regexes, because a directory pattern and its contents are different
  // questions. A `.venv*` directory pattern names a directory — the file
  // `.venv-local/lib/x.py` is
  // ignored because an *ancestor* matched, not because the file did, and
  // conflating the two is how a trailing slash ends up ignoring nothing.
  return {
    re: new RegExp(`^${body}$`),
    under: new RegExp(`^${body}/.*$`),
    negated,
    dirOnly,
    base,
  };
}

/** Reads `.gitignore` in one directory, if there is one. */
function rulesFrom(root: string, relDir: string): Rule[] {
  const file = join(root, relDir, ".gitignore");
  let text: string;
  try {
    if (!existsSync(file)) return [];
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: Rule[] = [];
  for (const line of text.split("\n")) {
    const rule = compile(line, relDir);
    if (rule) out.push(rule);
  }
  return out;
}

/**
 * The ignore decision for one repository.
 *
 * `.gitignore` files are picked up as the walk reaches them, so a nested one
 * applies to its own subtree and nowhere else — the same scoping git uses.
 * The watcher is handed the same object afterwards, so what is watched and what
 * was walked can never disagree.
 */
export class Ignore {
  private rules: Rule[] = [];
  private loaded = new Set<string>();
  /** Directories already identified as installed trees. */
  private vendored = new Set<string>();

  constructor(readonly root: string) {
    this.loadDir("");
    // `.git/info/exclude` is the same mechanism, kept out of the working tree.
    const exclude = join(root, ".git/info/exclude");
    if (existsSync(exclude)) {
      try {
        for (const line of readFileSync(exclude, "utf8").split("\n")) {
          const rule = compile(line, "");
          if (rule) this.rules.push(rule);
        }
      } catch {
        /* unreadable: the fixed list still applies */
      }
    }
  }

  /** Pick up the `.gitignore` in one directory. Idempotent. */
  loadDir(relDir: string): void {
    const key = relDir || ".";
    if (this.loaded.has(key)) return;
    this.loaded.add(key);
    const found = rulesFrom(this.root, relDir);
    if (found.length) this.rules.push(...found);
  }

  /** True when nothing in `relDir` should be walked, watched or parsed. */
  isVendoredDir(relDir: string, name: string): boolean {
    if (IGNORED_DIRS.has(name)) return true;
    if (this.vendored.has(relDir)) return true;
    if (isVirtualenv(join(this.root, relDir))) {
      this.vendored.add(relDir);
      return true;
    }
    return false;
  }

  /**
   * The whole decision for one repo-relative path.
   *
   * `isDir` matters: a `.gitignore` line ending in `/` applies to directories
   * only. When it is not known, both readings are tried — a watcher event for
   * a path that no longer exists cannot be stat-ed to find out.
   */
  ignores(rel: string, isDir?: boolean): boolean {
    if (!rel || rel === ".") return false;
    if (IGNORED_FILE_RE.test(rel)) return true;

    const segments = rel.split("/");
    for (const seg of segments) if (IGNORED_DIRS.has(seg)) return true;

    // Ancestors of this path may declare rules we have not read yet — the
    // watcher can report a path the walk never reached.
    let walked = "";
    for (let i = 0; i < segments.length - 1; i++) {
      walked = walked ? `${walked}/${segments[i]}` : segments[i];
      this.loadDir(walked);
      if (this.vendored.has(walked)) return true;
    }

    // Last matching rule wins, so a later `!` can rescue an earlier match.
    let ignored = false;
    for (const rule of this.rules) {
      // Anything below a matched directory is covered whatever the leaf is; the
      // leaf itself only counts for a directory rule when it is a directory.
      const hit = rule.under.test(rel) || ((!rule.dirOnly || isDir !== false) && rule.re.test(rel));
      if (hit) ignored = !rule.negated;
    }
    return ignored;
  }
}
