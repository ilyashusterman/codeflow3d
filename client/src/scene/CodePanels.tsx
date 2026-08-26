/**
 * The floating screens.
 *
 * Each screen is a textured plane drawn on a 2D canvas at high resolution:
 * real geometry, one draw call, exports straight into the GLB, and no DOM in
 * the scene graph. An earlier version projected live DOM through a CSS3D layer
 * to get selectable text; it fought the canvas for layout and left stray
 * elements in the page, and it was never the right surface for editing anyway
 * — double-clicking a screen opens the file flat, which is where you read and
 * type. What belongs here is the *map*: which files are changing, what changed
 * in them, and which lines the traced call graph runs through.
 *
 * Screens can be dragged anywhere; where you put one is remembered per repo.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { DoubleSide, Vector3, type Group, type MeshBasicMaterial } from "three";
import type { CodePanel, SceneGraph } from "@shared/protocol";
import { createCanvas, roundRect, toTexture } from "../lib/canvasTex";
import { EDITOR, EDITOR_FONT, METRICS, PX_PER_UNIT, TOKEN_COLORS, editorMetrics } from "../lib/editorTheme";
import { MOTION, easeOut, freshLines, glide, lineText, queueDelay } from "../lib/motion";
import { useDisposed } from "../lib/useDisposable";
import { useStore } from "../state/store";
import { useScreenGrab } from "./Grab";

/**
 * Where each screen sits, per arrangement.
 *
 * `wall` is the default and is a real grid, not a row: it picks a column count
 * from how many screens there are, so five screens read as a tidy block rather
 * than a long strip you have to pan across. `stagger` steps them back in depth
 * when you want their order at a glance; `arc` bends the wall around the
 * viewing position so every screen is square-on.
 */
/**
 * How high the middle row floats.
 *
 * The screens sit above the call bundle rather than inside it: the graph is
 * what you read across, and screens threaded through it hide the very lines
 * they are tethered to.
 */
const BASE_HEIGHT = 2.6;

function gridShape(count: number): { cols: number; rows: number } {
  // Slightly wider than square — screens are landscape, and so are displays.
  const cols = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(count * 1.6))));
  return { cols, rows: Math.ceil(count / cols) };
}

export function arrange(
  index: number,
  count: number,
  mode: "stagger" | "wall" | "arc",
  size: [number, number],
): { pos: [number, number, number]; rotY: number } {
  const gapX = size[0] + 0.32;
  const gapY = size[1] + 0.3;

  if (mode === "wall") {
    const { cols, rows } = gridShape(count);
    const col = index % cols;
    const row = Math.floor(index / cols);
    // Centre the last row too, so an incomplete row does not sit off to one side.
    const inRow = Math.min(cols, count - row * cols);
    const x = (col - (inRow - 1) / 2) * gapX;
    const y = BASE_HEIGHT + ((rows - 1) / 2 - row) * gapY;
    return { pos: [x, Math.max(size[1] / 2 + 0.3, y), 0.8], rotY: 0 };
  }

  if (mode === "arc") {
    const { cols, rows } = gridShape(count);
    const col = index % cols;
    const row = Math.floor(index / cols);
    const inRow = Math.min(cols, count - row * cols);
    const radius = Math.max(4.5, (inRow * gapX) / 1.9);
    const spread = Math.min(Math.PI * 0.62, inRow * 0.42);
    const t = inRow === 1 ? 0 : col / (inRow - 1) - 0.5;
    const angle = t * spread;
    const y = BASE_HEIGHT + ((rows - 1) / 2 - row) * gapY;
    return {
      pos: [
        Math.sin(angle) * radius,
        Math.max(size[1] / 2 + 0.3, y),
        Math.cos(angle) * radius - radius + 1.4,
      ],
      rotY: -angle,
    };
  }

  return { pos: [0, 0, 0], rotY: 0 };
}

const LANG_ACCENT: Record<string, string> = {
  javascript: "#f0db4f",
  jsx: "#f0db4f",
  typescript: "#3178c6",
  tsx: "#3178c6",
  python: "#4b8bbe",
  go: "#00acd7",
  rust: "#dea584",
};

/** Where a screen is in its transitions, as the frame loop sees it. */
interface Motion {
  /** 0..1 while the screen is opening, 1 once open. */
  enter: number;
  /** 0..1 while the newest lines paint in, 1 once settled. */
  reveal: number;
  /** Buffer lines the last message actually changed — what `reveal` reveals. */
  fresh: Set<number>;
}

const OPEN: Motion = { enter: 1, reveal: 1, fresh: new Set() };

/**
 * A screen, drawn as the editor it is standing in for.
 *
 * The layout is VSCode's, in this order: tab strip, then the editor proper —
 * gutter, flow rail, code, minimap — then the status bar. Everything is placed
 * off `editorMetrics`, so a line box is a fixed multiple of the em size on
 * every screen and a bigger screen shows more of the file instead of the same
 * dozen lines stretched to fit.
 */
function draw(
  panel: CodePanel,
  hovered: boolean,
  /** Which buffer line sits at the top of the screen; fractional while scrolling. */
  scroll: number,
  motion: Motion,
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
) {
  const m = editorMetrics(w, h, PX_PER_UNIT);
  ctx.clearRect(0, 0, w, h);
  const { pad } = m;
  const bw = w - pad * 2;
  const bh = h - pad * 2;

  // Body + glow. A file that just changed glows warm; that is the whole point
  // of the screen being on stage. The window itself is VSCode-grey — the glow
  // is the map talking, not the editor.
  ctx.save();
  ctx.shadowColor = panel.unsaved
    ? "rgba(226,192,141,0.7)"
    : panel.heat > 0.05
      ? `rgba(255,178,64,${0.4 + panel.heat * 0.55})`
      : hovered
        ? "rgba(0,120,212,0.55)"
        : "rgba(40,70,110,0.28)";
  ctx.shadowBlur = 20 + panel.heat * 40;
  ctx.fillStyle = EDITOR.bg;
  roundRect(ctx, pad, pad, bw, bh, 7);
  ctx.fill();
  ctx.restore();

  ctx.save();
  roundRect(ctx, pad, pad, bw, bh, 7);
  ctx.clip();

  // ---------------------------------------------------------------- tab strip
  ctx.fillStyle = EDITOR.tabBar;
  ctx.fillRect(pad, pad, bw, m.tab);
  ctx.textBaseline = "middle";
  const tabMid = pad + m.tab / 2;

  const titleFont = Math.round(m.font * 0.95);
  ctx.font = `${titleFont}px ${EDITOR_FONT}`;
  const titleWidth = ctx.measureText(panel.title).width;
  const tabW = Math.min(bw - m.font * 6, titleWidth + m.font * 4.6);

  ctx.fillStyle = EDITOR.tabActive;
  ctx.fillRect(pad, pad, tabW, m.tab);
  // The line VSCode draws along an active tab, and the border under the strip.
  ctx.fillStyle = panel.unsaved ? EDITOR.dirty : panel.active ? EDITOR.tabAccent : "rgba(0,120,212,0.5)";
  ctx.fillRect(pad, pad, tabW, 2);
  ctx.fillStyle = EDITOR.border;
  ctx.fillRect(pad, pad + m.tab - 1, bw, 1);

  // File-type dot, in place of an icon font.
  ctx.fillStyle = LANG_ACCENT[panel.language] ?? "#7f8ea3";
  const dot = Math.max(4, Math.round(m.font * 0.34));
  roundRect(ctx, pad + m.font, tabMid - dot / 2, dot, dot, 2);
  ctx.fill();

  const titleX = pad + m.font * 1.1 + dot + m.font * 0.55;
  ctx.fillStyle = panel.unsaved ? EDITOR.dirty : EDITOR.fg;
  ctx.fillText(panel.title, titleX, tabMid);

  // A tab's dirty dot: what you are looking at is not what is on disk.
  if (panel.unsaved) {
    ctx.beginPath();
    ctx.arc(titleX + titleWidth + m.font * 0.85, tabMid, Math.max(2.5, m.font * 0.19), 0, Math.PI * 2);
    ctx.fill();
  }

  // ---- change counts, on the strip beside the tab
  ctx.font = `${Math.round(m.font * 0.85)}px ${EDITOR_FONT}`;
  let x = pad + tabW + m.font * 0.8;
  if (panel.added) {
    ctx.fillStyle = EDITOR.addedFg;
    ctx.fillText(`+${panel.added}`, x, tabMid);
    x += ctx.measureText(`+${panel.added}`).width + m.font * 0.5;
  }
  if (panel.removed) {
    ctx.fillStyle = EDITOR.removedFg;
    ctx.fillText(`-${panel.removed}`, x, tabMid);
  }
  if (panel.revisions > 1 && !panel.unsaved) {
    const tag = `r${panel.revisions}`;
    ctx.fillStyle = EDITOR.statusFg;
    ctx.fillText(tag, pad + bw - ctx.measureText(tag).width - m.font * 0.7, tabMid);
  }

  // ------------------------------------------------------------------- editor
  ctx.fillStyle = EDITOR.bg;
  ctx.fillRect(pad, m.codeTop, bw, m.codeH);

  ctx.font = `${m.font}px ${EDITOR_FONT}`;
  const charW = ctx.measureText("0").width;
  const gutterRight = pad + charW * METRICS.gutterChars;
  const railX = gutterRight + Math.round(charW * 0.55);
  const railW = Math.max(2, Math.round(charW * 0.22));
  const codeX = railX + Math.round(charW * 1.1);
  const minimapX = pad + bw - m.minimap;
  const maxX = (m.minimap ? minimapX : pad + bw) - charW;

  // Only the rows in view are drawn, offset by the fractional scroll so the
  // follow reads as a smooth crawl rather than a row-by-row jump.
  const rows = Math.min(m.rows, Math.max(1, panel.lines.length));
  const span = Math.max(0, panel.lines.length - rows);
  const first = Math.max(0, Math.min(span, Math.floor(scroll)));
  const fraction = Math.max(0, Math.min(span, scroll)) - first;

  ctx.save();
  ctx.beginPath();
  ctx.rect(pad, m.codeTop, bw, m.codeH);
  ctx.clip();

  // Opening a screen paints the editor in: a bright rule travels down the
  // viewport and rows appear as it passes them. A window filling, not blinking
  // into existence.
  const sweepY = motion.enter < 1 ? m.codeTop + m.codeH * easeOut(motion.enter) : Infinity;
  const revealed = easeOut(motion.reveal);

  panel.lines.slice(first, first + rows + 1).forEach((line, i) => {
    const top = m.codeTop + (i - fraction) * m.lineH;
    if (top > sweepY) return;
    const y = top + m.lineH / 2;
    const text = lineText(line);
    /** This line is part of what the newest message changed. */
    const fresh = motion.reveal < 1 && motion.fresh.has(line.n);

    // Row tint: what changed in the last write, then the current line, then
    // what the traced call graph runs through.
    if (line.change === "add") {
      ctx.fillStyle = EDITOR.addedBg;
      ctx.fillRect(pad, top, bw, m.lineH);
    } else if (line.change === "del") {
      ctx.fillStyle = EDITOR.removedBg;
      ctx.fillRect(pad, top, bw, m.lineH);
    } else if (line.n === panel.focusLine) {
      ctx.fillStyle = EDITOR.activeLine;
      ctx.fillRect(pad, top, bw, m.lineH);
    } else if (line.flow === "def") {
      ctx.fillStyle = EDITOR.flowDefBg;
      ctx.fillRect(pad, top, bw, m.lineH);
    } else if (line.flow === "call") {
      ctx.fillStyle = EDITOR.flowCallBg;
      ctx.fillRect(pad, top, bw, m.lineH);
    }

    // A line that just changed flashes and fades to its ordinary diff tint,
    // so the eye lands on the newest edit without being told where it is.
    if (fresh) {
      ctx.fillStyle = `rgba(190,225,255,${0.34 * (1 - motion.reveal)})`;
      ctx.fillRect(pad, top, bw, m.lineH);
    }

    // Indent guides, at the tab stops the tokenizer already normalises to.
    const indent = text.length - text.trimStart().length;
    if (indent > 0) {
      ctx.fillStyle = EDITOR.indent;
      for (let col = METRICS.tabSize; col < indent; col += METRICS.tabSize) {
        ctx.fillRect(Math.round(codeX + col * charW), top, 1, m.lineH);
      }
    }

    // Flow rail: the project's own layer, where a breakpoint gutter would be.
    if (line.flow) {
      ctx.fillStyle =
        line.flow === "def" ? EDITOR.flowDef : line.flow === "call" ? EDITOR.flowCall : EDITOR.flowBody;
      ctx.fillRect(railX, top + 1, railW, Math.max(2, m.lineH - 2));
    }

    // Line numbers, right-aligned, the current one brighter — VSCode exactly.
    ctx.textAlign = "right";
    if (line.change === "add") ctx.fillStyle = EDITOR.addedFg;
    else if (line.change === "del") ctx.fillStyle = EDITOR.removedFg;
    else ctx.fillStyle = line.n === panel.focusLine ? EDITOR.gutterActive : EDITOR.gutter;
    ctx.fillText(
      line.change === "add" ? `+${line.n}` : line.change === "del" ? `-${line.n}` : String(line.n),
      gutterRight,
      y,
    );
    ctx.textAlign = "left";

    // Code. A fresh line types itself in rather than appearing whole: the
    // reveal is clipped from the left, at the same rate for every changed line
    // so a hunk reads as one movement.
    if (fresh) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(codeX - 2, top, Math.max(0, (maxX - codeX) * revealed + 3), m.lineH);
      ctx.clip();
    }
    let cx = codeX;
    for (const s of line.spans) {
      if (cx > maxX) break;
      ctx.fillStyle = line.change === "del" ? EDITOR.removedFadedFg : TOKEN_COLORS[s.c] ?? EDITOR.fg;
      const room = Math.max(0, Math.floor((maxX - cx) / charW));
      if (room <= 0) break;
      ctx.fillText(s.t.slice(0, room), cx, y);
      cx += s.t.length * charW;
    }
    if (line.change === "del") {
      ctx.strokeStyle = EDITOR.removedFg;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(codeX, y);
      ctx.lineTo(Math.min(maxX, cx), y);
      ctx.stroke();
    }
    if (fresh) ctx.restore();
  });

  // The leading edge of the opening sweep.
  if (motion.enter < 1) {
    const fade = ctx.createLinearGradient(0, sweepY - m.lineH * 3, 0, sweepY);
    fade.addColorStop(0, "rgba(120,190,255,0)");
    fade.addColorStop(1, "rgba(120,190,255,0.28)");
    ctx.fillStyle = fade;
    const from = Math.max(m.codeTop, sweepY - m.lineH * 3);
    ctx.fillRect(pad, from, bw, sweepY - from);
    ctx.fillStyle = "rgba(205,232,255,0.8)";
    ctx.fillRect(pad, sweepY - 1, bw, 1.5);
  }
  ctx.restore();

  // ------------------------------------------------------------------ minimap
  // The whole buffer at a glance, drawn as VSCode draws it: one short row per
  // line, token-coloured, with the viewport as a slider over it. On a screen
  // too narrow to spare the width it degrades to a scrollbar.
  if (m.minimap) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(minimapX, m.codeTop, m.minimap, m.codeH);
    ctx.clip();
    const rowH = Math.min(3, m.codeH / Math.max(1, panel.lines.length));
    const scale = m.minimap / 96;
    ctx.globalAlpha = 0.62;
    panel.lines.forEach((line, i) => {
      const top = m.codeTop + i * rowH;
      if (top > m.codeTop + m.codeH) return;
      let col = 0;
      for (const s of line.spans) {
        if (s.c !== "plain") {
          ctx.fillStyle = TOKEN_COLORS[s.c] ?? EDITOR.fg;
          ctx.fillRect(minimapX + col * scale, top, Math.max(scale, s.t.length * scale), Math.max(1, rowH - 1));
        }
        col += s.t.length;
        if (col * scale > m.minimap) break;
      }
    });
    ctx.globalAlpha = 1;
    if (panel.lines.length > rows) {
      const total = rowH * panel.lines.length;
      ctx.fillStyle = EDITOR.minimapSlider;
      ctx.fillRect(minimapX, m.codeTop + (first / panel.lines.length) * total, m.minimap, (rows / panel.lines.length) * total);
    }
    ctx.restore();
  } else if (panel.lines.length > rows) {
    const thumb = Math.max(14, (rows / panel.lines.length) * m.codeH);
    const t = first / Math.max(1, span);
    ctx.fillStyle = EDITOR.scrollbar;
    ctx.fillRect(pad + bw - 5, m.codeTop + t * (m.codeH - thumb), 3, thumb);
  }

  // --------------------------------------------------------------- status bar
  const statusY = pad + bh - m.status;
  ctx.fillStyle = EDITOR.statusBar;
  ctx.fillRect(pad, statusY, bw, m.status);
  ctx.fillStyle = EDITOR.border;
  ctx.fillRect(pad, statusY, bw, 1);
  ctx.font = `${Math.round(m.font * 0.8)}px ${EDITOR_FONT}`;
  ctx.fillStyle = EDITOR.statusFg;
  const label = panel.file.length > 52 ? "…" + panel.file.slice(-51) : panel.file;
  ctx.fillText(label, pad + m.font * 0.7, statusY + m.status / 2);
  const right = hovered
    ? "hold to grab · wheel to push/pull · double-click to open"
    : panel.unsaved
      ? `Ln ${panel.focusLine} · unsaved · ${panel.totalLines} lines`
      : `Ln ${panel.focusLine}  Spaces: ${METRICS.tabSize}  ${panel.language}  ${panel.totalLines} lines`;
  ctx.fillStyle = hovered ? "#cfe6ff" : EDITOR.statusFg;
  ctx.textAlign = "right";
  ctx.fillText(right, pad + bw - m.font * 0.7, statusY + m.status / 2);
  ctx.textAlign = "left";
  ctx.restore();

  // ---- frame
  // A change pulses it: the same "look here" the tab strip gives, at a size
  // that carries from across the scene.
  const pulse = 1 - motion.reveal;
  ctx.strokeStyle =
    pulse > 0.01
      ? `rgba(150,205,255,${0.5 + 0.5 * pulse})`
      : panel.unsaved
        ? EDITOR.dirty
        : panel.heat > 0.05
          ? `rgba(255,186,80,${0.5 + panel.heat * 0.5})`
          : hovered
            ? EDITOR.tabAccent
            : panel.active
              ? "rgba(0,120,212,0.6)"
              : EDITOR.border;
  ctx.lineWidth = (hovered || panel.heat > 0.05 || panel.unsaved ? 2.5 : 1.4) + pulse * 2.2;
  // Dashed while dirty — the same visual grammar every editor uses for "not
  // written yet".
  if (panel.unsaved) ctx.setLineDash([9, 5]);
  roundRect(ctx, pad, pad, bw, bh, 7);
  ctx.stroke();
  ctx.setLineDash([]);
}

function Panel({
  panel,
  index,
  count,
  onGrab,
  held,
  exiting = false,
}: {
  panel: CodePanel;
  index: number;
  count: number;
  onGrab: (target: { id: string; position: [number, number, number] }) => void;
  held: boolean;
  /** The file lost its slot: this screen is closing, not open. */
  exiting?: boolean;
}) {
  const group = useRef<Group>(null);
  const material = useRef<MeshBasicMaterial>(null);
  const born = useRef(performance.now());
  /**
   * Where this screen actually is, as opposed to where its slot is.
   *
   * Slots are handed out by recency, so one new file shifts every screen behind
   * it along by one — and writing the slot straight into the transform made that
   * a hard cut: the whole wall changed places between two frames, with nothing
   * to say which way anything went. The screen now travels there, and the
   * screens travel in order (see `queueDelay`), so the row visibly makes room.
   */
  const at = useRef<Vector3 | null>(null);
  /** The slot last aimed at, and when this screen is allowed to start moving. */
  const aim = useRef<{ slot: string; startAt: number }>({ slot: "", startAt: 0 });
  const closedAt = useRef<number | null>(null);
  if (exiting && closedAt.current === null) closedAt.current = performance.now();
  const [hovered, setHovered] = useState(false);
  const moved = useStore((s) => s.panelPos[panel.file]);
  const faced = useStore((s) => s.panelRot[panel.file]);
  const setZoomed = useStore((s) => s.setZoomed);
  const { screenLayout, screenScale, tail } = useStore((s) => s.view);

  // Depend on the pixel dimensions, not on `panel.size`. Every scene message
  // carries a freshly parsed array, so an array-identity dependency changes on
  // every single update — which is what used to throw the canvas away and
  // replace it with a blank one on every keystroke.
  const width = Math.round(panel.size[0] * screenScale * PX_PER_UNIT);
  const height = Math.round(panel.size[1] * screenScale * PX_PER_UNIT);
  const size = useMemo(
    () => [width / PX_PER_UNIT, height / PX_PER_UNIT] as [number, number],
    [width, height],
  );
  const slot = useMemo(
    () => arrange(index, count, screenLayout, size),
    [index, count, screenLayout, size],
  );
  // A screen you dragged stays where you put it, whatever the arrangement, and
  // one you turned to face you keeps that angle too.
  const position = moved ?? (screenLayout === "stagger" ? panel.pos : slot.pos);
  const rotY =
    faced ?? (moved ? panel.rotY : screenLayout === "stagger" ? panel.rotY : slot.rotY);

  /**
   * How many rows this screen shows.
   *
   * Resolved from the screen's own pixel size, not from `panel.rows`: the
   * server cannot know how large the viewer scaled its screens, and a line box
   * is a fixed height here — so the row count is a property of the screen, and
   * the server's figure is only the buffer it sized around it.
   */
  const rows = useMemo(
    () => editorMetrics(width, height, PX_PER_UNIT).rows,
    [width, height],
  );

  /**
   * The scroll position, in buffer lines. It chases `focusLine` so an edit
   * anywhere in the file scrolls the screen to it — a tail, not a jump.
   */
  const target = useMemo(() => {
    const centred = panel.focusLine - panel.firstLine - Math.floor(rows / 2);
    return Math.max(0, Math.min(panel.lines.length - rows, centred));
  }, [panel.focusLine, panel.firstLine, rows, panel.lines.length]);

  const scroll = useRef(target);

  /**
   * What the canvas currently shows.
   *
   * Object identity is the signal: the server sends only the screens that
   * changed and the store preserves the previous object for the rest, so a new
   * `panel` object means new content — including for unsaved edits, which never
   * bump `revisions` because nothing was written. Deriving a signature from
   * metadata instead is a trap: two different edits of the same shape share
   * every count, and the screen would silently stop updating.
   */
  const drawn = useRef<{
    panel: CodePanel | null;
    surface: unknown;
    scroll: number;
    hovered: boolean;
    enter: number;
    reveal: number;
  }>({ panel: null, surface: null, scroll: Number.NaN, hovered: false, enter: -1, reveal: -1 });

  /** What the last message actually changed, and when it landed. */
  const motion = useRef<{ at: number; fresh: Set<number>; content: CodePanel | null }>({
    at: 0,
    fresh: new Set(),
    content: null,
  });

  if (motion.current.content !== panel) {
    const fresh = freshLines(motion.current.content, panel);
    motion.current.content = panel;
    if (fresh.size) {
      motion.current.fresh = fresh;
      motion.current.at = performance.now();
    }
  }

  // The canvas is owned and repainted in place: scrolling, and now typing,
  // must not rebuild a texture.
  const surface = useDisposed(() => {
    const made = createCanvas(width, height);
    const texture = toTexture(made.canvas);
    return {
      ...made,
      texture,
      dispose() {
        texture.dispose();
      },
    };
  }, [width, height]);

  useFrame((state, dt) => {
    const g = group.current;
    if (!g) return;
    const now = performance.now();

    // ---- opening, and closing
    //
    // A screen rises into its slot and fades up over `MOTION.enter`; one that lost
    // its slot sinks and fades out over `MOTION.leave` instead of vanishing between
    // two frames. Both are the same curve, so a file that appears and is gone
    // again reads as one gesture.
    const enter = Math.min(1, (now - born.current) / 1000 / MOTION.enter);
    const leave = closedAt.current === null ? 0 : Math.min(1, (now - closedAt.current) / 1000 / MOTION.leave);
    const rise = easeOut(enter);

    // Where the slot says it belongs, including the arrival and departure
    // offsets. A screen arrives from outside the row and to the back, so joining
    // reads as *joining* rather than materialising in place; one that is leaving
    // sinks and recedes out of it.
    const gone = easeOut(leave);
    const wantX = position[0] - (1 - rise) * 0.6;
    const wantY = position[1] + (1 - rise) * 0.18 - gone * 0.55;
    const wantZ = position[2] - (1 - rise) * 0.45 - gone * 0.5;

    // A slot change starts a queued move: this screen waits its turn, then
    // travels. A screen in hand is exempt — a dragged screen must track the
    // cursor exactly, and lag there reads as the app fighting you.
    const slot = `${position[0]},${position[1]},${position[2]}`;
    if (aim.current.slot !== slot) {
      aim.current = { slot, startAt: now + queueDelay(index) * 1000 };
    }
    if (!at.current) {
      at.current = new Vector3(wantX, wantY, wantZ);
    } else if (held || now >= aim.current.startAt) {
      const seconds = held ? 0 : MOTION.slot;
      at.current.set(
        glide(at.current.x, wantX, dt, seconds),
        glide(at.current.y, wantY, dt, seconds),
        glide(at.current.z, wantZ, dt, seconds),
      );
    }
    g.position.copy(at.current);
    // A touch of overshoot on the way in: it arrives, it does not slide to a halt.
    const spring = 1 + 0.045 * Math.sin(Math.PI * rise) * (1 - rise);
    g.scale.setScalar(
      (0.88 + 0.12 * rise) * spring * (1 - 0.24 * gone) * (held ? 1.06 : hovered ? 1.03 : 1),
    );
    if (material.current) {
      // Fades over the whole arrival rather than snapping opaque in the first
      // fifth of it: the fade is the part you actually see from across the scene.
      material.current.opacity = easeOut(Math.min(1, enter * 1.15)) * (1 - gone);
    }

    const reveal = motion.current.fresh.size
      ? Math.min(1, (now - motion.current.at) / 1000 / MOTION.reveal)
      : 1;

    // ---- follow the newest change
    const wanted = tail ? target : scroll.current;
    if (Math.abs(scroll.current - wanted) > 0.002) {
      scroll.current += (wanted - scroll.current) * (1 - Math.exp(-7 * Math.min(0.05, dt)));
    } else {
      scroll.current = wanted;
    }

    // Repaint when the content, the scroll, the hover state or a transition has
    // actually moved — and always after a resize, since that canvas starts
    // empty. Comparing the transition values rather than testing `< 1` is what
    // guarantees one final frame at rest, with no sweep line left drawn on it.
    const last = drawn.current;
    if (
      last.panel !== panel ||
      last.surface !== surface ||
      last.hovered !== hovered ||
      last.enter !== enter ||
      last.reveal !== reveal ||
      Math.abs(last.scroll - scroll.current) > 0.02
    ) {
      const shape = enter >= 1 && reveal >= 1 ? OPEN : { enter, reveal, fresh: motion.current.fresh };
      draw(panel, hovered, scroll.current, shape, surface.ctx, surface.w, surface.h);
      surface.texture.needsUpdate = true;
      drawn.current = { panel, surface, scroll: scroll.current, hovered, enter, reveal };
    }

    // ---- a held screen turns to face you, as a grabbed panel does in a headset
    if (held) {
      const k = 1 - Math.exp(-6 * Math.min(0.05, dt));
      const face = Math.atan2(
        state.camera.position.x - g.position.x,
        state.camera.position.z - g.position.z,
      );
      let delta = face - g.rotation.y;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      g.rotation.y += delta * k;
    } else {
      g.rotation.y += (rotY - g.rotation.y) * (1 - Math.exp(-8 * Math.min(0.05, dt)));
    }
  });

  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();

  return (
    <group ref={group} name={`panel:${panel.file}`} position={position} rotation={[0, rotY, 0]}>
      <mesh
        // A closing screen is a farewell, not a target: it must not swallow the
        // pointer on its way out.
        raycast={exiting ? () => {} : undefined}
        onPointerOver={(e) => {
          stop(e);
          setHovered(true);
          document.body.style.cursor = "grab";
        }}
        onPointerMove={(e) => stop(e)}
        onPointerOut={() => {
          setHovered(false);
          document.body.style.cursor = "";
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          stop(e);
          onGrab({ id: panel.file, position });
        }}
        onDoubleClick={(e) => {
          // Fly in and fill the frame. Reading the file is what a screen is
          // for; editing lives in the change log, not behind a double-click.
          stop(e);
          setZoomed(panel.file);
        }}
      >
        <planeGeometry args={size} />
        <meshBasicMaterial
          ref={material}
          map={surface.texture}
          transparent
          opacity={0}
          side={DoubleSide}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}

/** A screen still on stage after its file lost the slot, with the slot it had. */
interface Closing {
  panel: CodePanel;
  index: number;
  count: number;
}

export function CodePanels({ scene }: { scene: SceneGraph }) {
  const movePanel = useStore((s) => s.movePanel);
  const facePanel = useStore((s) => s.facePanel);
  const panelPos = useStore((s) => s.panelPos);
  const camera = useThree((s) => s.camera);

  /**
   * A click turns the screen to face you.
   *
   * Not a camera move — you asked to read this one, so it comes to you rather
   * than you going to it. The yaw is stored, so it keeps facing that way until
   * you click it again from somewhere else or reset the screens.
   */
  const onClickScreen = useCallback(
    (file: string) => {
      const panel = scene.panels.find((p) => p.file === file);
      if (!panel) return;
      const index = scene.panels.indexOf(panel);
      const size: [number, number] = [panel.size[0], panel.size[1]];
      const slot = arrange(index, scene.panels.length, "wall", size);
      const at = panelPos[file] ?? slot.pos;
      facePanel(file, Math.atan2(camera.position.x - at[0], camera.position.z - at[2]));
    },
    [scene.panels, panelPos, facePanel, camera],
  );
  const { grab, heldId } = useScreenGrab(movePanel, onClickScreen);

  /**
   * Screens on their way out.
   *
   * Slots are handed to whatever changed most recently, so a screen loses its
   * place whenever a new file becomes interesting. Dropping it from the scene
   * graph the instant that happens is the "single frame refresh" this replaces:
   * the screen is kept, in the slot it held, for exactly as long as it takes to
   * fade out — and taken back off the list the moment its file returns.
   */
  const [closing, setClosing] = useState<Closing[]>([]);
  const shown = useRef<CodePanel[]>([]);

  useEffect(() => {
    const live = new Set(scene.panels.map((p) => p.file));
    const gone: Closing[] = shown.current
      .map((panel, index) => ({ panel, index, count: shown.current.length }))
      .filter((entry) => !live.has(entry.panel.file));
    shown.current = scene.panels;

    setClosing((current) => {
      const kept = current.filter(
        (entry) => !live.has(entry.panel.file) && !gone.some((g) => g.panel.file === entry.panel.file),
      );
      return kept.length === current.length && !gone.length ? current : [...kept, ...gone];
    });
    if (!gone.length) return;

    const timer = setTimeout(
      () =>
        setClosing((current) =>
          current.filter((entry) => !gone.some((g) => g.panel.file === entry.panel.file)),
        ),
      MOTION.leave * 1000 + 80,
    );
    return () => clearTimeout(timer);
  }, [scene.panels]);

  return (
    <group name="code-panels">
      {scene.panels.map((panel, i) => (
        <Panel
          key={panel.file}
          panel={panel}
          index={i}
          count={scene.panels.length}
          onGrab={grab}
          held={heldId === panel.file}
        />
      ))}
      {closing.map((entry) => (
        <Panel
          key={`closing:${entry.panel.file}`}
          panel={entry.panel}
          index={entry.index}
          count={entry.count}
          onGrab={grab}
          held={false}
          exiting
        />
      ))}
    </group>
  );
}
