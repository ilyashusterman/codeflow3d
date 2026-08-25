/**
 * Per-repository view settings.
 *
 * How you want to look at a repo is a property of that repo — the bundling
 * that makes one codebase readable buries another, and a screen you dragged
 * somewhere useful should still be there tomorrow. Settings are therefore
 * stored per root path rather than globally, and restored when you point the
 * viewer back at it.
 */
import type { ViewSettings } from "./store";

const KEY = "codeflow3d.settings.v1";
const MAX_REPOS = 24;

export interface RepoSettings {
  view?: Partial<ViewSettings>;
  /** Screens the user dragged, keyed by repo-relative file path. */
  panelPos?: Record<string, [number, number, number]>;
  /** Screens the user turned to face them. */
  panelRot?: Record<string, number>;
  /** Files pinned to the stage. */
  pinned?: string[];
  /** Which rail sections are open. */
  sections?: Record<string, boolean>;
  /** Epoch ms, used to evict the least recently used repo. */
  at?: number;
}

type Store = Record<string, RepoSettings>;

function readAll(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

function writeAll(store: Store) {
  try {
    // Keep the file bounded: drop the least recently used repos.
    const entries = Object.entries(store)
      .sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0))
      .slice(0, MAX_REPOS);
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* quota or private mode — settings are a convenience, not a requirement */
  }
}

export function loadRepoSettings(root: string | null): RepoSettings {
  if (!root) return {};
  return readAll()[root] ?? {};
}

/** Merge a patch into one repo's settings. */
export function saveRepoSettings(root: string | null, patch: RepoSettings) {
  if (!root) return;
  const store = readAll();
  const current = store[root] ?? {};
  store[root] = {
    ...current,
    ...patch,
    view: { ...current.view, ...patch.view },
    panelPos: patch.panelPos ?? current.panelPos,
    panelRot: patch.panelRot ?? current.panelRot,
    sections: { ...current.sections, ...patch.sections },
    at: Date.now(),
  };
  writeAll(store);
}
