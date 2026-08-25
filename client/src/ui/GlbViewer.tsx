/**
 * Standalone model-viewer page, reached at `/viewer?src=/exports/<file>.glb`.
 *
 * It lives on its own route rather than in a modal over the live scene: a
 * second large WebGL context on the same page costs the live canvas its own,
 * and a URL is something you can keep, bookmark, or hand to someone else.
 */
import { useEffect, useState } from "react";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      "model-viewer": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
        alt?: string;
        "camera-controls"?: boolean | string;
        "auto-rotate"?: boolean | string;
        "shadow-intensity"?: string | number;
        exposure?: string | number;
        "interaction-prompt"?: string;
        "environment-image"?: string;
        loading?: "auto" | "lazy" | "eager";
        reveal?: "auto" | "manual" | "interaction";
        "camera-orbit"?: string;
        "field-of-view"?: string;
        "auto-rotate-delay"?: string | number;
      };
    }
  }
}

/**
 * Load immediately. model-viewer's default `loading="auto"` waits on an
 * IntersectionObserver, which never fires in embedded or background browser
 * panes — the element initialises but the model is never fetched.
 */
const EAGER = { loading: "eager", reveal: "auto" } as const;

/**
 * The scene is a wide, shallow slab, so model-viewer's automatic framing
 * leaves a lot of empty frame. This starts it near the angle the live camera
 * uses and pulls in to 62% of the auto radius.
 */
const FRAMING = {
  "camera-orbit": "22deg 68deg 62%",
  "field-of-view": "32deg",
  "auto-rotate-delay": 1200,
} as const;

export function GlbViewerPage() {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const src = new URLSearchParams(location.search).get("src") ?? "";

  useEffect(() => {
    let alive = true;
    import("@google/model-viewer")
      .then(() => alive && setReady(true))
      .catch((err) => alive && setFailed(String(err)));
    return () => {
      alive = false;
    };
  }, []);

  const name = src.split("/").pop() ?? "model";

  return (
    <div className="viewer-page">
      <header>
        <a href="/">← live scene</a>
        <span>{name}</span>
        <a href={src} download>
          download .glb
        </a>
      </header>
      <div className="viewer-stage">
        {failed && <p className="viewer-msg">could not load model-viewer: {failed}</p>}
        {!src && <p className="viewer-msg">no ?src= given</p>}
        {ready && src && (
          <model-viewer
            src={src}
            alt="Exported CodeFlow3D scene"
            camera-controls
            auto-rotate
            exposure="1.2"
            interaction-prompt="none"
            {...EAGER}
            {...FRAMING}
            style={{ width: "100%", height: "100%", backgroundColor: "#05070a" }}
          />
        )}
        {!ready && !failed && <p className="viewer-msg">loading model-viewer…</p>}
      </div>
      <footer>
        drag to orbit · scroll to zoom · the same file opens in F3D, Blender, or any glTF 2.0 tool
      </footer>
    </div>
  );
}
