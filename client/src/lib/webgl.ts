/**
 * Can this browser draw the scene at all?
 *
 * Asked because of a real failure: opened in VS Code's built-in Browser the
 * viewer showed a black rectangle and nothing else. The page had loaded — the
 * tab took its title from it — but `<Canvas>` throws when a WebGL context
 * cannot be created, and a throw during render unmounts the whole tree, so the
 * HUD went with it and there was nothing on screen to say what had happened.
 *
 * The probe is one throwaway canvas, cached, because the answer cannot change
 * within a page load.
 */
let cached: boolean | null = null;

export function hasWebGL(): boolean {
  if (cached !== null) return cached;
  // A deliberate way to see the fallback in a browser that does have WebGL.
  if (typeof location !== "undefined" && new URLSearchParams(location.search).has("nogl")) {
    cached = false;
    return cached;
  }
  try {
    const canvas = document.createElement("canvas");
    const gl =
      canvas.getContext("webgl2") ??
      canvas.getContext("webgl") ??
      canvas.getContext("experimental-webgl");
    cached = Boolean(gl);
    // Contexts are a scarce resource; give this one back rather than waiting
    // for the GC to notice a canvas nothing references.
    if (gl && "getExtension" in gl) {
      (gl as WebGLRenderingContext).getExtension("WEBGL_lose_context")?.loseContext();
    }
  } catch {
    cached = false;
  }
  return cached;
}
