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
import { useCallback, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { DoubleSide, type Group } from "three";
import type { CodePanel, SceneGraph } from "@shared/protocol";
import { createCanvas, roundRect, toTexture } from "../lib/canvasTex";
import { useDisposed } from "../lib/useDisposable";
import { useStore } from "../state/store";
import { useScreenGrab } from "./Grab";

/** Texture resolution per world unit. High enough to read at close range. */
const PX_PER_UNIT = 640;

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

const TOKEN_HEX: Record<string, string> = {
  plain: "#c8d4e0",
  keyword: "#c678dd",
  string: "#98c379",
  comment: "#5b6675",
  number: "#d19a66",
  fn: "#61afef",
  type: "#e5c07b",
  punct: "#9aa8b8",
  op: "#56b6c2",
};

const LANG_ACCENT: Record<string, string> = {
  javascript: "#f0db4f",
  jsx: "#f0db4f",
  typescript: "#3178c6",
  tsx: "#3178c6",
  python: "#4b8bbe",
  go: "#00acd7",
  rust: "#dea584",
};

/** Colours for the flow rail: what the traced call graph runs through. */
const FLOW_HEX: Record<string, string> = {
  def: "#7fd0ff",
  call: "#c678dd",
  body: "rgba(127,208,255,0.35)",
};

function draw(
  panel: CodePanel,
  hovered: boolean,
  /** Which buffer line sits at the top of the screen; fractional while scrolling. */
  scroll: number,
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
) {
  ctx.clearRect(0, 0, w, h);
  const pad = 8;
  const bw = w - pad * 2;
  const bh = h - pad * 2;
  const bar = Math.max(26, Math.round(h * 0.062));

  // Body + glow. A file that just changed glows warm; that is the whole point
  // of the screen being on stage.
  ctx.save();
  ctx.shadowColor = panel.unsaved
    ? "rgba(120,215,255,0.75)"
    : panel.heat > 0.05
      ? `rgba(255,178,64,${0.4 + panel.heat * 0.55})`
      : hovered
        ? "rgba(127,208,255,0.5)"
        : "rgba(70,140,220,0.25)";
  ctx.shadowBlur = 20 + panel.heat * 40;
  ctx.fillStyle = "rgba(9,13,19,0.97)";
  roundRect(ctx, pad, pad, bw, bh, 9);
  ctx.fill();
  ctx.restore();

  ctx.save();
  roundRect(ctx, pad, pad, bw, bh, 9);
  ctx.clip();

  // ---- title bar
  const g = ctx.createLinearGradient(0, pad, 0, pad + bar);
  g.addColorStop(0, "rgba(40,49,63,0.99)");
  g.addColorStop(1, "rgba(26,33,44,0.99)");
  ctx.fillStyle = g;
  ctx.fillRect(pad, pad, bw, bar);

  ctx.fillStyle = LANG_ACCENT[panel.language] ?? "#7f8ea3";
  roundRect(ctx, pad + 12, pad + bar / 2 - 5, 10, 10, 3);
  ctx.fill();

  ctx.font = `600 ${Math.round(bar * 0.46)}px ui-monospace, "SF Mono", Menlo, monospace`;
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#eaf4ff";
  ctx.fillText(panel.title, pad + 30, pad + bar / 2 + 1);
  const titleWidth = ctx.measureText(panel.title).width;

  // ---- change counts, right where the eye already is
  let x = pad + 34 + titleWidth;
  ctx.font = `${Math.round(bar * 0.4)}px ui-monospace, Menlo, monospace`;
  if (panel.added) {
    ctx.fillStyle = "#56d67c";
    ctx.fillText(`+${panel.added}`, x, pad + bar / 2 + 1);
    x += ctx.measureText(`+${panel.added}`).width + 8;
  }
  if (panel.removed) {
    ctx.fillStyle = "#e0555c";
    ctx.fillText(`-${panel.removed}`, x, pad + bar / 2 + 1);
  }
  // An unsaved buffer is the most important thing a title bar can say: what
  // you are looking at is not what is on disk.
  const tag = panel.unsaved ? "unsaved" : panel.revisions > 1 ? `r${panel.revisions}` : "";
  if (tag) {
    ctx.fillStyle = panel.unsaved ? "#78d7ff" : "#5b6675";
    const tagWidth = ctx.measureText(tag).width;
    if (panel.unsaved) {
      ctx.beginPath();
      ctx.arc(pad + bw - tagWidth - 22, pad + bar / 2, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillText(tag, pad + bw - tagWidth - 12, pad + bar / 2 + 1);
  }

  // ---- code
  ctx.fillStyle = "rgba(11,16,23,0.98)";
  ctx.fillRect(pad, pad + bar, bw, bh - bar);

  const foot = Math.round(bar * 0.72);
  const area = bh - bar - foot;
  const rows = Math.max(1, panel.rows);
  const lineH = area / rows;
  const fontSize = Math.min(lineH * 0.72, 19);
  ctx.font = `${fontSize}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
  const charW = ctx.measureText("M").width;
  const gutter = charW * 5;
  const railX = pad + gutter + 4;
  const codeX = railX + 10;
  const maxX = pad + bw - 10;

  // Only the rows in view are drawn, offset by the fractional scroll so the
  // follow reads as a smooth crawl rather than a row-by-row jump.
  const first = Math.max(0, Math.min(panel.lines.length - rows, Math.floor(scroll)));
  const fraction = Math.max(0, Math.min(panel.lines.length - rows, scroll)) - first;
  ctx.save();
  ctx.beginPath();
  ctx.rect(pad, pad + bar, bw, area);
  ctx.clip();

  panel.lines.slice(first, first + rows + 1).forEach((line, i) => {
    const top = pad + bar + (i - fraction) * lineH;
    const y = top + lineH / 2;

    // Row tint: what changed in the last write.
    if (line.change === "add") {
      ctx.fillStyle = "rgba(86,214,124,0.14)";
      ctx.fillRect(pad, top, bw, lineH);
    } else if (line.change === "del") {
      ctx.fillStyle = "rgba(224,85,92,0.14)";
      ctx.fillRect(pad, top, bw, lineH);
    } else if (line.flow === "def") {
      ctx.fillStyle = "rgba(127,208,255,0.07)";
      ctx.fillRect(pad, top, bw, lineH);
    } else if (line.flow === "call") {
      ctx.fillStyle = "rgba(198,120,221,0.08)";
      ctx.fillRect(pad, top, bw, lineH);
    }

    // Flow rail: what the traced call graph runs through.
    if (line.flow) {
      ctx.fillStyle = FLOW_HEX[line.flow] ?? "#7fd0ff";
      ctx.fillRect(railX, top + 1, 3, Math.max(2, lineH - 2));
    }

    // Gutter: line number, or the change sign.
    ctx.textAlign = "right";
    if (line.change === "add") {
      ctx.fillStyle = "#56d67c";
      ctx.fillText(`+${line.n}`, pad + gutter, y);
    } else if (line.change === "del") {
      ctx.fillStyle = "#e0555c";
      ctx.fillText(`-${line.n}`, pad + gutter, y);
    } else {
      ctx.fillStyle = "#3f4c5c";
      ctx.fillText(String(line.n), pad + gutter, y);
    }
    ctx.textAlign = "left";

    // Code.
    let cx = codeX;
    for (const span of line.spans) {
      if (cx > maxX) break;
      ctx.fillStyle = line.change === "del" ? "#8d5f63" : TOKEN_HEX[span.c] ?? "#c8d4e0";
      const room = Math.max(0, Math.floor((maxX - cx) / charW));
      if (room <= 0) break;
      ctx.fillText(span.t.slice(0, room), cx, y);
      cx += span.t.length * charW;
    }
    if (line.change === "del") {
      ctx.strokeStyle = "rgba(224,85,92,0.45)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(codeX, y);
      ctx.lineTo(Math.min(maxX, cx), y);
      ctx.stroke();
    }
  });
  ctx.restore();

  // Scrollbar: where this window sits in the buffer.
  if (panel.lines.length > rows) {
    const trackH = area;
    const thumbH = Math.max(14, (rows / panel.lines.length) * trackH);
    const t = first / Math.max(1, panel.lines.length - rows);
    ctx.fillStyle = "rgba(122,152,184,0.14)";
    ctx.fillRect(pad + bw - 5, pad + bar, 3, trackH);
    ctx.fillStyle = "rgba(127,208,255,0.55)";
    ctx.fillRect(pad + bw - 5, pad + bar + t * (trackH - thumbH), 3, thumbH);
  }

  // ---- footer
  ctx.fillStyle = "rgba(16,22,30,0.98)";
  ctx.fillRect(pad, pad + bh - foot, bw, foot);
  ctx.font = `${Math.round(foot * 0.5)}px ui-monospace, Menlo, monospace`;
  ctx.fillStyle = "#4a5768";
  const label = panel.file.length > 52 ? "…" + panel.file.slice(-51) : panel.file;
  ctx.fillText(label, pad + 10, pad + bh - foot / 2);
  const hint = hovered
    ? "hold to grab · wheel to push/pull · double-click to open"
    : panel.unsaved
      ? `${panel.totalLines} lines · editing now`
      : `${panel.totalLines} lines`;
  ctx.fillStyle = hovered ? "#7fd0ff" : "#4a5768";
  ctx.textAlign = "right";
  ctx.fillText(hint, pad + bw - 10, pad + bh - foot / 2);
  ctx.textAlign = "left";
  ctx.restore();

  // ---- frame
  ctx.strokeStyle = panel.unsaved
    ? "rgba(120,215,255,0.95)"
    : panel.heat > 0.05
      ? `rgba(255,186,80,${0.5 + panel.heat * 0.5})`
      : hovered
        ? "rgba(127,208,255,0.9)"
        : panel.active
          ? "rgba(120,190,240,0.6)"
          : "rgba(84,112,142,0.42)";
  ctx.lineWidth = hovered || panel.heat > 0.05 || panel.unsaved ? 2.5 : 1.4;
  // Dashed while dirty — the same visual grammar every editor uses for "not
  // written yet".
  if (panel.unsaved) ctx.setLineDash([9, 5]);
  roundRect(ctx, pad, pad, bw, bh, 9);
  ctx.stroke();
  ctx.setLineDash([]);
}

function Panel({
  panel,
  index,
  count,
  onGrab,
  held,
}: {
  panel: CodePanel;
  index: number;
  count: number;
  onGrab: (target: { id: string; position: [number, number, number] }) => void;
  held: boolean;
}) {
  const group = useRef<Group>(null);
  const born = useRef(performance.now());
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
   * The scroll position, in buffer lines. It chases `focusLine` so an edit
   * anywhere in the file scrolls the screen to it — a tail, not a jump.
   */
  const target = useMemo(() => {
    const centred = panel.focusLine - panel.firstLine - Math.floor(panel.rows / 2);
    return Math.max(0, Math.min(panel.lines.length - panel.rows, centred));
  }, [panel.focusLine, panel.firstLine, panel.rows, panel.lines.length]);

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
  }>({ panel: null, surface: null, scroll: Number.NaN, hovered: false });

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

    // ---- entry settle
    const age = (performance.now() - born.current) / 1000;
    const ease = 1 - Math.pow(1 - Math.min(1, age / 0.4), 3);
    g.position.set(position[0], position[1] + (1 - ease) * 0.3, position[2]);
    g.scale.setScalar((0.94 + 0.06 * ease) * (held ? 1.06 : hovered ? 1.03 : 1));

    // ---- follow the newest change
    const wanted = tail ? target : scroll.current;
    if (Math.abs(scroll.current - wanted) > 0.002) {
      scroll.current += (wanted - scroll.current) * (1 - Math.exp(-7 * Math.min(0.05, dt)));
    } else {
      scroll.current = wanted;
    }

    // Repaint when the content, the scroll or the hover state has actually
    // moved — and always after a resize, since that canvas starts empty.
    const last = drawn.current;
    if (
      last.panel !== panel ||
      last.surface !== surface ||
      last.hovered !== hovered ||
      Math.abs(last.scroll - scroll.current) > 0.02
    ) {
      draw(panel, hovered, scroll.current, surface.ctx, surface.w, surface.h);
      surface.texture.needsUpdate = true;
      drawn.current = { panel, surface, scroll: scroll.current, hovered };
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
          map={surface.texture}
          transparent
          side={DoubleSide}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
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
    </group>
  );
}
