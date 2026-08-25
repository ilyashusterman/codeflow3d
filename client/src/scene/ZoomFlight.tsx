/**
 * Flying the camera to a screen and back.
 *
 * Double-clicking a screen fills the frame with it: the camera eases from
 * wherever you are to square-on in front of the screen at the distance where
 * it exactly fits, and Escape eases you back to the pose you left. Both
 * directions are the same translation run in reverse, which is what makes
 * leaving feel like the inverse of arriving rather than a cut.
 *
 * Two details make this behave rather than merely animate. The controls are
 * suspended only for the *duration* of the flight — leaving them off while
 * zoomed strands you in front of a screen with no way to move — and the orbit
 * pivot is moved to the screen on arrival, so when the controls come back you
 * orbit the thing you flew to instead of swinging around the graph centre you
 * left behind.
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Matrix4, Quaternion, Vector3 } from "three";
import type { SceneGraph } from "@shared/protocol";
import { useStore } from "../state/store";
import { arrange } from "./CodePanels";

interface Pose {
  position: Vector3;
  quaternion: Quaternion;
  /** What the pose is looking at, so the orbit pivot can follow. */
  centre: Vector3;
}

/** Seconds for a full flight. Long enough to read as movement, short enough not to wait. */
const DURATION = 0.72;

/** Ease-in-out cubic: leaves and arrives at rest. */
function ease(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Where to stand so a screen fills the frame.
 *
 * The screen's position depends on the arrangement, which is resolved on the
 * client — flying to the slot the server suggested would land you in empty
 * space whenever the arrangement is anything but `stagger`. So this resolves
 * it exactly the way the screens themselves do.
 */
function poseFor(
  panel: { pos: [number, number, number]; rotY: number; size: [number, number] },
  index: number,
  count: number,
  layout: "stagger" | "wall" | "arc",
  scale: number,
  moved: [number, number, number] | undefined,
  faced: number | undefined,
  fov: number,
  aspect: number,
): Pose {
  const size: [number, number] = [panel.size[0] * scale, panel.size[1] * scale];
  const slot = arrange(index, count, layout, size);
  const resolved = moved ?? (layout === "stagger" ? panel.pos : slot.pos);
  // A screen turned to face you has its own yaw; approaching on the layout's
  // normal would fly you to its edge.
  const rotY = faced ?? (moved ? panel.rotY : layout === "stagger" ? panel.rotY : slot.rotY);

  const centre = new Vector3(...resolved);
  const normal = new Vector3(Math.sin(rotY), 0, Math.cos(rotY));

  // Fit whichever dimension is tighter, with a margin so the frame is not
  // flush against the screen's edge.
  const halfV = Math.tan((fov * Math.PI) / 360);
  const halfH = halfV * aspect;
  const distance = Math.max(size[1] / 2 / halfV, size[0] / 2 / halfH) * 1.12;

  const position = centre.clone().addScaledVector(normal, distance);
  // Matrix4.lookAt builds exactly the camera convention (-Z toward the target).
  // Hand-rolling this basis is easy to get subtly wrong and lands you staring
  // at the floor.
  const look = new Matrix4().lookAt(position, centre, new Vector3(0, 1, 0));
  const quaternion = new Quaternion().setFromRotationMatrix(look);

  return { position, quaternion, centre };
}

export function ZoomFlight({ scene }: { scene: SceneGraph | null }) {
  const { camera, size } = useThree();
  const zoomed = useStore((s) => s.zoomed);
  const panelPos = useStore((s) => s.panelPos);
  const panelRot = useStore((s) => s.panelRot);
  const setControlsEnabled = useStore((s) => s.setControlsEnabled);
  const setOrbitTarget = useStore((s) => s.setOrbitTarget);

  const from = useRef<Pose | null>(null);
  const to = useRef<Pose | null>(null);
  const saved = useRef<Pose | null>(null);
  /** Where to pivot once we arrive, and what to restore on the way out. */
  const arriveTarget = useRef<[number, number, number] | null>(null);
  const savedTarget = useRef<[number, number, number] | null>(null);
  const elapsed = useRef(0);
  const flying = useRef(false);

  const aspect = size.width / Math.max(1, size.height);
  const fov = "fov" in camera ? (camera.fov as number) : 50;

  const layout = useStore((s) => s.view.screenLayout);
  const scale = useStore((s) => s.view.screenScale);
  const target_ = useMemo(() => {
    const index = scene?.panels.findIndex((p) => p.file === zoomed) ?? -1;
    return index >= 0 ? { panel: scene!.panels[index], index, count: scene!.panels.length } : null;
  }, [scene, zoomed]);

  useEffect(() => {
    if (zoomed && target_) {
      // Stash the pose to come back to, but only on the way in — a re-render
      // while zoomed must not overwrite it with the zoomed pose.
      if (!saved.current) {
        const back = useStore.getState().orbitTarget;
        saved.current = {
          position: camera.position.clone(),
          quaternion: camera.quaternion.clone(),
          centre: back ? new Vector3(...back) : camera.position.clone(),
        };
      }
      from.current = {
        position: camera.position.clone(),
        quaternion: camera.quaternion.clone(),
        centre: camera.position.clone(),
      };
      const fit = poseFor(
        target_.panel,
        target_.index,
        target_.count,
        layout,
        scale,
        panelPos[target_.panel.file],
        panelRot[target_.panel.file],
        fov,
        aspect,
      );
      to.current = fit;
      arriveTarget.current = [fit.centre.x, fit.centre.y, fit.centre.z];
      savedTarget.current = useStore.getState().orbitTarget;
    } else if (saved.current) {
      from.current = {
        position: camera.position.clone(),
        quaternion: camera.quaternion.clone(),
        centre: camera.position.clone(),
      };
      to.current = saved.current;
      saved.current = null;
      arriveTarget.current = savedTarget.current;
      savedTarget.current = null;
    } else {
      return;
    }
    elapsed.current = 0;
    flying.current = true;
    setControlsEnabled(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomed, target_?.panel.file, layout, scale]);

  useFrame((_, dt) => {
    if (!flying.current || !from.current || !to.current) return;
    elapsed.current = Math.min(DURATION, elapsed.current + dt);
    const t = ease(elapsed.current / DURATION);

    camera.position.lerpVectors(from.current.position, to.current.position, t);
    camera.quaternion.slerpQuaternions(from.current.quaternion, to.current.quaternion, t);

    if (elapsed.current >= DURATION) {
      flying.current = false;
      // Hand the camera back, pivoting on whatever we arrived at.
      setOrbitTarget(arriveTarget.current);
      setControlsEnabled(true);
    }
  });

  return null;
}
