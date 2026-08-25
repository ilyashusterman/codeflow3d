/**
 * Streams unsaved buffers to a running CodeFlow3D viewer.
 *
 * The viewer watches a repository on its own, but a file watcher only ever sees
 * writes — a file you are typing into is invisible until you save. The fallback
 * for that is the editor's hot-exit backup store, and on desktop VS Code and
 * Cursor that store is written when a *window closes*, not while you type.
 * Measured: a dirty editor produced zero backup writes over ten seconds. So
 * without something like this extension, "live" can only ever mean "on save".
 *
 * This closes the gap the only way that actually works: `onDidChangeTextDocument`
 * fires on every keystroke and the buffer goes straight to the viewer. No
 * polling, no debounce, no disk.
 *
 * Plain HTTP over a keep-alive socket rather than a WebSocket, deliberately: the
 * global `WebSocket` only became available in Node 22 and the extension host
 * still runs Node 20, so a socket-based version would fail on the editors people
 * actually have. A keep-alive POST to localhost costs about a millisecond, which
 * is well inside a frame.
 *
 * Dependency-free and unbuilt — plain CommonJS against the `vscode` API, so it
 * installs by being copied into an extensions directory.
 */
const vscode = require("vscode");
const http = require("node:http");
const https = require("node:https");
const { URL } = require("node:url");

/**
 * Coalescing window, ms.
 *
 * One frame. Holding a keystroke longer than the display can show it buys
 * nothing, and typing fast enough to produce several changes inside one frame
 * only ever needs the buffer's last state.
 */
const COALESCE_MS = 16;
/** How long to sit in the "viewer is not running" state before trying again. */
const RETRY_MS = 3000;

/** One pooled connection, so a keystroke never pays for a TCP handshake. */
const agents = new Map();
function agentFor(protocol) {
  if (!agents.has(protocol)) {
    const Agent = protocol === "https:" ? https.Agent : http.Agent;
    agents.set(protocol, new Agent({ keepAlive: true, maxSockets: 1 }));
  }
  return agents.get(protocol);
}

let status;
let online = false;
let offlineUntil = 0;
/** Files with a buffer currently pushed, so they can be withdrawn on close. */
const pushed = new Set();
/** Latest document per file, flushed on the next frame. */
const queued = new Map();
let flushTimer = null;

function config() {
  return vscode.workspace.getConfiguration("codeflow3d");
}

function endpoint() {
  const base = config().get("server", "http://127.0.0.1:5189");
  return new URL("/api/buffer", base.replace(/^ws/, "http"));
}

function setOnline(next, detail) {
  if (online !== next) {
    online = next;
    status.text = next ? "$(broadcast) codeflow3d" : "$(debug-disconnect) codeflow3d";
  }
  status.tooltip = detail;
}

/**
 * POST one buffer.
 *
 * Failure is the normal case when the viewer is not running, so it is recorded
 * in the status bar and otherwise ignored — an editor that popped an error
 * dialog on every keystroke would be worse than no extension at all.
 */
function post(body, onDone) {
  let url;
  try {
    url = endpoint();
  } catch {
    return onDone(false);
  }
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  const lib = url.protocol === "https:" ? https : http;
  const req = lib.request(
    {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      agent: agentFor(url.protocol),
      headers: { "content-type": "application/json", "content-length": payload.length },
    },
    (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        // Only ever a few dozen bytes; the guard is for a server that is not us.
        if (raw.length < 4096) raw += chunk;
      });
      res.on("end", () => {
        let ignored = false;
        try {
          ignored = !!JSON.parse(raw).ignored;
        } catch {
          /* not JSON — treat as a plain success or failure */
        }
        onDone(res.statusCode >= 200 && res.statusCode < 300, res.statusCode, ignored);
      });
    },
  );
  req.on("error", () => onDone(false));
  req.end(payload);
}

function send(doc) {
  const file = doc.uri.fsPath;
  // The server resolves an absolute path against whatever repo it is watching
  // and ignores anything outside it, so every open document can be offered
  // without this extension knowing which project the viewer has open.
  post({ file, content: doc.getText() }, (ok, code, ignored) => {
    if (ok) {
      // A file outside the watched repo is accepted and ignored — still a
      // healthy connection, just not a file this viewer cares about.
      if (!ignored) pushed.add(file);
      setOnline(
        true,
        ignored
          ? "connected — this file is outside the watched repository"
          : `streaming ${pushed.size} buffer(s) to ${endpoint().origin}`,
      );
    } else if (code === 409) {
      setOnline(false, "viewer is running but has no repository open");
    } else {
      offlineUntil = Date.now() + RETRY_MS;
      setOnline(false, `viewer not reachable at ${endpoint().origin}`);
    }
  });
}

function withdraw(file) {
  if (!pushed.delete(file)) return;
  post({ file, content: null }, () => {});
}

function queue(doc) {
  if (!config().get("enabled", true)) return;
  if (doc.isUntitled || doc.uri.scheme !== "file") return;
  // While the viewer is down, keep queueing but stop hammering it.
  if (!online && Date.now() < offlineUntil) return;
  queued.set(doc.uri.fsPath, doc);
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const batch = [...queued.values()];
    queued.clear();
    for (const d of batch) send(d);
  }, COALESCE_MS);
}

function activate(context) {
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = "codeflow3d.status";
  status.text = "$(debug-disconnect) codeflow3d";
  status.tooltip = "waiting for the first edit";
  status.show();
  context.subscriptions.push(status);

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => queue(e.document)),
    // A save is not the end of the story: the buffer now matches disk, and the
    // viewer drops a pushed buffer that matches what it read. Sending it anyway
    // keeps the two in step without a special case.
    vscode.workspace.onDidSaveTextDocument((doc) => queue(doc)),
    vscode.workspace.onDidCloseTextDocument((doc) => withdraw(doc.uri.fsPath)),
    vscode.commands.registerCommand("codeflow3d.reconnect", () => {
      offlineUntil = 0;
      const doc = vscode.window.activeTextEditor?.document;
      if (doc) queue(doc);
      vscode.window.showInformationMessage(`CodeFlow3D: retrying ${endpoint().origin}`);
    }),
    vscode.commands.registerCommand("codeflow3d.status", () => {
      vscode.window.showInformationMessage(
        online
          ? `CodeFlow3D: streaming ${pushed.size} buffer(s) to ${endpoint().origin}`
          : `CodeFlow3D: not connected to ${endpoint().origin}. Is the viewer running?`,
      );
    }),
  );

  // Anything already open and dirty would otherwise stay invisible until its
  // next keystroke.
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.isDirty && !doc.isUntitled) queue(doc);
  }
}

function deactivate() {
  if (flushTimer) clearTimeout(flushTimer);
  for (const file of [...pushed]) withdraw(file);
  for (const agent of agents.values()) agent.destroy();
}

module.exports = { activate, deactivate };
