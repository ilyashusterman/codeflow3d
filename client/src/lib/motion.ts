/**
 * How new content arrives.
 *
 * A scene message is a whole new graph. Applied naively that is a single-frame
 * refresh: a file appears already drawn, new code replaces old code with
 * nothing in between, a definition that did not exist a second ago is
 * indistinguishable from one that has been there all along. The viewer's entire
 * job is to show change as it happens, and a cut shows none of it.
 *
 * So arrival takes time here, and the time is spent pointing at what changed:
 * a screen rises and paints itself in, the lines a write actually touched flash
 * and type themselves out, a new definition flares and settles, a screen that
 * lost its slot fades instead of vanishing. The timings and the one non-obvious
 * piece of logic — which lines are genuinely new — live here rather than in the
 * components, so both the scene and the DOM surfaces move to the same rhythm
 * and the "genuinely new" part can be tested against real scene messages.
 */
import type { CodePanel } from "@shared/protocol";

/** True when the viewer has asked their system for less movement. */
export const reducedMotion =
  typeof globalThis.matchMedia === "function" &&
  globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Transition lengths, in seconds.
 *
 * Long enough to read as movement, short enough that nothing waits on them —
 * and collapsed to a single frame when the viewer asked for that, since every
 * one of these is a flourish on information the colours already carry.
 */
export const MOTION = {
  /**
   * A screen opening: it slides into the row from the outside, fades up, and
   * paints the file in.
   */
  enter: reducedMotion ? 0.001 : 0.95,
  /**
   * A screen whose file lost its slot, sinking back out of the row.
   *
   * Deliberately unhurried. This was 0.45s, which is a real fade and still too
   * quick to register — by the time you look at the movement it is over, and a
   * screen you never saw leave reads as one that was never there. Leaving is
   * half of what the wall is saying.
   */
  leave: reducedMotion ? 0.001 : 0.95,
  /** The lines a write just changed, flashing and typing in. */
  reveal: reducedMotion ? 0.001 : 0.6,
  /** A definition seen for the first time, flaring into the graph. */
  birth: reducedMotion ? 0.001 : 1.1,
  /** A screen travelling to a slot that is not the one it was in. */
  slot: reducedMotion ? 0.001 : 0.55,
} as const;

/**
 * How long each screen waits before it follows a re-slot, in seconds per place
 * in the row.
 *
 * Slots are handed out by recency, so one new file shifts every screen behind it
 * along by one. Moving them all on the same frame is a wall that jumps; moving
 * them in order, a beat apart, is a queue making room — you can see *which way*
 * the row shifted, which is the only thing that jump was failing to say.
 */
export const SLOT_STAGGER = reducedMotion ? 0 : 0.055;

/** The delay before the screen in position `index` starts moving. */
export function queueDelay(index: number): number {
  return Math.max(0, index) * SLOT_STAGGER;
}

/**
 * One frame of an exponential glide toward a target.
 *
 * Frame-rate independent: the same wall-clock time covers the same fraction of
 * the distance at 30fps and at 144fps, which a naive `current += (target -
 * current) * 0.1` does not. `seconds` is the time to arrive for practical
 * purposes — five time constants, after which the remainder is under a percent
 * and the snap below finishes the job so nothing creeps forever.
 */
export function glide(current: number, target: number, dt: number, seconds: number): number {
  if (seconds <= 0 || dt <= 0) return target;
  const next = current + (target - current) * (1 - Math.exp((-5 * dt) / seconds));
  return Math.abs(target - next) < 0.0004 ? target : next;
}

/** Ease-out cubic: fast off the mark, settles rather than stops. */
export const easeOut = (t: number) => 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3);

/** The plain text of a highlighted line. */
export function lineText(line: CodePanel["lines"][number]) {
  let out = "";
  for (const span of line.spans) out += span.t;
  return out;
}

/**
 * Which buffer lines are new since the screen's last message.
 *
 * Diffed against the text the screen was already showing rather than read off
 * the change marks the server sends: a mark survives for as long as the file
 * stays hot, so trusting it would re-run the reveal on every scene message
 * until the heat decayed, and the screen would strobe. Text that differs from
 * the text this screen was already showing is the only honest definition of
 * new.
 *
 * The window can also *slide* between messages — following an edit moves it —
 * so a line that simply scrolled into the buffer is not new. Only a line
 * arriving with a change mark on it counts as one.
 */
export function freshLines(previous: CodePanel | null, next: CodePanel): Set<number> {
  const fresh = new Set<number>();
  if (!previous) return fresh;
  const before = new Map<number, string>();
  for (const line of previous.lines) before.set(line.n, lineText(line));
  for (const line of next.lines) {
    const known = before.get(line.n);
    if (known === undefined ? line.change !== null : known !== lineText(line)) fresh.add(line.n);
  }
  return fresh;
}
