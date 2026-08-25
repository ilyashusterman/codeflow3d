/**
 * Transient status, top centre.
 *
 * Only appears when there is something to say — a scan in progress, a lost
 * connection, an error. A status bar that is always on screen restating what
 * the HUD already shows is just clutter, so this stays out of the way until it
 * has news.
 */
import { useEffect, useState } from "react";
import { useStore } from "../state/store";

export function StatusToast() {
  const phase = useStore((s) => s.phase);
  const detail = useStore((s) => s.detail);
  const connected = useStore((s) => s.connected);
  const scene = useStore((s) => s.scene);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => setDismissed(false), [phase, connected]);

  const kind = !connected
    ? "warn"
    : phase === "error"
      ? "error"
      : phase === "analyzing"
        ? "busy"
        : null;

  // Nothing to report once a scene is up and the watcher is idle.
  if (!kind || dismissed) return null;

  const text = !connected
    ? "reconnecting to the watcher…"
    : phase === "error"
      ? detail || "something went wrong"
      : scene
        ? `re-scanning ${detail || ""}`.trim()
        : `parsing with tree-sitter ${detail || ""}`.trim();

  return (
    <div className={`toast ${kind}`} onClick={() => setDismissed(true)} title="click to dismiss">
      {kind === "busy" && <span className="toast-spin" />}
      {text}
    </div>
  );
}
