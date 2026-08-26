/**
 * Tiny multi-language tokenizer, shared by the server (which highlights the
 * panel windows it sends) and the client (which highlights the editor overlay
 * as you type).
 *
 * The classes it emits are the ones a real editor theme distinguishes —
 * declaration keywords apart from control keywords, identifiers apart from
 * punctuation — because every surface that shows code here is meant to read as
 * the same editor. It stays regex-based and dependency-free: this runs on every
 * keystroke-level save, and a parser per language is what tree-sitter is for
 * on the graph side.
 */
import type { TokenClass } from "./protocol";

/** A highlighted line before change/flow marks are attached. */
export interface RawLine {
  n: number;
  spans: { t: string; c: TokenClass }[];
}

const KEYWORDS: Record<string, string[]> = {
  common: [
    "return", "if", "else", "for", "while", "do", "break", "continue", "new", "throw",
    "try", "catch", "finally", "switch", "case", "default", "in", "of", "not",
    "and", "or", "true", "false", "null", "nil", "None", "True", "False",
  ],
  js: [
    "const", "let", "var", "function", "async", "await", "class", "extends",
    "import", "export", "from", "as", "default", "this", "typeof", "instanceof",
    "yield", "static", "get", "set", "delete", "void", "undefined",
  ],
  ts: [
    "interface", "type", "enum", "implements", "public", "private", "protected",
    "readonly", "declare", "namespace", "keyof", "infer", "satisfies",
    // Primitives are keywords to a theme, not identifiers: an annotated
    // parameter list is most of what a reader sees at a glance.
    "number", "string", "boolean", "any", "unknown", "never", "object", "symbol", "bigint",
  ],
  py: ["def", "lambda", "class", "import", "from", "as", "with", "yield", "pass", "raise", "global", "nonlocal", "async", "await", "elif", "self"],
  go: ["func", "package", "import", "var", "const", "type", "struct", "interface", "go", "defer", "chan", "select", "range", "map", "make", "nil", "err"],
  rust: ["fn", "let", "mut", "pub", "use", "mod", "impl", "trait", "struct", "enum", "match", "where", "unsafe", "crate", "self", "Some", "Ok", "Err"],
  java: ["public", "private", "protected", "class", "interface", "void", "static", "final", "new", "extends", "implements", "package", "import", "this"],
};

function keywordSet(language: string): Set<string> {
  const buckets = [KEYWORDS.common];
  if (language === "typescript" || language === "tsx") buckets.push(KEYWORDS.js, KEYWORDS.ts);
  else if (language === "javascript" || language === "jsx") buckets.push(KEYWORDS.js);
  else if (language === "python") buckets.push(KEYWORDS.py);
  else if (language === "go") buckets.push(KEYWORDS.go);
  else if (language === "rust") buckets.push(KEYWORDS.rust);
  else if (language === "java") buckets.push(KEYWORDS.java);
  else buckets.push(KEYWORDS.js);
  return new Set(buckets.flat());
}

/**
 * Keywords an editor theme colours as control flow rather than as a
 * declaration. VSCode's default dark theme paints `return`/`if`/`await` and
 * the module keywords one colour and `const`/`function`/`class` another; a
 * single "keyword" class flattens the two and is the main reason home-grown
 * highlighting reads as a toy next to a real editor.
 */
const CONTROL = new Set([
  "return", "if", "else", "elif", "for", "while", "do", "break", "continue",
  "switch", "case", "match", "try", "catch", "except", "finally", "throw",
  "raise", "pass", "yield", "await", "new", "delete", "in", "of", "with",
  "and", "or", "not", "import", "export", "from", "as", "typeof", "instanceof",
  "defer", "go", "select", "range", "goto", "use", "mod", "package",
]);

/** Keywords that introduce a name: what follows them is a definition, not a use. */
const DECLARES_FN = new Set(["function", "def", "fn", "func", "method", "sub"]);
const DECLARES_TYPE = new Set([
  "class", "interface", "type", "enum", "struct", "trait", "namespace", "impl", "record",
]);

const lineCommentToken = (language: string) => (language === "python" ? "#" : "//");

const TOKEN_RE =
  /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\/\/[^\n]*|#[^\n]*)|(\b\d[\w.]*\b)|([A-Za-z_$][\w$]*)|(\s+)|([{}()[\];,.]|[=+\-*/<>!&|?:%^~]+)/g;

/**
 * Which class one word token belongs to.
 *
 * Order matters: a keyword is a keyword wherever it appears, a name right
 * after `function`/`class` is the definition it introduces, a name followed by
 * `(` is a call, a capitalized name is a type, and everything left is an
 * ordinary identifier — which is a colour of its own, not the colour of the
 * whitespace around it.
 */
function classifyWord(
  word: string,
  src: string,
  cursor: number,
  kw: Set<string>,
  previousWord: string,
): TokenClass {
  if (kw.has(word)) return CONTROL.has(word) ? "control" : "keyword";
  if (DECLARES_FN.has(previousWord)) return "fn";
  if (DECLARES_TYPE.has(previousWord)) return "type";
  const rest = src.slice(cursor);
  // A call, including a generic one: `api<T = any>(`. Matching a bare `<`
  // would paint the left side of every comparison as a function.
  if (rest.startsWith("(") || /^<[^<>]*>\s*\(/.test(rest)) return "fn";
  if (/^[A-Z]/.test(word)) return "type";
  return "ident";
}

/**
 * Tokenize one line into coloured spans.
 * `inBlockComment` threads /* ... *\/ state across lines.
 */
function tokenizeLine(text: string, kw: Set<string>, language: string, state: { block: boolean }): RawLine["spans"] {
  const spans: RawLine["spans"] = [];
  /** The last word token on this line — what makes `function foo` a definition. */
  let previousWord = "";
  const push = (t: string, c: TokenClass) => {
    if (!t) return;
    const last = spans[spans.length - 1];
    if (last && last.c === c) last.t += t;
    else spans.push({ t, c });
  };

  let src = text;
  if (state.block) {
    const end = src.indexOf("*/");
    if (end === -1) {
      push(src, "comment");
      return spans;
    }
    push(src.slice(0, end + 2), "comment");
    src = src.slice(end + 2);
    state.block = false;
  }

  const blockStart = src.indexOf("/*");
  let tail = "";
  if (blockStart !== -1 && language !== "python") {
    const end = src.indexOf("*/", blockStart + 2);
    if (end === -1) {
      tail = src.slice(blockStart);
      state.block = true;
      src = src.slice(0, blockStart);
    }
  }

  const lc = lineCommentToken(language);
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let cursor = 0;
  while ((m = TOKEN_RE.exec(src))) {
    if (m.index > cursor) push(src.slice(cursor, m.index), "plain");
    cursor = m.index + m[0].length;
    const [, str, comment, num, word, ws, op] = m;
    if (str) push(str, "string");
    else if (comment) {
      if (comment.startsWith(lc) || comment.startsWith("//")) {
        push(src.slice(m.index), "comment");
        cursor = src.length;
        break;
      }
      push(comment, "plain");
    } else if (num) push(num, "number");
    else if (word) {
      push(word, classifyWord(word, src, cursor, kw, previousWord));
      previousWord = word;
    } else if (ws) push(ws, "plain");
    else if (op) push(op, /^[{}()[\];,.]$/.test(op) ? "punct" : "op");
  }
  if (cursor < src.length) push(src.slice(cursor), "plain");
  if (tail) push(tail, "comment");
  return spans;
}

/**
 * Highlight a window of a file.
 * @param from 1-based first line to include.
 */
export function highlight(source: string, language: string, from: number, count: number): RawLine[] {
  const all = source.split("\n");
  const kw = keywordSet(language);
  const state = { block: false };
  const out: RawLine[] = [];
  const start = Math.max(1, Math.min(from, Math.max(1, all.length - count + 1)));

  // Walk from the top so block-comment state is correct at `start`.
  for (let i = 0; i < start - 1; i++) tokenizeLine(all[i] ?? "", kw, language, state);
  for (let i = start - 1; i < Math.min(all.length, start - 1 + count); i++) {
    out.push({ n: i + 1, spans: tokenizeLine(expandTabs(all[i] ?? ""), kw, language, state) });
  }
  return out;
}

/**
 * Screens show a few hundred pixels of line. A minified bundle whose entire
 * body is one 600KB line would otherwise be tokenized and shipped in full,
 * which is how a scene message reaches double-digit megabytes.
 */
const MAX_LINE_CHARS = 400;

function expandTabs(s: string) {
  const expanded = s.replace(/\t/g, "  ").replace(/\s+$/, "");
  return expanded.length > MAX_LINE_CHARS ? expanded.slice(0, MAX_LINE_CHARS) + " …" : expanded;
}
