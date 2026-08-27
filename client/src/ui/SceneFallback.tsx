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
import { probeWebGL } from "../lib/webgl";

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
  // Asked here rather than before the scene mounted: this runs because the
  // renderer already failed, so the answer is a description of that failure
  // rather than a prediction of it.
  const probe = probeWebGL();
  // Worth separating, because only one of these is anybody's to fix. A view
  // that has WebGL1 and no WebGL2 cannot run this renderer at all — three.js
  // dropped WebGL1 in r163 — while a view that grants nothing is usually a
  // browser whose GPU process has died, which a restart brings back.
  const onlyWebGL1 = probe === "webgl";
  // Chromium's phrasing when the GPU process is unreachable. Worth singling out:
  // it is the one cause that looks like a bug in this application and is not.
  const gpuDisabled = /GL_RENDERER = Disabled|BindToCurrentSequence|GPU process/i.test(reason ?? "");
  return (
    <div className="no-gl">
      <div className="no-gl-card">
        <h2>the scene could not start</h2>
        {onlyWebGL1 ? (
          <p>
            This browser view offers WebGL 1 only, and the renderer needs WebGL
            2 — three.js dropped WebGL 1 in r163, so there is no version of this
            scene that runs here.
          </p>
        ) : gpuDisabled ? (
          <p>
            This browser has <b>no GPU access</b> — it reports its renderer as
            disabled, which is what Chromium says once its GPU process has gone.
            Nothing in a page can bring that back. <b>Quit and reopen the
            browser</b> (in VS Code, quit the editor rather than reloading the
            window) and it returns.
          </p>
        ) : (
          <p>
            The 3D view needs a WebGL context and this browser view would not
            give it one, in any of the three configurations it was asked for.
          </p>
        )}
        <p>
          Everything that is not the scene still works: <b>C</b> opens the
          change log, <b>Tab</b> the controls, and clicking a file there opens
          it full screen.
        </p>
        <p className="no-gl-hint">
          For the scene itself, open <code>{location.href.replace(/\?.*$/, "")}</code> in
          Chrome, Brave, Safari or Firefox.
        </p>
        <p className="no-gl-why">
          context: {probe === "none" ? "refused" : probe === "threw" ? "threw" : probe}
          {reason ? ` · ${reason}` : ""}
        </p>
      </div>
    </div>
  );
}
