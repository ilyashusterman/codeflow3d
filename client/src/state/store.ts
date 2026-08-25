/** Single zustand store: connection, live scene, activity feed, view settings. */
import { create } from "zustand";
import type { FileEvent, SceneGraph, ServerMsg } from "@shared/protocol";
import { loadRepoSettings, saveRepoSettings } from "./settings";

export type Preset = "flat" | "cinematic";
export type NavMode = "orbit" | "fly";
/**
 * How the file screens are arranged.
 *  - `stagger` steps them back in depth, which shows their order at a glance
 *  - `wall`    lines them up on one plane, which is easier to read across
 *  - `arc`     curves that wall around you, so every screen faces you
 */
export type ScreenLayout = "stagger" | "wall" | "arc";

export interface ViewSettings {
  preset: Preset;
  navMode: NavMode;
  /** Draw the file-level import graph. */
  importLinks: boolean;
  /** 0 = raw graph edges, 1 = fully bundled through module trunks. */
  bundle: number;
  screenLayout: ScreenLayout;
  /** Draw the tethers from each screen to its definitions in the graph. */
  screenLinks: boolean;
  /** Screen size multiplier. */
  screenScale: number;
  /** Scroll the screens to follow the newest change. */
  tail: boolean;
  bloom: boolean;
  streamlines: boolean;
  panels: boolean;
  tree: boolean;
  glyphs: boolean;
  pulses: boolean;
  grid: boolean;
  /** Tube thickness multiplier. */
  thickness: number;
  /** Pulse travel speed along streamlines. */
  speed: number;
  autoOrbit: boolean;
}

export interface Store {
  connected: boolean;
  phase: "idle" | "analyzing" | "watching" | "error";
  detail: string;
  scene: SceneGraph | null;
  /** Wall-clock ms when the current scene arrived — drives local heat decay. */
  sceneAt: number;
  events: FileEvent[];
  logs: { at: number; msg: string; level: string }[];
  selectedPanel: string | null;
  /** File open full-screen in flat mode. */
  focused: string | null;
  /** Screen the camera has flown to, filling the view. */
  zoomed: string | null;
  /** False while a camera flight owns the camera. */
  controlsEnabled: boolean;
  /** Files whose screens keep their slot. */
  pinned: string[];
  /** Screens the user has dragged, keyed by file — these override the layout. */
  panelPos: Record<string, [number, number, number]>;
  /** Screens turned to face the viewer, keyed by file: an explicit yaw. */
  panelRot: Record<string, number>;
  /** Where the orbit rig pivots. Follows a zoom so you orbit what you flew to. */
  orbitTarget: [number, number, number] | null;
  pointerLocked: boolean;
  /** True while the camera is being flown, so the HUD can get out of the way. */
  moving: boolean;
  /** Which HUD drawer is open, if any. Persisted per repo. */
  drawer: string | null;
  view: ViewSettings;
  exportState: { busy: boolean; last: string | null; error: string | null };

  apply(msg: ServerMsg): void;
  setView(patch: Partial<ViewSettings>): void;
  /** Rail sections that are open, persisted per repo. */
  sections: Record<string, boolean>;
  toggleSection(id: string): void;
  setConnected(c: boolean): void;
  selectPanel(id: string | null): void;
  setFocused(file: string | null): void;
  setZoomed(file: string | null): void;
  setControlsEnabled(on: boolean): void;
  setPinned(files: string[]): void;
  movePanel(file: string, pos: [number, number, number]): void;
  facePanel(file: string, yaw: number): void;
  /** Snap every screen back into the grid, dropping drags and facings. */
  alignPanels(): void;
  resetPanels(): void;
  setOrbitTarget(target: [number, number, number] | null): void;
  setPointerLocked(locked: boolean): void;
  setMoving(moving: boolean): void;
  setDrawer(id: string | null): void;
  setExport(patch: Partial<Store["exportState"]>): void;
}

export const useStore = create<Store>((set) => ({
  connected: false,
  phase: "idle",
  detail: "",
  scene: null,
  sceneAt: 0,
  events: [],
  logs: [],
  selectedPanel: null,
  focused: null,
  zoomed: null,
  controlsEnabled: true,
  pinned: [],
  panelPos: {},
  panelRot: {},
  orbitTarget: null,
  pointerLocked: false,
  moving: false,
  drawer: null,
  view: {
    preset: "cinematic",
    navMode: "orbit",
    importLinks: false,
    bundle: 0.38,
    screenLayout: "wall",
    screenLinks: true,
    screenScale: 1,
    tail: true,
    bloom: true,
    streamlines: true,
    panels: true,
    tree: true,
    glyphs: true,
    pulses: true,
    grid: true,
    thickness: 1,
    speed: 1,
    autoOrbit: false,
  },
  exportState: { busy: false, last: null, error: null },
  sections: {},

  apply(msg) {
    if (msg.t === "scene") {
      set((s) => {
        const switched = s.scene?.root !== msg.scene.root;
        // A new repository brings its own saved view; the same one keeps
        // whatever the user has adjusted since.
        const saved = switched ? loadRepoSettings(msg.scene.root) : null;
        return {
          scene: msg.scene,
          sceneAt: performance.now(),
          phase: "watching",
          events: switched ? msg.events.slice(0, 200) : [...msg.events, ...s.events].slice(0, 200),
          ...(saved
            ? {
                view: { ...s.view, ...saved.view },
                panelPos: saved.panelPos ?? {},
                panelRot: saved.panelRot ?? {},
                orbitTarget: null,
                pinned: saved.pinned ?? [],
                sections: saved.sections ?? {},
                focused: null,
              }
            : {}),
        };
      });
    } else if (msg.t === "patch") {
      /**
       * Merge a partial update, the way a reducer handles one action.
       *
       * Every absent section is deliberately carried over *by reference*. That
       * is not just a saving on the wire — an unchanged array keeps its object
       * identity, so the components that read it see no new props and React
       * skips those subtrees entirely. A save that only edits text therefore
       * re-renders one screen, not the scene.
       */
      set((s) => {
        if (!s.scene) return s;
        const previous = s.scene;
        const byFile = msg.panels && new Map(msg.panels.map((p) => [p.file, p]));
        // `stage` arrives only when a screen entered or left; otherwise the
        // running order is already correct.
        const order = msg.stage ?? previous.panels.map((p) => p.file);
        const existing = new Map(previous.panels.map((p) => [p.file, p]));
        const panels =
          byFile || msg.stage
            ? order
                .map((file) => byFile?.get(file) ?? existing.get(file))
                .filter((p): p is NonNullable<typeof p> => !!p)
            : previous.panels;

        return {
          scene: {
            ...previous,
            rev: msg.rev,
            panels,
            nodes: msg.nodes ?? previous.nodes,
            edges: msg.edges ?? previous.edges,
            streamlines: msg.streamlines ?? previous.streamlines,
            importLinks: msg.importLinks ?? previous.importLinks,
            tree: msg.tree ?? previous.tree,
            domain: msg.domain ?? previous.domain,
            stats: msg.stats,
            activeFile: msg.activeFile,
          },
          sceneAt: performance.now(),
          phase: "watching",
          events: msg.events.length ? [...msg.events, ...s.events].slice(0, 200) : s.events,
        };
      });
    } else if (msg.t === "event") {
      set((s) => ({ events: [msg.event, ...s.events].slice(0, 200) }));
    } else if (msg.t === "status") {
      set({ phase: msg.phase, detail: msg.detail ?? "" });
    } else if (msg.t === "log") {
      set((s) => ({ logs: [{ at: Date.now(), msg: msg.msg, level: msg.level }, ...s.logs].slice(0, 80) }));
    } else if (msg.t === "hello") {
      set({ detail: msg.watching ?? "" });
    }
  },
  setView: (patch) =>
    set((s) => {
      const view = { ...s.view, ...patch };
      saveRepoSettings(s.scene?.root ?? null, { view: patch });
      return { view };
    }),
  toggleSection: (id) =>
    set((s) => {
      const sections = { ...s.sections, [id]: !(s.sections[id] ?? true) };
      saveRepoSettings(s.scene?.root ?? null, { sections });
      return { sections };
    }),
  setConnected: (connected) => set({ connected }),
  selectPanel: (selectedPanel) => set({ selectedPanel }),
  setFocused: (focused) => set({ focused }),
  setZoomed: (zoomed) => set({ zoomed }),
  setControlsEnabled: (controlsEnabled) => set({ controlsEnabled }),
  setPinned: (pinned) =>
    set((s) => {
      saveRepoSettings(s.scene?.root ?? null, { pinned });
      return { pinned };
    }),
  movePanel: (file, pos) =>
    set((s) => {
      const panelPos = { ...s.panelPos, [file]: pos };
      // Written on every drag frame; localStorage writes are synchronous but
      // this payload is a handful of numbers, and losing the last position on
      // a crash would be worse than the cost.
      saveRepoSettings(s.scene?.root ?? null, { panelPos });
      return { panelPos };
    }),
  facePanel: (file, yaw) =>
    set((s) => {
      const panelRot = { ...s.panelRot, [file]: yaw };
      saveRepoSettings(s.scene?.root ?? null, { panelRot });
      return { panelRot };
    }),
  alignPanels: () =>
    set((s) => {
      const view = { ...s.view, screenLayout: "wall" as const };
      saveRepoSettings(s.scene?.root ?? null, {
        view: { screenLayout: "wall" },
        panelPos: {},
        panelRot: {},
      });
      return { view, panelPos: {}, panelRot: {} };
    }),
  resetPanels: () =>
    set((s) => {
      saveRepoSettings(s.scene?.root ?? null, { panelPos: {}, panelRot: {} });
      return { panelPos: {}, panelRot: {} };
    }),
  setOrbitTarget: (orbitTarget) => set({ orbitTarget }),
  setPointerLocked: (pointerLocked) => set({ pointerLocked }),
  setMoving: (moving) => set((s) => (s.moving === moving ? s : { moving })),
  setDrawer: (drawer) =>
    set((s) => {
      saveRepoSettings(s.scene?.root ?? null, { sections: { __drawer: drawer === null } });
      return { drawer };
    }),
  setExport: (patch) => set((s) => ({ exportState: { ...s.exportState, ...patch } })),
}));
