/**
 * Navigation.
 *
 * Two modes, because the scene is used two ways. **Orbit** frames the graph
 * from outside — right for reading the shape of a repository. **Fly** puts you
 * inside it: pointer-lock look, WASD to move, Q/E for altitude, shift to
 * sprint. Flying is how you get close enough to a screen to read and edit it.
 *
 * Typing always wins: while an editor has focus the movement keys go to the
 * textarea, never to the camera.
 */
import { useEffect, useMemo, useRef } from "react";
import { OrbitControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { Box3, Euler, Vector3 } from "three";
import type { SceneGraph } from "@shared/protocol";
import { useStore } from "../state/store";

/** Where the camera looks when there is nothing to fit to yet. */
const TARGET = new Vector3(-1.25, 1.15, 0.7);
export const HOME = new Vector3(8.9, 5.5, 11.7);
const DESIGN_FOV = 33;
const DESIGN_ASPECT = 1.6;
const DESIGN_TAN_H = DESIGN_ASPECT * Math.tan((DESIGN_FOV / 2) * (Math.PI / 180));

const MOVE_KEYS = new Set([
  "KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "ShiftLeft", "ShiftRight", "Space",
]);

/** True when the keyboard belongs to an input, not the camera. */
function typingSomewhere(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el as HTMLElement).isContentEditable;
}

/** Widen the fov on narrow viewports so the graph's width survives. */
function useAspectFov() {
  const camera = useThree((s) => s.camera);
  const aspect = useThree((s) => s.size.width / Math.max(1, s.size.height));
  useEffect(() => {
    if (!("isPerspectiveCamera" in camera)) return;
    const perspective = camera as typeof camera & { fov: number; updateProjectionMatrix(): void };
    const wanted = 2 * Math.atan(DESIGN_TAN_H / Math.max(0.35, aspect)) * (180 / Math.PI);
    perspective.fov = Math.min(62, Math.max(DESIGN_FOV, wanted));
    perspective.updateProjectionMatrix();
  }, [camera, aspect]);
}

/**
 * Where to stand to see this particular repository.
 *
 * The scene's extent depends entirely on the graph — a 6-file project and a
 * 600-file one are wildly different sizes — so the camera is fitted to the
 * actual node bounds rather than parked at a constant that only suits one of
 * them. The viewing *angle* is fixed; only the distance and centre move.
 */
function fitToScene(scene: SceneGraph | null, aspect: number) {
  if (!scene?.nodes.length) return { target: TARGET.clone(), position: HOME.clone() };

  const box = new Box3();
  const p = new Vector3();
  for (const node of scene.nodes) box.expandByPoint(p.fromArray(node.pos));
  for (const panel of scene.panels) box.expandByPoint(p.fromArray(panel.pos));

  const target = box.getCenter(new Vector3());
  const size = box.getSize(new Vector3());
  // Frame the widest of the three extents, with the narrow-viewport penalty
  // folded in so a tall window still sees the whole graph.
  const radius = Math.max(size.x, size.y * 1.6, size.z) * 0.5;
  const distance = Math.max(6, (radius / Math.max(0.4, Math.min(1.6, aspect))) * 2.1);

  const direction = HOME.clone().sub(TARGET).normalize();
  return { target, position: target.clone().addScaledVector(direction, distance) };
}

function OrbitMode({ scene }: { scene: SceneGraph | null }) {
  const controls = useRef<{
    update(dt?: number): void;
    autoRotate: boolean;
    autoRotateSpeed: number;
    target: Vector3;
  } | null>(null);
  const autoOrbit = useStore((s) => s.view.autoOrbit);
  const orbitTarget = useStore((s) => s.orbitTarget);
  const camera = useThree((s) => s.camera);
  const aspect = useThree((s) => s.size.width / Math.max(1, s.size.height));

  useMovement((delta) => {
    // Carry the orbit centre along, or the graph would swing around a point
    // the camera has already flown past.
    controls.current?.target.add(delta);
  });

  // Re-frame when the repository changes, never on an edit: the camera must
  // not jump while you are reading or typing.
  const root = scene?.root ?? null;
  const fit = useMemo(() => fitToScene(scene, aspect), [root, aspect]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * The pivot is set imperatively, never as a prop.
   *
   * drei re-applies `target` on every render, and this component re-renders
   * whenever anything upstream does — the camera read-out alone ticks a few
   * times a second. Passing the pivot as a prop therefore reset it constantly,
   * which undid keyboard strafing between frames and made A/D and the arrow
   * keys feel stuck. Written here, it moves only when something actually means
   * to move it.
   */
  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    // A camera flight leaves its own pivot behind; adopt it instead of
    // snapping back to the whole-graph framing.
    if (orbitTarget) {
      c.target.set(...orbitTarget);
      c.update();
      return;
    }
    camera.position.copy(fit.position);
    camera.lookAt(fit.target);
    c.target.copy(fit.target);
    c.update();
  }, [camera, fit, orbitTarget]);

  useFrame((_, dt) => {
    const c = controls.current;
    if (!c) return;
    c.autoRotate = autoOrbit;
    c.autoRotateSpeed = 0.35;
    c.update(dt);
  });

  return (
    <OrbitControls
      ref={controls as never}
      makeDefault
      enableDamping
      dampingFactor={0.06}
      minDistance={0.4}
      maxDistance={60}
      maxPolarAngle={Math.PI / 2 - 0.02}
      zoomSpeed={0.7}
      panSpeed={0.7}
      rotateSpeed={0.55}
    />
  );
}

const BASE_SPEED = 6.5;
const SPRINT = 3.2;
const LOOK = 0.0022;

/**
 * Keyboard movement, live in both navigation modes.
 *
 * WASD and the arrow keys always fly the camera; orbit mode simply keeps mouse
 * drag for looking around, and fly mode swaps that for pointer-lock. Moving in
 * orbit mode carries the orbit centre along with the camera, so the graph does
 * not swing around a point you have flown away from.
 */
function useMovement(onMove?: (delta: Vector3) => void) {
  const camera = useThree((s) => s.camera);
  const setMoving = useStore((s) => s.setMoving);
  const keys = useRef(new Set<string>());
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const forward = useRef(new Vector3());
  const right = useRef(new Vector3());
  const wish = useRef(new Vector3());

  useEffect(() => {
    // The HUD fades while you fly and comes back shortly after you stop, so
    // the chrome is never in the way mid-flight but never far either.
    const markMoving = () => {
      setMoving(true);
      if (idle.current) clearTimeout(idle.current);
      idle.current = setTimeout(() => setMoving(false), 900);
    };
    const down = (e: KeyboardEvent) => {
      if (typingSomewhere()) return;
      if (MOVE_KEYS.has(e.code)) {
        keys.current.add(e.code);
        markMoving();
        // Space and the arrows would otherwise scroll the page.
        if (e.code === "Space" || e.code.startsWith("Arrow")) e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => {
      keys.current.delete(e.code);
      markMoving();
    };
    const clear = () => {
      keys.current.clear();
      setMoving(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", clear);
      if (idle.current) clearTimeout(idle.current);
    };
  }, [setMoving]);

  useFrame((_, rawDt) => {
    const dt = Math.min(0.05, rawDt);
    const held = keys.current;
    if (!held.size) return;
    const sprint = held.has("ShiftLeft") || held.has("ShiftRight") ? SPRINT : 1;

    forward.current.set(0, 0, -1).applyQuaternion(camera.quaternion);
    right.current.set(1, 0, 0).applyQuaternion(camera.quaternion);

    const move = wish.current.set(0, 0, 0);
    if (held.has("KeyW") || held.has("ArrowUp")) move.add(forward.current);
    if (held.has("KeyS") || held.has("ArrowDown")) move.sub(forward.current);
    if (held.has("KeyD") || held.has("ArrowRight")) move.add(right.current);
    if (held.has("KeyA") || held.has("ArrowLeft")) move.sub(right.current);
    if (held.has("KeyE") || held.has("Space")) move.y += 1;
    if (held.has("KeyQ")) move.y -= 1;
    if (move.lengthSq() === 0) return;

    move.normalize().multiplyScalar(BASE_SPEED * sprint * dt);
    camera.position.add(move);
    // Never end up under the floor.
    if (camera.position.y < 0.25) {
      move.y += 0.25 - camera.position.y;
      camera.position.y = 0.25;
    }
    onMove?.(move);
  });
}

function FlyMode() {
  const { camera, gl } = useThree();
  const euler = useRef(new Euler(0, 0, 0, "YXZ"));
  const locked = useRef(false);
  const setPointerLocked = useStore((s) => s.setPointerLocked);
  useMovement();

  useEffect(() => {
    euler.current.setFromQuaternion(camera.quaternion);
    const canvas = gl.domElement;

    const onMove = (e: MouseEvent) => {
      if (!locked.current) return;
      euler.current.y -= e.movementX * LOOK;
      euler.current.x -= e.movementY * LOOK;
      euler.current.x = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, euler.current.x));
      camera.quaternion.setFromEuler(euler.current);
    };

    const onLockChange = () => {
      locked.current = document.pointerLockElement === canvas;
      setPointerLocked(locked.current);
    };

    // Clicking the empty scene captures the mouse; clicking a screen does not,
    // so the screens stay usable while fly mode is on.
    const onCanvasDown = (e: MouseEvent) => {
      if (e.button !== 0 || typingSomewhere()) return;
      if (document.pointerLockElement !== canvas) void canvas.requestPointerLock();
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("pointerlockchange", onLockChange);
    canvas.addEventListener("mousedown", onCanvasDown);

    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("pointerlockchange", onLockChange);
      canvas.removeEventListener("mousedown", onCanvasDown);
      if (document.pointerLockElement === canvas) document.exitPointerLock();
      setPointerLocked(false);
    };
  }, [camera, gl, setPointerLocked]);

  return null;
}

export function Controls() {
  const mode = useStore((s) => s.view.navMode);
  const scene = useStore((s) => s.scene);
  const enabled = useStore((s) => s.controlsEnabled);
  useAspectFov();
  // A camera flight owns the camera outright; a control rig running underneath
  // it fights the tween and makes the flight shudder.
  if (!enabled) return null;
  return mode === "fly" ? <FlyMode /> : <OrbitMode scene={scene} />;
}
