/** Wire protocol shared by the Bun server and the React/three client. */

export type FileEventKind = "add" | "change" | "unlink" | "addDir" | "unlinkDir" | "editing";

export interface FileEvent {
  kind: FileEventKind;
  /** Repo-relative POSIX path. */
  path: string;
  /** Epoch ms when the watcher observed it. */
  at: number;
  /** Bytes on disk (0 for deletions). */
  size: number;
  language: string | null;
  /** Lines added / removed, when this was a content change we could diff. */
  added?: number;
  removed?: number;
  /** True when this write came from the viewer's own editor. */
  fromEditor?: boolean;
  /** True when this is an unsaved editor buffer rather than a write to disk. */
  unsaved?: boolean;
  /**
   * Reconstructed from disk mtime when the repo was opened, not observed by the
   * watcher. The write was real; we simply were not running when it happened.
   */
  seeded?: boolean;
  /**
   * A second notification of a write already applied — the content on disk is
   * byte-identical to what we hold. Dropped before it reaches the feed.
   */
  duplicate?: boolean;
  /**
   * The first few changed lines, verbatim. The feed shows what changed, not
   * just that something did — a filename and a count is not seeing a change.
   */
  hunk?: { type: "add" | "del"; line: number; text: string }[];
}

/**
 * How an edge was resolved. `import`/`member`/`local` are backed by bindings
 * actually in scope; `unique`/`weak` are name-match inference and are drawn
 * differently so the two are never confused.
 */
export type EdgeConfidence = "local" | "import" | "member" | "unique" | "weak";

export type CallKind = "call" | "new" | "render" | "method";

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

/** A definition in the graph, placed in world space. */
export interface SceneNode {
  id: string;
  name: string;
  /** `Class.method` / `Type::method` where applicable. */
  qualified: string;
  file: string;
  language: string;
  kind: DefKind;
  startLine: number;
  endLine: number;
  isEntry: boolean;
  isExported: boolean;
  isAsync: boolean;
  container: string | null;
  fanIn: number;
  fanOut: number;
  /** Longest distance from any entry point. */
  depth: number;
  /** 0..1 edit recency; 1 = just written. */
  heat: number;
  /** Colour-bar domain value. */
  scalar: number;
  pos: [number, number, number];
}

export interface SceneEdge {
  from: string;
  to: string;
  line: number;
  kind: CallKind;
  confidence: EdgeConfidence;
}

/** One rendered streamline: a real call path, bundled through module trunks. */
export interface Streamline {
  id: string;
  /** Node ids visited, in order. */
  nodeIds: string[];
  /** Flattened xyz triples of the centreline. */
  points: number[];
  /** Per-point colour-bar scalar. */
  scalars: number[];
  weight: number;
  /** Entry-point node id this trace belongs to. */
  flowId: string;
  /** Weakest hop on the path. */
  confidence: EdgeConfidence;
}

/** A file-to-file import, from the observed import graph. */
export interface ImportLink {
  from: string;
  to: string;
  /** How many bound names travel this edge. */
  weight: number;
  points: number[];
}

export type ChangeMark = "add" | "del" | null;

/** What role a source line plays in the graph, for line-level colouring. */
export type FlowMark =
  /** The line opens a definition that is on a traced flow. */
  | "def"
  /** The line contains a resolved call that is on a traced flow. */
  | "call"
  /** Inside a definition that is on a traced flow. */
  | "body"
  | null;

export interface CodeLine {
  n: number;
  /** Syntax-highlighted spans. */
  spans: { t: string; c: TokenClass }[];
  /** Added or deleted in the last write. */
  change: ChangeMark;
  /** Role in the call flow. */
  flow: FlowMark;
  /** Definition this line belongs to, when known. */
  nodeId?: string;
}

/**
 * Token classes, as a value: every code surface (the canvas screens, flat
 * mode's reader, flat mode's editor mirror) has to colour all of them, and a
 * bare union type cannot be iterated to check that they do.
 *
 * The split follows what a real editor theme distinguishes — a declaration
 * keyword (`const`, `function`) is not coloured like a control keyword
 * (`return`, `if`), and a plain identifier is not coloured like whitespace.
 */
export const TOKEN_CLASSES = [
  "plain",
  "ident",
  "keyword",
  "control",
  "string",
  "comment",
  "number",
  "fn",
  "type",
  "punct",
  "op",
] as const;

export type TokenClass = (typeof TOKEN_CLASSES)[number];

/** A floating editor screen. */
export interface CodePanel {
  id: string;
  file: string;
  language: string;
  title: string;
  /**
   * A buffer of lines around the action — larger than the screen shows. The
   * screen scrolls inside it, so following an edit is a smooth move rather
   * than a jump to a fresh window.
   */
  lines: CodeLine[];
  totalLines: number;
  /** First line number in `lines`. */
  firstLine: number;
  /** The line to keep in view: the most recent change, when there is one. */
  focusLine: number;
  /** How many rows the screen displays at once. */
  rows: number;
  pos: [number, number, number];
  rotY: number;
  size: [number, number];
  /** 0..1, 1 = just written. */
  heat: number;
  added: number;
  removed: number;
  /** How many times this file changed since the repo was opened. */
  revisions: number;
  /** Epoch ms of the last content change, or null if never changed here. */
  changedAt: number | null;
  /**
   * The file is open in an editor with unsaved changes, and what is shown is
   * that buffer rather than what is on disk.
   */
  unsaved: boolean;
  /** True for files tracked for their content only — no graph nodes. */
  textOnly: boolean;
  active: boolean;
}

/** Directory tree, drawn as the node-link diagram. */
export interface TreeNode {
  id: string;
  label: string;
  depth: number;
  isDir: boolean;
  pos: [number, number, number];
  parent: string | null;
  heat: number;
}

export interface SceneStats {
  files: number;
  /** Definitions in the whole graph. */
  nodes: number;
  /** Call edges in the whole graph. */
  edges: number;
  /** How many nodes were actually sent — the rest are off-screen detail. */
  sentNodes: number;
  importEdges: number;
  externalDeps: number;
  entryPoints: number;
  streamlines: number;
  /** Calls that resolved to nothing in this repo (usually into packages). */
  unresolvedCalls: number;
  byConfidence: Record<string, number>;
  languages: Record<string, number>;
  /** Editor backup stores being watched for unsaved buffers. */
  backupStores: number;
  /** Unsaved buffers observed since this repo was opened. */
  unsavedSeen: number;
  /** Buffers pushed in over the socket or `/api/buffer`. */
  pushedBuffers: number;
  analyzeMs: number;
  layoutMs: number;
  rev: number;
}

export interface SceneGraph {
  rev: number;
  root: string;
  projectName: string;
  activeFile: string | null;
  nodes: SceneNode[];
  edges: SceneEdge[];
  streamlines: Streamline[];
  importLinks: ImportLink[];
  panels: CodePanel[];
  tree: TreeNode[];
  stats: SceneStats;
  /** Colour-bar domain [min, max]. */
  domain: [number, number];
}

/** Full text of one file, for the in-scene editor. */
export interface FileSource {
  file: string;
  language: string | null;
  source: string;
  /** Server-side revision, echoed back on save to detect clobbering. */
  revisions: number;
  readOnly: boolean;
}

/** Server -> client. */
export type ServerMsg =
  | { t: "hello"; watching: string | null; rev: number; languages: string[] }
  | { t: "scene"; scene: SceneGraph; events: FileEvent[] }
  /**
   * A partial update: only the sections that actually changed.
   *
   * The scene is not one blob, and treating it as one is what made saving feel
   * like a re-render. Typing changes a file's text; it rarely changes the call
   * graph, and even when it does (a new line shifts every definition below it)
   * the streamline geometry and the directory tree are usually untouched.
   *
   * So each section travels only when its content differs from what this client
   * was last sent, and the screens are narrowed further to the individual files
   * that moved. A full `scene` is now only sent once, when a repo is opened.
   * Absent fields mean "unchanged" — the client keeps what it has, which also
   * preserves object identity so React re-renders exactly the subtrees that
   * changed.
   */
  | {
      t: "patch";
      rev: number;
      /** Only the screens that changed, merged by file, unless `stage` is given. */
      panels?: CodePanel[];
      /** The full ordered list of on-screen files, when it changed. */
      stage?: string[];
      nodes?: SceneNode[];
      edges?: SceneEdge[];
      streamlines?: Streamline[];
      importLinks?: ImportLink[];
      tree?: TreeNode[];
      domain?: [number, number];
      stats: SceneStats;
      activeFile: string | null;
      events: FileEvent[];
    }
  | { t: "status"; phase: "analyzing" | "idle" | "watching" | "error"; detail?: string; progress?: number }
  | { t: "event"; event: FileEvent }
  | { t: "log"; level: "info" | "warn" | "error"; msg: string };

/** Client -> server. */
export type ClientMsg =
  | { t: "watch"; path: string }
  | { t: "reanalyze" }
  | { t: "focus"; file: string }
  | { t: "pin"; files: string[] }
  | { t: "config"; tracesPerPath?: number; maxPanels?: number; bundle?: number }
  /**
   * Push a buffer's current text, as an editor holds it.
   *
   * This is the realtime path: an action dispatched the moment the text
   * changes, rather than a state polled from an editor's backup store. Scanning
   * backups can only ever be as live as the editor's own write cadence — about
   * a second after you stop typing — so an editor that dispatches this on every
   * change is the difference between live and realtime.
   */
  | { t: "buffer"; file: string; content: string }
  /** Withdraw a pushed buffer — the editor saved or closed it. */
  | { t: "bufferClosed"; file: string };
