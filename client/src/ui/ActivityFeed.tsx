/**
 * The change log.
 *
 * A filename and a count is not seeing a change, so every write shows the
 * lines that actually changed, straight from the diff the analyzer computed.
 * Newest at the top, expandable, and clicking one opens that file flat.
 */
import { useEffect, useState } from "react";
import type { FileEvent, SceneGraph } from "@shared/protocol";
import { useStore } from "../state/store";
import { send } from "../net/socket";

const KIND_LABEL: Record<string, string> = {
  add: "NEW",
  change: "SAVE",
  editing: "TYPING",
  unlink: "DEL",
  addDir: "MKDIR",
  unlinkDir: "RMDIR",
};

function ago(at: number, now: number) {
  const s = Math.max(0, (now - at) / 1000);
  if (s < 1) return "now";
  if (s < 60) return `${s.toFixed(0)}s`;
  if (s < 3600) return `${(s / 60).toFixed(0)}m`;
  return `${(s / 3600).toFixed(0)}h`;
}

/** The actual changed lines for one write. */
function Hunk({ event }: { event: FileEvent }) {
  if (!event.hunk?.length) return null;
  const shown = event.hunk.slice(0, 6);
  const more = (event.added ?? 0) + (event.removed ?? 0) - shown.length;
  return (
    <div className="hunk">
      {shown.map((line, i) => (
        <div key={i} className={`hunk-line hk-${line.type}`}>
          <span className="hunk-sign">{line.type === "add" ? "+" : "−"}</span>
          <span className="hunk-no">{line.line}</span>
          <code>{line.text || " "}</code>
        </div>
      ))}
      {more > 0 && <div className="hunk-more">+{more} more lines</div>}
    </div>
  );
}

function EventRow({ event, now }: { event: FileEvent; now: number }) {
  const setFocused = useStore((s) => s.setFocused);
  const [open, setOpen] = useState(false);
  const hasHunk = Boolean(event.hunk?.length);
  const isNew = now - event.at < 2500;

  return (
    <div className={`ev k-${event.kind} ${isNew ? "fresh" : ""}`}>
      <div className="ev-head">
        <span className="ev-kind">{KIND_LABEL[event.kind] ?? event.kind}</span>
        <button
          className="ev-path"
          title={`${event.path} — open flat`}
          onClick={() => setFocused(event.path)}
        >
          {event.path}
        </button>
        {/* Every fact about the write in one right-hand cluster, so the ages
            line up down the edge of the list instead of floating wherever the
            badges before them happened to end. */}
        <span className="ev-meta">
          {/* Boolean(), not the raw numbers: `0 && …` evaluates to 0, and React
              renders that as the character "0" — which is what put a stray zero
              beside every newly added file. */}
          {Boolean(event.added || event.removed) && (
            <span className="ev-delta">
              {event.added ? <b>+{event.added}</b> : null}
              {event.removed ? <em>-{event.removed}</em> : null}
            </span>
          )}
          {event.unsaved && <span className="ev-chip live">unsaved</span>}
          {event.seeded && (
            <span className="ev-chip" title="last written before this session started">
              on disk
            </span>
          )}
          {event.fromEditor && <span className="ev-chip self">here</span>}
          <span className="ev-age">{ago(event.at, now)}</span>
          {hasHunk ? (
            <button
              className="ev-expand"
              onClick={() => setOpen((v) => !v)}
              title={open ? "hide the changed lines" : "show the changed lines"}
              aria-expanded={open}
            >
              {open ? "\u25be" : "\u25b8"}
            </button>
          ) : (
            <span className="ev-expand" />
          )}
        </span>
      </div>
      {hasHunk && open && <Hunk event={event} />}
    </div>
  );
}

/**
 * The graph read-out. The confidence split is the important number: it says
 * how much of the map is backed by imports actually in scope versus inferred
 * from a matching name.
 */
function GraphStats({ scene }: { scene: SceneGraph }) {
  const c = scene.stats.byConfidence;
  const backed = (c.import ?? 0) + (c.member ?? 0) + (c.local ?? 0);
  const inferred = (c.unique ?? 0) + (c.weak ?? 0);
  const langs = Object.entries(scene.stats.languages).sort((a, b) => b[1] - a[1]);

  return (
    <div className="feed-foot">
      <div className="stat-row">
        <span>{scene.stats.files} files</span>
        <span>{scene.stats.nodes} defs</span>
        <span>{scene.stats.edges} calls</span>
        <span>{scene.stats.importEdges} imports</span>
      </div>
      <div className="stat-row">
        <span className="ok" title="resolved from bindings in scope">
          {backed} resolved
        </span>
        <span className="warn" title="matched by name only">
          {inferred} inferred
        </span>
        <span title="calls into packages outside this repo">{scene.stats.unresolvedCalls} external</span>
      </div>
      <div className="stat-row langs">
        {langs.map(([name, n]) => (
          <span key={name}>
            {name} <b>{n}</b>
          </span>
        ))}
      </div>
      <div className="stat-row dim">
        parse {scene.stats.analyzeMs}ms · layout {scene.stats.layoutMs}ms · rev {scene.rev}
      </div>
    </div>
  );
}

export function ChangeLog() {
  const events = useStore((s) => s.events);
  const scene = useStore((s) => s.scene);
  const [now, setNow] = useState(() => Date.now());

  // One timer for every relative timestamp in the list.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const changes = events.filter((e) => e.kind !== "addDir");

  return (
    <>
      <div className="drawer-col grow">
        <h5>
          changes
          {changes.length > 0 && <span className="feed-count">{changes.length}</span>}
        </h5>
        <div className="feed-list">
          {changes.length === 0 && (
            <div className="feed-empty">
              watching for writes — edit any file in this repo and it appears here
            </div>
          )}
          {changes.slice(0, 60).map((e, i) => (
            <EventRow key={`${e.at}-${e.path}-${i}`} event={e} now={now} />
          ))}
        </div>
      </div>
      {scene && (
        <div className="drawer-col">
          <h5>graph</h5>
          <GraphStats scene={scene} />
        </div>
      )}
    </>
  );
}
