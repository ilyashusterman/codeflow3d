/** Auto-reconnecting websocket bound to the store. */
import type { ClientMsg, ServerMsg } from "@shared/protocol";
import { useStore } from "../state/store";
import { apiUrl, wsUrl } from "./api";

let ws: WebSocket | null = null;
let retry = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

export function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  ws = new WebSocket(wsUrl());

  ws.onopen = () => {
    retry = 0;
    useStore.getState().setConnected(true);
  };
  ws.onclose = () => {
    useStore.getState().setConnected(false);
    // Backoff, capped, so a restarted server is picked up within a second or two.
    const delay = Math.min(4000, 250 * 2 ** retry++);
    if (timer) clearTimeout(timer);
    timer = setTimeout(connect, delay);
  };
  ws.onerror = () => ws?.close();
  ws.onmessage = (ev) => {
    try {
      useStore.getState().apply(JSON.parse(ev.data) as ServerMsg);
    } catch (err) {
      console.error("bad frame", err);
    }
  };
}

export function send(msg: ClientMsg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

export async function watchPath(path: string) {
  const res = await fetch(apiUrl("/api/watch"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  return res.json();
}
