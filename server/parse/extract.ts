/**
 * Runs the per-language queries over one file and produces the raw facts the
 * resolver needs: definitions with byte ranges, import bindings, and call
 * sites. Nothing here guesses at cross-file meaning — that is the resolver's
 * job, and keeping the two apart is what makes the edges auditable.
 */
import Parser from "web-tree-sitter";
import { LANGUAGES, type LangSpec, type LangId } from "./languages";

export type DefKind =
  | "function"
  | "method"
  | "class"
  | "component"
  | "interface"
  | "type"
  | "enum"
  | "struct"
  | "trait"
  | "module";

export interface Definition {
  /**
   * `file::qualified`, with a `::n` suffix for the second and later definitions
   * that share a name in one file. Deliberately carries no line number, so an
   * edit above a definition does not change its identity — see the note where
   * these are built.
   */
  id: string;
  name: string;
  /** `Class.method` / `Type::method` where applicable, else `name`. */
  qualified: string;
  kind: DefKind;
  file: string;
  startLine: number;
  endLine: number;
  startByte: number;
  endByte: number;
  exported: boolean;
  isAsync: boolean;
  /** Enclosing class/impl/trait name, if any. */
  container: string | null;
}

export interface ImportBinding {
  /** Name as used in this file. */
  local: string;
  /** Name as exported by the target (`default` for default imports). */
  imported: string;
  /** True when the whole module is bound (`import * as x`, `use m::*`). */
  namespace: boolean;
}

export interface ImportRecord {
  /** Raw specifier text, e.g. `./auth.js`, `.util`, `crate::helper`. */
  source: string;
  bindings: ImportBinding[];
  line: number;
  /** Rust `mod x;` declares a child module rather than importing names. */
  isModuleDecl: boolean;
}

export type CallKind = "call" | "new" | "render" | "method";

export interface CallSite {
  callee: string;
  /** Receiver text for member/method calls (`foo` in `foo.bar()`). */
  receiver: string | null;
  kind: CallKind;
  line: number;
  byte: number;
}

export interface FileFacts {
  file: string;
  language: LangId;
  definitions: Definition[];
  imports: ImportRecord[];
  calls: CallSite[];
  /** Symbols this file exports, by exported name. */
  exports: Map<string, Definition>;
  /** `export default` / `pub fn main`-style default, if identifiable. */
  defaultExport: Definition | null;
  lineCount: number;
}

// ------------------------------------------------------------------ grammars

type TSLanguage = Parser.Language;
type TSNode = Parser.SyntaxNode;

let initialized: Promise<void> | null = null;
const grammars = new Map<string, TSLanguage>();
const queries = new Map<string, Parser.Query>();
const parsers = new Map<LangId, Parser>();

export async function initParsers(wasmDir: string): Promise<void> {
  initialized ??= Parser.init({ locateFile: () => `${wasmDir}/tree-sitter.wasm` });
  await initialized;
}

async function grammarFor(spec: LangSpec, wasmDir: string): Promise<TSLanguage> {
  const cached = grammars.get(spec.grammar);
  if (cached) return cached;
  const language = await Parser.Language.load(`${wasmDir}/${spec.grammar}`);
  grammars.set(spec.grammar, language);
  return language;
}

function queryFor(language: TSLanguage, key: string, source: string): Parser.Query {
  const cacheKey = `${key}`;
  const cached = queries.get(cacheKey);
  if (cached) return cached;
  const compiled = language.query(source);
  queries.set(cacheKey, compiled);
  return compiled;
}

/** Warm every grammar and compile every query once, up front. */
export async function warmup(wasmDir: string): Promise<LangId[]> {
  await initParsers(wasmDir);
  const ready: LangId[] = [];
  for (const spec of Object.values(LANGUAGES)) {
    try {
      const language = await grammarFor(spec, wasmDir);
      const parser = new Parser();
      parser.setLanguage(language);
      parsers.set(spec.id, parser);
      queryFor(language, `${spec.id}:def`, spec.defQuery);
      queryFor(language, `${spec.id}:call`, spec.callQuery);
      queryFor(language, `${spec.id}:import`, spec.importQuery);
      ready.push(spec.id);
    } catch (err) {
      console.error(`[parse] ${spec.id} unavailable:`, err instanceof Error ? err.message : err);
    }
  }
  return ready;
}

// -------------------------------------------------------------------- helpers

function hasAncestor(node: TSNode, types: string[], stopAt?: number): boolean {
  for (let n: TSNode | null = node.parent; n; n = n.parent) {
    if (stopAt !== undefined && n.startIndex < stopAt) break;
    if (types.includes(n.type)) return true;
  }
  return false;
}

function nearestAncestorOfType(node: TSNode, types: string[]): TSNode | null {
  for (let n: TSNode | null = node.parent; n; n = n.parent) {
    if (types.includes(n.type)) return n;
  }
  return null;
}

/** Name of the enclosing class / impl block, for qualifying methods. */
function containerName(node: TSNode, language: LangId): string | null {
  if (language === "python") {
    const cls = nearestAncestorOfType(node, ["class_definition"]);
    return cls?.childForFieldName("name")?.text ?? null;
  }
  if (language === "rust") {
    const impl = nearestAncestorOfType(node, ["impl_item", "trait_item"]);
    if (!impl) return null;
    // `impl Trait for Type` — the type is what callers name.
    return impl.childForFieldName("type")?.text ?? impl.childForFieldName("name")?.text ?? null;
  }
  if (language === "go") {
    const recv = node.childForFieldName?.("receiver");
    const t = recv?.descendantsOfType("type_identifier")[0];
    return t?.text ?? null;
  }
  const cls = nearestAncestorOfType(node, ["class_declaration", "class"]);
  return cls?.childForFieldName("name")?.text ?? null;
}

function isExported(node: TSNode, language: LangId): boolean {
  if (language === "rust") {
    for (let i = 0; i < node.childCount; i++) {
      if (node.child(i)?.type === "visibility_modifier") return true;
    }
    return false;
  }
  if (language === "python") {
    // Python has no export keyword; leading underscore is the convention.
    const name = node.childForFieldName("name")?.text ?? "";
    return !name.startsWith("_");
  }
  if (language === "go") {
    const name = node.childForFieldName("name")?.text ?? "";
    return /^[A-Z]/.test(name);
  }
  return hasAncestor(node, ["export_statement"]);
}

const KIND_BY_TYPE: Record<string, DefKind> = {
  function_declaration: "function",
  generator_function_declaration: "function",
  function_definition: "function",
  function_item: "function",
  method_definition: "method",
  method_declaration: "method",
  class_declaration: "class",
  class_definition: "class",
  interface_declaration: "interface",
  type_alias_declaration: "type",
  enum_declaration: "enum",
  enum_item: "enum",
  struct_item: "struct",
  trait_item: "trait",
  type_spec: "class",
  variable_declarator: "function",
  public_field_definition: "method",
};

/** React components are functions, but they are worth telling apart. */
function refineKind(kind: DefKind, name: string, language: LangId, body: string): DefKind {
  const jsx = language === "tsx" || language === "jsx" || language === "javascript" || language === "typescript";
  if (jsx && kind === "function" && /^[A-Z]/.test(name) && /<[A-Za-z]/.test(body)) return "component";
  return kind;
}

// ------------------------------------------------------------------- imports

function parseJsImport(node: TSNode): ImportRecord | null {
  const source = node.childForFieldName("source")?.text?.slice(1, -1);
  if (!source) return null;
  const bindings: ImportBinding[] = [];
  const clause = node.namedChildren.find((c) => c.type === "import_clause");
  if (clause) {
    for (const child of clause.namedChildren) {
      if (child.type === "identifier") {
        bindings.push({ local: child.text, imported: "default", namespace: false });
      } else if (child.type === "namespace_import") {
        const local = child.namedChildren.find((c) => c.type === "identifier")?.text;
        if (local) bindings.push({ local, imported: "*", namespace: true });
      } else if (child.type === "named_imports") {
        for (const spec of child.namedChildren) {
          if (spec.type !== "import_specifier") continue;
          const name = spec.childForFieldName("name")?.text;
          const alias = spec.childForFieldName("alias")?.text;
          if (name) bindings.push({ local: alias ?? name, imported: name, namespace: false });
        }
      }
    }
  }
  return { source, bindings, line: node.startPosition.row + 1, isModuleDecl: false };
}

function parsePythonImport(node: TSNode): ImportRecord[] {
  const line = node.startPosition.row + 1;
  if (node.type === "import_from_statement") {
    const moduleNode = node.childForFieldName("module_name");
    const source = moduleNode?.text ?? "";
    const bindings: ImportBinding[] = [];
    let wildcard = false;
    for (const child of node.namedChildren) {
      if (child === moduleNode) continue;
      if (child.type === "wildcard_import") wildcard = true;
      else if (child.type === "dotted_name" || child.type === "identifier") {
        bindings.push({ local: child.text, imported: child.text, namespace: false });
      } else if (child.type === "aliased_import") {
        const name = child.childForFieldName("name")?.text;
        const alias = child.childForFieldName("alias")?.text;
        if (name) bindings.push({ local: alias ?? name, imported: name, namespace: false });
      }
    }
    if (wildcard) bindings.push({ local: "*", imported: "*", namespace: true });
    return source ? [{ source, bindings, line, isModuleDecl: false }] : [];
  }
  // `import a.b.c` / `import a as b`
  const out: ImportRecord[] = [];
  for (const child of node.namedChildren) {
    if (child.type === "dotted_name") {
      const source = child.text;
      const local = source.split(".").pop()!;
      out.push({ source, bindings: [{ local, imported: "*", namespace: true }], line, isModuleDecl: false });
    } else if (child.type === "aliased_import") {
      const source = child.childForFieldName("name")?.text ?? "";
      const alias = child.childForFieldName("alias")?.text;
      if (source && alias) {
        out.push({ source, bindings: [{ local: alias, imported: "*", namespace: true }], line, isModuleDecl: false });
      }
    }
  }
  return out;
}

/** `use a::b::{c, d as e};` → source `a::b`, bindings c and e→d. */
function parseRustUse(arg: TSNode, line: number): ImportRecord[] {
  const walk = (node: TSNode, prefix: string): ImportRecord[] => {
    if (node.type === "scoped_use_list") {
      const path = node.childForFieldName("path")?.text ?? "";
      const list = node.childForFieldName("list");
      const nextPrefix = prefix ? `${prefix}::${path}` : path;
      if (!list) return [];
      return list.namedChildren.flatMap((c) => walk(c, nextPrefix));
    }
    if (node.type === "use_list") {
      return node.namedChildren.flatMap((c) => walk(c, prefix));
    }
    if (node.type === "use_as_clause") {
      const path = node.childForFieldName("path");
      const alias = node.childForFieldName("alias")?.text;
      const name = path?.text.split("::").pop() ?? "";
      const modulePath = [prefix, ...(path?.text.split("::").slice(0, -1) ?? [])].filter(Boolean).join("::");
      return [{ source: modulePath, bindings: [{ local: alias ?? name, imported: name, namespace: false }], line, isModuleDecl: false }];
    }
    if (node.type === "use_wildcard") {
      const path = node.namedChildren[0]?.text ?? "";
      const modulePath = [prefix, path].filter(Boolean).join("::");
      return [{ source: modulePath, bindings: [{ local: "*", imported: "*", namespace: true }], line, isModuleDecl: false }];
    }
    if (node.type === "scoped_identifier" || node.type === "identifier") {
      const parts = [prefix, node.text].filter(Boolean).join("::").split("::");
      const name = parts.pop()!;
      const modulePath = parts.join("::");
      // `use helper::normalize` binds `normalize`; `use helper` binds the module.
      if (!modulePath) {
        return [{ source: name, bindings: [{ local: name, imported: "*", namespace: true }], line, isModuleDecl: false }];
      }
      return [{ source: modulePath, bindings: [{ local: name, imported: name, namespace: false }], line, isModuleDecl: false }];
    }
    if (node.type === "self") return [];
    return [];
  };
  return walk(arg, "");
}

// ------------------------------------------------------------------- extract

export interface ExtractOptions {
  file: string;
  source: string;
  spec: LangSpec;
  wasmDir: string;
}

export async function extract({ file, source, spec, wasmDir }: ExtractOptions): Promise<FileFacts> {
  await initParsers(wasmDir);
  const language = await grammarFor(spec, wasmDir);
  let parser = parsers.get(spec.id);
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(language);
    parsers.set(spec.id, parser);
  } else {
    parser.setLanguage(language);
  }

  const tree = parser.parse(source);
  const root = tree.rootNode;

  // ---- definitions
  const definitions: Definition[] = [];
  /** How many definitions have shared each `file::qualified`, for stable ids. */
  const occurrences = new Map<string, number>();
  const defQuery = queryFor(language, `${spec.id}:def`, spec.defQuery);
  for (const match of defQuery.matches(root)) {
    const defNode = match.captures.find((c) => c.name === "def")?.node;
    const nameNode = match.captures.find((c) => c.name === "name")?.node;
    if (!defNode || !nameNode) continue;
    const name = nameNode.text;
    if (!name) continue;

    // Walk ancestors from the definition itself, not its name: starting at the
    // name would make a class its own container.
    const container = containerName(defNode, spec.id);
    const kindBase = KIND_BY_TYPE[defNode.type] ?? "function";
    const kind = refineKind(
      container && (kindBase === "function" || kindBase === "method") ? "method" : kindBase,
      name,
      spec.id,
      source.slice(defNode.startIndex, Math.min(defNode.endIndex, defNode.startIndex + 4000)),
    );
    const separator = spec.id === "rust" ? "::" : ".";
    const qualified = container ? `${container}${separator}${name}` : name;
    const startLine = defNode.startPosition.row + 1;

    // Identity is deliberately independent of where the definition sits.
    //
    // The id used to embed `startLine`, which meant inserting a blank line at
    // the top of a file renamed every definition below it. Downstream that
    // reads as "the entire graph changed": the cached layout is thrown away,
    // and hundreds of kilobytes of streamline geometry that did not move are
    // re-sent on a keystroke. Numbering same-named definitions by their order
    // in the file keeps ids stable across edits while still telling apart two
    // overloads or two methods that share a name.
    const seen = (occurrences.get(`${file}::${qualified}`) ?? 0) + 1;
    occurrences.set(`${file}::${qualified}`, seen);

    definitions.push({
      id: seen === 1 ? `${file}::${qualified}` : `${file}::${qualified}::${seen}`,
      name,
      qualified,
      kind,
      file,
      startLine,
      endLine: defNode.endPosition.row + 1,
      startByte: defNode.startIndex,
      endByte: defNode.endIndex,
      exported: isExported(defNode, spec.id),
      isAsync: /^\s*(export\s+)?(pub\s+)?async\b/.test(source.slice(defNode.startIndex, defNode.startIndex + 40)),
      container,
    });
  }

  // Deduplicate: overlapping patterns (e.g. a TS method matched twice).
  const seen = new Set<string>();
  const uniqueDefs = definitions.filter((d) => {
    if (seen.has(d.id)) return false;
    seen.add(d.id);
    return true;
  });

  // ---- calls
  const calls: CallSite[] = [];
  const callQuery = queryFor(language, `${spec.id}:call`, spec.callQuery);
  for (const match of callQuery.matches(root)) {
    const isRender = match.captures.some((c) => c.name === "render");
    const calleeNode = match.captures.find((c) => c.name === "callee")?.node;
    if (!calleeNode) continue;
    const callee = calleeNode.text;
    if (!callee || spec.builtins.has(callee)) continue;
    const recvNode = match.captures.find((c) => c.name === "recv")?.node;
    const site = match.captures.find((c) => c.name === "call" || c.name === "render")?.node ?? calleeNode;
    const isNew = site.type === "new_expression";
    calls.push({
      callee,
      receiver: recvNode ? recvNode.text.slice(0, 120) : null,
      kind: isRender ? "render" : isNew ? "new" : recvNode ? "method" : "call",
      line: site.startPosition.row + 1,
      byte: site.startIndex,
    });
  }

  // ---- imports
  const imports: ImportRecord[] = [];
  const importQuery = queryFor(language, `${spec.id}:import`, spec.importQuery);
  for (const match of importQuery.matches(root)) {
    const line = match.captures[0]!.node.startPosition.row + 1;
    if (spec.style === "node") {
      const importNode = match.captures.find((c) => c.name === "import")?.node;
      if (importNode) {
        const rec = parseJsImport(importNode);
        if (rec) imports.push(rec);
        continue;
      }
      const reexport = match.captures.find((c) => c.name === "reexport_source")?.node;
      if (reexport) {
        imports.push({
          source: reexport.text.slice(1, -1),
          bindings: [{ local: "*", imported: "*", namespace: true }],
          line,
          isModuleDecl: false,
        });
        continue;
      }
      const req = match.captures.find((c) => c.name === "req")?.node;
      const reqSource = match.captures.find((c) => c.name === "req_source")?.node;
      if (req?.text === "require" && reqSource) {
        imports.push({
          source: reqSource.text.slice(1, -1),
          bindings: [{ local: "*", imported: "*", namespace: true }],
          line,
          isModuleDecl: false,
        });
      }
    } else if (spec.style === "python") {
      const node = match.captures.find((c) => c.name === "import")?.node;
      if (node) imports.push(...parsePythonImport(node));
    } else if (spec.style === "rust") {
      const useArg = match.captures.find((c) => c.name === "use_arg")?.node;
      if (useArg) {
        imports.push(...parseRustUse(useArg, line));
        continue;
      }
      const modName = match.captures.find((c) => c.name === "mod_name")?.node;
      const modNode = match.captures.find((c) => c.name === "mod")?.node;
      // `mod x { ... }` is inline; only `mod x;` points at another file.
      if (modName && modNode && !modNode.childForFieldName("body")) {
        imports.push({
          source: modName.text,
          bindings: [{ local: modName.text, imported: "*", namespace: true }],
          line,
          isModuleDecl: true,
        });
      }
    } else if (spec.style === "go") {
      const src = match.captures.find((c) => c.name === "source")?.node;
      if (src) {
        const source = src.text.replace(/^["`]|["`]$/g, "");
        imports.push({
          source,
          bindings: [{ local: source.split("/").pop()!, imported: "*", namespace: true }],
          line,
          isModuleDecl: false,
        });
      }
    }
  }

  tree.delete();

  const exports = new Map<string, Definition>();
  for (const d of uniqueDefs) {
    if (d.exported && !exports.has(d.name)) exports.set(d.name, d);
  }
  const defaultExport =
    uniqueDefs.find((d) => d.exported && new RegExp(`export\\s+default`).test(source.slice(Math.max(0, d.startByte - 30), d.startByte + 10))) ?? null;

  return {
    file,
    language: spec.id,
    definitions: uniqueDefs,
    imports,
    calls,
    exports,
    defaultExport,
    lineCount: source.split("\n").length,
  };
}
