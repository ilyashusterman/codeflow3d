/**
 * Grabbing a screen.
 *
 * Two earlier attempts were wrong in instructive ways. The first projected the
 * pointer onto a plane fixed at grab time, which stopped matching the camera
 * the moment you looked anywhere else. The second swung the object around you
 * on a sphere, which is what a headset does with a physical controller — but
 * with a mouse it means a small wrist movement throws the screen across the
 * room, and the object arcs instead of tracking your hand.
 *
 * What a mouse wants is a card on glass. The screen stays at a constant
 * distance and moves in the camera's own right/up plane, so a pixel of pointer
 * movement is a predictable amount of world movement and the screen tracks the
 * cursor exactly. Depth is a separate, deliberate control: the scroll wheel.
 * That is the same model every 2D canvas app uses, and it is the one people
 * already know.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Vector3 } from "three";

export interface GrabTarget {
  id: string;
  /** Where the object is right now. */
  position: [number, number, number];
}

interface GrabState {
  id: string;
  /** Distance from the camera, held constant unless the wheel changes it. */
  distance: number;
  /** Pointer position, in NDC, when the grab started. */
  fromX: number;
  fromY: number;
  /** Pointer in CSS pixels at grab time, for click-vs-drag detection. */
  clientX: number;
  clientY: number;
  /** Object position when the grab started. */
  origin: Vector3;
  /** Where the screen should be, recomputed on every pointer move. */
  goal: Vector3;
  /** Smoothed position, chasing the goal. */
  current: Vector3;
  /** True once the pointer has actually moved — a click is not a drag. */
  moved: boolean;
}

const MIN_DISTANCE = 1.2;
const MAX_DISTANCE = 60;
/** How fast the screen catches up. High enough to feel attached to the cursor. */
const FOLLOW = 26;
/** Pixels of pointer movement below which a press is a click, not a drag. */
const DRAG_THRESHOLD_PX = 5;

/**
 * Must be called from inside the Canvas — it drives the held object from the
 * render loop.
 *
 * @param onClick fires when the pointer was released without dragging.
 */
export function useScreenGrab(
  onMove: (id: string, pos: [number, number, number]) => void,
  onClick?: (id: string) => void,
) {
  const { camera, gl } = useThree();
  const [heldId, setHeldId] = useState<string | null>(null);
  const held = useRef<GrabState | null>(null);

  const right = useMemo(() => new Vector3(), []);
  const up = useMemo(() => new Vector3(), []);
  const target = useMemo(() => new Vector3(), []);
  /** Latest pointer position in CSS pixels, tracked continuously. */
  const client = useRef({ x: 0, y: 0 });

  /**
   * Recompute where the screen should sit for a pointer position.
   *
   * The pointer delta is converted through the view frustum at the held
   * distance, which is what makes a pixel of cursor movement the right amount
   * of world movement — the screen stays under the cursor instead of drifting
   * away from it.
   */
  const aimAt = useCallback(
    (state: GrabState, clientX: number, clientY: number) => {
      const rect = gl.domElement.getBoundingClientRect();
      const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
      const ndcY = -(((clientY - rect.top) / rect.height) * 2 - 1);
      const dx = ndcX - state.fromX;
      const dy = ndcY - state.fromY;

      const fov = "fov" in camera ? (camera.fov as number) : 50;
      const halfHeight = Math.tan((fov * Math.PI) / 360) * state.distance;
      const halfWidth = halfHeight * (rect.width / Math.max(1, rect.height));

      camera.updateMatrixWorld();
      camera.matrixWorld.extractBasis(right, up, target);
      state.goal
        .copy(state.origin)
        .addScaledVector(right, dx * halfWidth)
        .addScaledVector(up, dy * halfHeight);
      state.goal.y = Math.max(0.45, state.goal.y);
    },
    [camera, gl, right, up, target],
  );

  const grab = useCallback(
    (t: GrabTarget) => {
      const position = new Vector3(...t.position);
      const distance = Math.min(
        MAX_DISTANCE,
        Math.max(MIN_DISTANCE, position.distanceTo(camera.position)),
      );
      const rect = gl.domElement.getBoundingClientRect();
      held.current = {
        id: t.id,
        distance,
        fromX: ((client.current.x - rect.left) / rect.width) * 2 - 1,
        fromY: -(((client.current.y - rect.top) / rect.height) * 2 - 1),
        clientX: client.current.x,
        clientY: client.current.y,
        origin: position.clone(),
        goal: position.clone(),
        current: position.clone(),
        moved: false,
      };
      setHeldId(t.id);
      gl.domElement.style.cursor = "grabbing";
    },
    [camera, gl],
  );

  useEffect(() => {
    /**
     * Click-vs-drag is decided here rather than in the render loop. A quick
     * drag can start and finish inside a single frame, and a frame-based check
     * would score it as a click and fly the camera instead of moving the
     * screen — which is exactly what it used to do.
     */
    const track = (e: PointerEvent) => {
      client.current.x = e.clientX;
      client.current.y = e.clientY;
      const state = held.current;
      if (!state) return;
      if (!state.moved && Math.hypot(e.clientX - state.clientX, e.clientY - state.clientY) > DRAG_THRESHOLD_PX) {
        state.moved = true;
      }
      if (state.moved) aimAt(state, e.clientX, e.clientY);
    };
    const release = () => {
      const state = held.current;
      if (!state) return;
      held.current = null;
      setHeldId(null);
      gl.domElement.style.cursor = "";
      // A press that never moved is a click on the screen, not a drag of it.
      if (!state.moved) onClick?.(state.id);
    };
    const wheel = (e: WheelEvent) => {
      if (!held.current) return;
      // While a screen is held the wheel is its depth control, not the zoom, so
      // this has to run before OrbitControls sees the event.
      e.preventDefault();
      e.stopPropagation();
      const step = held.current.distance * 0.0016 * e.deltaY;
      held.current.distance = Math.min(
        MAX_DISTANCE,
        Math.max(MIN_DISTANCE, held.current.distance + step),
      );
      held.current.moved = true;
    };
    window.addEventListener("pointermove", track, { passive: true });
    window.addEventListener("pointerdown", track, { passive: true });
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("blur", release);
    window.addEventListener("wheel", wheel, { passive: false, capture: true });
    return () => {
      window.removeEventListener("pointermove", track);
      window.removeEventListener("pointerdown", track);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("blur", release);
      window.removeEventListener("wheel", wheel, { capture: true } as EventListenerOptions);
    };
  }, [gl, onClick, aimAt]);

  useFrame((_, rawDt) => {
    const state = held.current;
    if (!state || !state.moved) return;
    // The goal is set by the pointer; the frame loop only eases toward it, so
    // a drag that starts and ends inside one frame still lands correctly.
    const dt = Math.min(0.05, rawDt);
    state.current.lerp(state.goal, 1 - Math.exp(-FOLLOW * dt));
    onMove(state.id, [state.current.x, state.current.y, state.current.z]);
  });

  return { grab, heldId };
}
