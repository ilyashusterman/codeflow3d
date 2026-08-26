/**
 * One editor, on every surface.
 *
 * Code shows up in three places here — the floating screens (drawn into canvas
 * textures), flat mode's reader, and flat mode's editor mirror — and each one
 * used to carry its own copy of the colours and its own idea of how tall a line
 * is. The screens were the worst of it: they sized a line as `area / rows`, so
 * a twelve-row window on a big screen drew 19px glyphs on 100px lines and read
 * as a slide, not as code.
 *
 * So the look lives here once, in the shape a real editor uses: a fixed em
 * size, a line box a fixed multiple of it, and however many rows that leaves.
 * A bigger screen shows *more lines*, not bigger text — the same thing that
 * happens when you buy a bigger monitor. The palette and metrics are VSCode's
 * defaults (Dark Modern), because that is the editor these screens are
 * standing in for, and `applyEditorTheme` publishes them as CSS variables so
 * the DOM surfaces read from exactly the same numbers as the canvas.
 */
import { TOKEN_CLASSES, type TokenClass } from "@shared/protocol";

/** VSCode's default dark syntax colours, by our token class. */
export const TOKEN_COLORS: Record<TokenClass, string> = {
  plain: "#d4d4d4",
  ident: "#9cdcfe",
  keyword: "#569cd6",
  control: "#c586c0",
  string: "#ce9178",
  comment: "#6a9955",
  number: "#b5cea8",
  fn: "#dcdcaa",
  type: "#4ec9b0",
  punct: "#cccccc",
  op: "#d4d4d4",
};

/** Editor chrome, again from VSCode's defaults. */
export const EDITOR = {
  /** editor.background */
  bg: "#1f1f1f",
  /** editorGroupHeader / tab bar */
  tabBar: "#181818",
  tabActive: "#1f1f1f",
  /** The line VSCode draws under the active tab. */
  tabAccent: "#0078d4",
  border: "#2b2b2b",
  fg: "#cccccc",
  /** editorLineNumber.foreground / .activeForeground */
  gutter: "#6e7681",
  gutterActive: "#cccccc",
  /** editor.lineHighlightBackground, as a fill rather than a border: at screen
   *  distance a 1px border on a canvas texture disappears. */
  activeLine: "rgba(255,255,255,0.055)",
  indent: "#404040",
  /** editor.selectionBackground */
  selection: "#264f78",
  statusBar: "#181818",
  statusFg: "#9d9d9d",
  minimapSlider: "rgba(121,121,121,0.28)",
  scrollbar: "rgba(121,121,121,0.45)",
  /** diffEditor inserted/removed, and the git decoration colours for gutters. */
  addedBg: "rgba(155,185,85,0.17)",
  addedFg: "#81b88b",
  removedBg: "rgba(255,110,110,0.13)",
  removedFg: "#c74e39",
  removedFadedFg: "#8a5d55",
  /** VSCode's own "modified" tab colour, for a buffer with unsaved work. */
  dirty: "#e2c08d",
  /** The project's own layer: what the traced call graph runs through. */
  flowDef: "#4fc1ff",
  flowCall: "#c586c0",
  flowBody: "rgba(79,193,255,0.32)",
  flowDefBg: "rgba(79,193,255,0.06)",
  flowCallBg: "rgba(197,134,192,0.07)",
} as const;

/**
 * Type-level proof that the palette covers the protocol. A token class added
 * to the wire format without a colour here fails to compile rather than
 * silently rendering as `undefined` (which a canvas paints black).
 */
const _covered: Record<TokenClass, string> = TOKEN_COLORS;
void _covered;

export const EDITOR_FONT = 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace';

/**
 * Texture resolution per world unit for the screens. Lives here because it is
 * half of the em-size calculation: font size in pixels is `fontUnits *
 * pxPerUnit`, and the two numbers are only meaningful together.
 */
export const PX_PER_UNIT = 640;

export const METRICS = {
  /**
   * Em size of code on a screen, in world units. Constant across screens, so
   * every screen renders text at the same physical size and a larger screen
   * simply shows more of the file.
   */
  fontUnits: 0.0325,
  /** VSCode ships 14px text on 19px lines. */
  lineHeight: 1.4,
  /** What `expandTabs` in the shared tokenizer already normalises to. */
  tabSize: 2,
  /** Gutter width, in character cells: four digits and a space. */
  gutterChars: 5,
  /** Tab strip height and status bar height, in ems. */
  tabEms: 2.35,
  statusEms: 1.7,
  /** DOM surfaces: flat mode's reader and editor. */
  domFontPx: 13,
  /** Rows a screen must be able to fill before the buffer is the limit. */
  minRows: 6,
} as const;

export interface EditorMetrics {
  /** Frame inset: the screen's bezel. */
  pad: number;
  /** Tab strip. */
  tab: number;
  /** Status bar. */
  status: number;
  /** Code font size and line box, in canvas pixels. */
  font: number;
  lineH: number;
  /** The code viewport. */
  codeTop: number;
  codeH: number;
  /** Whole rows that fit — what the screen actually shows. */
  rows: number;
  /** Minimap strip width; 0 when the screen is too narrow to spare it. */
  minimap: number;
}

/**
 * Editor geometry for a canvas of this pixel size.
 *
 * Pure, and deliberately free of any canvas or DOM handle: it is the contract
 * between what the server sends (a buffer of lines) and what a screen can
 * show, so the end-to-end test checks it directly.
 */
export function editorMetrics(width: number, height: number, pxPerUnit: number): EditorMetrics {
  const pad = 8;
  const font = Math.max(8, Math.round(METRICS.fontUnits * pxPerUnit));
  const lineH = Math.max(font + 2, Math.round(font * METRICS.lineHeight));
  const tab = Math.round(font * METRICS.tabEms);
  const status = Math.round(font * METRICS.statusEms);
  const codeTop = pad + tab;
  const codeH = Math.max(lineH, height - pad * 2 - tab - status);
  const inner = width - pad * 2;
  return {
    pad,
    tab,
    status,
    font,
    lineH,
    codeTop,
    codeH,
    rows: Math.max(METRICS.minRows, Math.floor(codeH / lineH)),
    minimap: inner > font * 26 ? Math.round(Math.min(inner * 0.075, font * 3.4)) : 0,
  };
}

/**
 * Publish the theme as CSS variables.
 *
 * Called once at boot. The stylesheet then names `var(--tk-keyword)` and
 * friends and never a hex of its own, which is what keeps flat mode and the
 * screens from drifting apart the next time a colour is tuned.
 */
export function applyEditorTheme(root: HTMLElement = document.documentElement) {
  const set = (name: string, value: string) => root.style.setProperty(name, value);
  for (const c of TOKEN_CLASSES) set(`--tk-${c}`, TOKEN_COLORS[c]);
  for (const [key, value] of Object.entries(EDITOR)) {
    set(`--ed-${key.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())}`, value);
  }
  set("--ed-font", EDITOR_FONT);
  set("--ed-font-size", `${METRICS.domFontPx}px`);
  set("--ed-line-height", String(METRICS.lineHeight));
  set("--ed-gutter-width", `${METRICS.gutterChars + 1}ch`);
  set("--ed-tab-size", String(METRICS.tabSize));
}
