/**
 * Per-language tree-sitter queries.
 *
 * Definitions, imports and call sites are captured separately; attributing a
 * call to its enclosing definition is done by byte range afterwards, which is
 * both simpler and more reliable than encoding nesting in the query.
 */

/**
 * Note on query syntax: fields inside a node pattern must appear in the order
 * the grammar declares them (`object` before `property`, `value` before
 * `field`), or tree-sitter rejects the pattern outright.
 */
export type LangId = "typescript" | "tsx" | "javascript" | "jsx" | "python" | "rust" | "go";

/** How a module specifier in this language maps onto files in the repo. */
export type ModuleStyle = "node" | "python" | "rust" | "go";

export interface LangSpec {
  id: LangId;
  /** Grammar file in `wasm/`. */
  grammar: string;
  extensions: string[];
  style: ModuleStyle;
  /** Node types that introduce a new definition scope, innermost-wins. */
  containerTypes: string[];
  defQuery: string;
  callQuery: string;
  importQuery: string;
  /** Names that are never a call into repo code. */
  builtins: Set<string>;
}

const JS_BUILTINS = new Set([
  "require", "console", "Math", "JSON", "Object", "Array", "String", "Number",
  "Boolean", "Promise", "Set", "Map", "WeakMap", "WeakSet", "Date", "RegExp",
  "Error", "TypeError", "RangeError", "Symbol", "BigInt", "Proxy", "Reflect",
  "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent",
  "decodeURIComponent", "setTimeout", "clearTimeout", "setInterval",
  "clearInterval", "queueMicrotask", "structuredClone", "fetch", "URL",
  "URLSearchParams", "Blob", "File", "FormData", "Headers", "Request",
  "Response", "AbortController", "TextEncoder", "TextDecoder", "Intl",
  "push", "pop", "shift", "unshift", "slice", "splice", "concat", "join",
  "map", "filter", "reduce", "forEach", "find", "findIndex", "some", "every",
  "sort", "reverse", "includes", "indexOf", "lastIndexOf", "flat", "flatMap",
  "keys", "values", "entries", "has", "get", "set", "add", "delete", "clear",
  "then", "catch", "finally", "toString", "valueOf", "hasOwnProperty",
  "replace", "replaceAll", "split", "trim", "trimStart", "trimEnd", "padStart",
  "padEnd", "toLowerCase", "toUpperCase", "startsWith", "endsWith", "match",
  "matchAll", "repeat", "charCodeAt", "charAt", "codePointAt", "at", "test",
  "exec", "stringify", "parse", "assign", "freeze", "defineProperty", "log",
  "warn", "error", "info", "debug", "trace", "now", "random", "floor", "ceil",
  "round", "abs", "min", "max", "pow", "sqrt", "sign", "imul", "hypot", "log2",
  "toFixed", "toISOString", "getTime", "bind", "call", "apply",
]);

const PY_BUILTINS = new Set([
  "print", "len", "range", "str", "int", "float", "bool", "list", "dict", "set",
  "tuple", "type", "isinstance", "issubclass", "getattr", "setattr", "hasattr",
  "delattr", "super", "open", "enumerate", "zip", "map", "filter", "sorted",
  "reversed", "sum", "min", "max", "abs", "round", "any", "all", "repr",
  "format", "hash", "id", "iter", "next", "input", "vars", "dir", "callable",
  "bytes", "bytearray", "frozenset", "complex", "divmod", "pow", "chr", "ord",
  "append", "extend", "insert", "remove", "pop", "clear", "copy", "keys",
  "values", "items", "get", "update", "setdefault", "join", "split", "strip",
  "lstrip", "rstrip", "replace", "startswith", "endswith", "lower", "upper",
  "encode", "decode", "read", "write", "close", "sort", "index", "count",
  "add", "discard", "union", "intersection", "difference", "Exception",
  "ValueError", "TypeError", "KeyError", "IndexError", "RuntimeError",
]);

const RUST_BUILTINS = new Set([
  "println", "print", "eprintln", "format", "vec", "panic", "assert",
  "assert_eq", "assert_ne", "write", "writeln", "unwrap", "expect", "clone",
  "to_string", "to_owned", "into", "from", "as_str", "as_ref", "as_mut",
  "iter", "into_iter", "iter_mut", "collect", "map", "filter", "filter_map",
  "fold", "for_each", "unwrap_or", "unwrap_or_else", "unwrap_or_default",
  "ok_or", "ok", "err", "and_then", "or_else", "is_some", "is_none", "is_ok",
  "is_err", "len", "is_empty", "push", "pop", "insert", "remove", "get",
  "get_mut", "contains", "contains_key", "extend", "append", "sort", "sort_by",
  "new", "default", "with_capacity", "trim", "split", "replace", "join",
  "to_vec", "borrow", "borrow_mut", "lock", "read", "await", "send", "recv",
  "next", "count", "sum", "min", "max", "position", "find", "any", "all",
  "chars", "bytes", "parse", "starts_with", "ends_with", "to_lowercase",
  "to_uppercase", "push_str", "as_bytes", "abs", "powi", "sqrt", "floor",
]);

const GO_BUILTINS = new Set([
  "make", "new", "len", "cap", "append", "copy", "delete", "panic", "recover",
  "print", "println", "close", "complex", "real", "imag", "min", "max",
  "Printf", "Println", "Print", "Sprintf", "Sprint", "Errorf", "New", "Error",
  "String", "Fatal", "Fatalf", "Error", "Wrap", "Unwrap", "Add", "Done", "Wait",
  "Lock", "Unlock", "RLock", "RUnlock", "Sleep", "Now", "Since", "Marshal",
  "Unmarshal", "Read", "Write", "Close", "Open", "Create", "Join", "Split",
])

// ---------------------------------------------------------------- JS family

/**
 * One query serves TS, TSX, JS and JSX: the grammars differ in which patterns
 * exist, and tree-sitter simply never matches a pattern whose node types the
 * grammar lacks — except that an unknown node *type* is a query compile error,
 * so TS-only types stay in a separate optional block appended per dialect.
 */
const JS_DEFS = `
(function_declaration name: (identifier) @name) @def
(generator_function_declaration name: (identifier) @name) @def
(class_declaration name: (_) @name) @def
(method_definition name: (_) @name) @def
(variable_declarator
  name: (identifier) @name
  value: [(arrow_function) (function_expression) (generator_function)]) @def
`;

const TS_ONLY_DEFS = `
(interface_declaration name: (type_identifier) @name) @def
(type_alias_declaration name: (type_identifier) @name) @def
(enum_declaration name: (identifier) @name) @def
(public_field_definition
  name: (_) @name
  value: [(arrow_function) (function_expression)]) @def
`;

const JS_CALLS = `
(call_expression function: (identifier) @callee) @call
(call_expression function: (member_expression object: (_) @recv property: (property_identifier) @callee)) @call
(new_expression constructor: (identifier) @callee) @call
`;

/** JSX element usage is a real edge in a component graph, so it is captured. */
const JSX_CALLS = `
(jsx_opening_element name: (identifier) @callee) @render
(jsx_self_closing_element name: (identifier) @callee) @render
`;

const JS_IMPORTS = `
(import_statement) @import
(export_statement source: (string) @reexport_source) @reexport
(call_expression function: (identifier) @req arguments: (arguments (string) @req_source)) @require
`;

const JS_CONTAINERS = ["class_declaration", "class", "function_declaration", "method_definition", "arrow_function", "function_expression", "variable_declarator"];

// ------------------------------------------------------------------ Python

const PY_DEFS = `
(function_definition name: (identifier) @name) @def
(class_definition name: (identifier) @name) @def
`;

const PY_CALLS = `
(call function: (identifier) @callee) @call
(call function: (attribute object: (_) @recv attribute: (identifier) @callee)) @call
`;

const PY_IMPORTS = `
(import_statement) @import
(import_from_statement) @import
`;

// -------------------------------------------------------------------- Rust

const RS_DEFS = `
(function_item name: (identifier) @name) @def
(struct_item name: (type_identifier) @name) @def
(enum_item name: (type_identifier) @name) @def
(trait_item name: (type_identifier) @name) @def
`;

const RS_CALLS = `
(call_expression function: (identifier) @callee) @call
(call_expression function: (field_expression value: (_) @recv field: (field_identifier) @callee)) @call
(call_expression function: (scoped_identifier path: (_) @recv name: (identifier) @callee)) @call
`;

const RS_IMPORTS = `
(use_declaration argument: (_) @use_arg) @import
(mod_item name: (identifier) @mod_name) @mod
`;

// ---------------------------------------------------------------------- Go

const GO_DEFS = `
(function_declaration name: (identifier) @name) @def
(method_declaration name: (field_identifier) @name) @def
(type_declaration (type_spec name: (type_identifier) @name)) @def
`;

const GO_CALLS = `
(call_expression function: (identifier) @callee) @call
(call_expression function: (selector_expression operand: (_) @recv field: (field_identifier) @callee)) @call
`;

const GO_IMPORTS = `
(import_spec path: (interpreted_string_literal) @source) @import
`;

export const LANGUAGES: Record<LangId, LangSpec> = {
  typescript: {
    id: "typescript",
    grammar: "tree-sitter-typescript.wasm",
    extensions: [".ts", ".mts", ".cts"],
    style: "node",
    containerTypes: JS_CONTAINERS,
    defQuery: JS_DEFS + TS_ONLY_DEFS,
    callQuery: JS_CALLS,
    importQuery: JS_IMPORTS,
    builtins: JS_BUILTINS,
  },
  tsx: {
    id: "tsx",
    grammar: "tree-sitter-tsx.wasm",
    extensions: [".tsx"],
    style: "node",
    containerTypes: JS_CONTAINERS,
    defQuery: JS_DEFS + TS_ONLY_DEFS,
    callQuery: JS_CALLS + JSX_CALLS,
    importQuery: JS_IMPORTS,
    builtins: JS_BUILTINS,
  },
  javascript: {
    id: "javascript",
    grammar: "tree-sitter-javascript.wasm",
    extensions: [".js", ".mjs", ".cjs"],
    style: "node",
    containerTypes: JS_CONTAINERS,
    defQuery: JS_DEFS,
    callQuery: JS_CALLS + JSX_CALLS,
    importQuery: JS_IMPORTS,
    builtins: JS_BUILTINS,
  },
  jsx: {
    id: "jsx",
    grammar: "tree-sitter-javascript.wasm",
    extensions: [".jsx"],
    style: "node",
    containerTypes: JS_CONTAINERS,
    defQuery: JS_DEFS,
    callQuery: JS_CALLS + JSX_CALLS,
    importQuery: JS_IMPORTS,
    builtins: JS_BUILTINS,
  },
  python: {
    id: "python",
    grammar: "tree-sitter-python.wasm",
    extensions: [".py", ".pyi"],
    style: "python",
    containerTypes: ["function_definition", "class_definition"],
    defQuery: PY_DEFS,
    callQuery: PY_CALLS,
    importQuery: PY_IMPORTS,
    builtins: PY_BUILTINS,
  },
  rust: {
    id: "rust",
    grammar: "tree-sitter-rust.wasm",
    extensions: [".rs"],
    style: "rust",
    containerTypes: ["function_item", "impl_item", "trait_item", "mod_item"],
    defQuery: RS_DEFS,
    callQuery: RS_CALLS,
    importQuery: RS_IMPORTS,
    builtins: RUST_BUILTINS,
  },
  go: {
    id: "go",
    grammar: "tree-sitter-go.wasm",
    extensions: [".go"],
    style: "go",
    containerTypes: ["function_declaration", "method_declaration"],
    defQuery: GO_DEFS,
    callQuery: GO_CALLS,
    importQuery: GO_IMPORTS,
    builtins: GO_BUILTINS,
  },
};

/**
 * Files that are worth showing but not worth parsing.
 *
 * A repository is more than its call graph — a dependency bump in
 * `package.json` or `requirements.txt` is exactly the kind of change you want
 * to see happen. These get screens, diffs and tailing like any other file;
 * they simply contribute no nodes or edges.
 */
export const TEXT_EXTENSIONS: Record<string, string> = {
  ".json": "json",
  ".jsonc": "json",
  ".json5": "json",
  ".lock": "text",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".ini": "toml",
  ".cfg": "toml",
  ".conf": "toml",
  ".env": "shell",
  ".md": "markdown",
  ".mdx": "markdown",
  ".markdown": "markdown",
  ".txt": "text",
  ".rst": "text",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".fish": "shell",
  ".sql": "sql",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".css": "css",
  ".scss": "css",
  ".less": "css",
  ".html": "html",
  ".htm": "html",
  ".xml": "html",
  ".svg": "html",
  ".vue": "html",
  ".svelte": "html",
  ".proto": "proto",
  ".gradle": "text",
  ".properties": "toml",
  ".dockerfile": "shell",
  ".gitignore": "text",
  ".editorconfig": "toml",
};

/** Extensionless files that are still worth watching by name. */
const TEXT_FILENAMES: Record<string, string> = {
  Dockerfile: "shell",
  Makefile: "shell",
  Procfile: "shell",
  ".gitignore": "text",
  ".dockerignore": "text",
  ".npmrc": "toml",
  ".nvmrc": "text",
  ".prettierrc": "json",
  ".eslintrc": "json",
  ".babelrc": "json",
  LICENSE: "text",
  README: "markdown",
};

/**
 * Display language for a file we track but do not parse, or null if it is not
 * a text file at all.
 */
export function textLanguageOf(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (TEXT_FILENAMES[name]) return TEXT_FILENAMES[name];
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return TEXT_EXTENSIONS[name.slice(dot)] ?? null;
}

const BY_EXT = new Map<string, LangSpec>();
for (const spec of Object.values(LANGUAGES)) {
  for (const ext of spec.extensions) BY_EXT.set(ext, spec);
}

export const SOURCE_EXTENSIONS = [...BY_EXT.keys()];

export function specForPath(path: string): LangSpec | null {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? null : (BY_EXT.get(path.slice(dot)) ?? null);
}
