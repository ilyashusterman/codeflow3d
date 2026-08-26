/**
 * Diagnostics for a scene that would not draw, and one switch for testing.
 *
 * This deliberately does *not* gate the scene. An earlier version of this file
 * probed for a context up front and refused to mount `<Canvas>` when the probe
 * came back empty — which is a second, weaker oracle sitting in front of the
 * real one. The probe runs on a detached canvas, and a detached canvas is
 * exactly the case an embedded browser is most likely to refuse while happily
 * giving a context to the real, attached one. A false "no" there costs the user
 * the whole scene for no reason.
 *
 * So the renderer is the only thing that decides. If it throws, the boundary
 * catches it, and *then* this runs — to say something more useful in the
 * fallback than the exception alone.
 */

/** Forces the fallback in a browser that can draw, so it can be looked at. */
export function fallbackForced(): boolean {
  try {
    return new URLSearchParams(location.search).has("nogl");
  } catch {
    return false;
  }
}

export type Probe = "webgl2" | "webgl" | "none" | "threw";

/** What a context request answers *now* — asked only after something failed. */
export function probeWebGL(): Probe {
  try {
    const canvas = document.createElement("canvas");
    // A size, because zero-sized surfaces are refused in some embedders.
    canvas.width = 64;
    canvas.height = 64;
    if (canvas.getContext("webgl2")) return "webgl2";
    if (canvas.getContext("webgl") ?? canvas.getContext("experimental-webgl")) return "webgl";
    return "none";
  } catch {
    return "threw";
  }
}
