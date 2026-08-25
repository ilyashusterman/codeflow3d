/**
 * Where the backend lives.
 *
 * In production the Bun server serves the built client, so same-origin works.
 * In dev, Vite owns the page port and proxies /api fine, but proxying the
 * websocket adds a failure mode for no benefit — so talk to the API port directly.
 */
declare const __API_BASE__: string;

export const API_BASE: string = typeof __API_BASE__ === "string" ? __API_BASE__ : "";

export function apiUrl(path: string): string {
  return API_BASE ? `${API_BASE}${path}` : path;
}

export function wsUrl(): string {
  if (API_BASE) return `${API_BASE.replace(/^http/, "ws")}/ws`;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}
