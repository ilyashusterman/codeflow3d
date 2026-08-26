/**
 * What the viewer shows when it cannot draw the scene.
 *
 * Two ways that happens: the browser has no WebGL, or the scene threw. Both
 * used to produce the same thing — an empty root and a near-black page, which
 * is indistinguishable from a server that never started.
 *
 * The rest of the app does not need WebGL. The change log, the graph read-out,
 * the repo panel and the full-screen editor are all DOM, so they keep working;
 * this says which half is missing and how to get it back, rather than replacing
 * the whole application with an apology.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

export class SceneBoundary extends Component<
  { children: ReactNode; onError: (message: string) => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The message is what the fallback shows, so it has to survive minification
    // being unhelpful: three.js says "Error creating WebGL context" and that is
    // exactly the sentence somebody needs to read.
    console.error("[scene]", error, info.componentStack);
    this.props.onError(error.message || String(error));
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function SceneFallback({ reason }: { reason: string | null }) {
  return (
    <div className="no-gl">
      <div className="no-gl-card">
        <h2>the graph needs WebGL</h2>
        <p>
          This browser view cannot create a WebGL context, so the 3D scene has
          nothing to draw on. Everything that is not the scene still works:{" "}
          <b>C</b> opens the change log, <b>Tab</b> the controls, and clicking a
          file there opens it full screen.
        </p>
        <p className="no-gl-hint">
          For the scene itself, open <code>{location.href.replace(/\?.*$/, "")}</code> in
          Chrome, Brave, Safari or Firefox.
        </p>
        {reason && <p className="no-gl-why">{reason}</p>}
      </div>
    </div>
  );
}
