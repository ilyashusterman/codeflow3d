/** A patch must reuse every object it did not carry. */
import { expect, test } from "bun:test";
import { useStore } from "../store";
const panel = (file: string, txt: string) => ({
  file, size: [4, 3] as [number, number], pos: [0, 0, 0] as [number, number, number], rotY: 0,
  lines: [{ n: 1, spans: [{ t: txt, c: 0 }], change: null }],
  revisions: 1, added: 0, removed: 0, focusLine: 1, firstLine: 1, totalLines: 1,
  unsaved: false, heat: 0, active: false, textOnly: false, language: "ts",
});
const scene: any = {
  rev: 1, root: "/r", projectName: "r", activeFile: null,
  nodes: [{ id: "a" }], edges: [{ id: "e" }], streamlines: [{ id: "s" }],
  importLinks: [{ id: "i" }], tree: [{ id: "t" }],
  panels: [panel("a.ts", "one"), panel("b.ts", "two")],
  stats: { files: 2 } as any, domain: [0, 1] as [number, number],
};
const apply = (msg: any) => (useStore.getState() as any).apply(msg);

test("patch reuses untouched sections and screens by reference", () => {
  apply({ t: "scene", scene, events: [] });
  const before = useStore.getState().scene!;

  apply({ t: "patch", rev: 2, panels: [panel("a.ts", "EDITED")], stats: scene.stats, activeFile: "a.ts", events: [] });
  const after = useStore.getState().scene!;

  expect(after.nodes).toBe(before.nodes);              // same array, no re-render
  expect(after.edges).toBe(before.edges);
  expect(after.streamlines).toBe(before.streamlines);
  expect(after.importLinks).toBe(before.importLinks);
  expect(after.tree).toBe(before.tree);
  expect(after.panels[1]).toBe(before.panels[1]);      // untouched screen, same object
  expect(after.panels[0]).not.toBe(before.panels[0]);  // edited screen, new object
  expect(after.panels[0].lines[0].spans[0].t).toBe("EDITED");
  expect(after.panels.map(p => p.file)).toEqual(["a.ts", "b.ts"]);  // order preserved
  expect(after.rev).toBe(2);
});

test("a geometry patch replaces only that section", () => {
  apply({ t: "scene", scene, events: [] });
  const before = useStore.getState().scene!;
  apply({ t: "patch", rev: 3, nodes: [{ id: "z" } as any], stats: scene.stats, activeFile: null, events: [] });
  const after = useStore.getState().scene!;
  expect(after.nodes).not.toBe(before.nodes);
  expect(after.edges).toBe(before.edges);
  expect(after.panels).toBe(before.panels);            // screens untouched entirely
});

test("stage adds and removes screens", () => {
  apply({ t: "scene", scene, events: [] });
  apply({ t: "patch", rev: 4, stage: ["b.ts", "c.ts"], panels: [panel("c.ts", "new")], stats: scene.stats, activeFile: null, events: [] });
  const after = useStore.getState().scene!;
  expect(after.panels.map(p => p.file)).toEqual(["b.ts", "c.ts"]);
});
