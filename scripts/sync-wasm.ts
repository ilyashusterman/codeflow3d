/**
 * Collects every tree-sitter grammar we can parse plus the web-tree-sitter
 * runtime into a single flat `wasm/` directory, which is the layout
 * @codeflow-map/core expects for its `wasmDirectory` option.
 */
import { mkdir, readdir, copyFile, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "wasm");

await mkdir(out, { recursive: true });

const grammarDir = join(root, "node_modules/tree-sitter-wasms/out");
const runtime = join(root, "node_modules/web-tree-sitter/tree-sitter.wasm");

let copied = 0;
for (const f of await readdir(grammarDir)) {
  if (!f.endsWith(".wasm")) continue;
  await copyFile(join(grammarDir, f), join(out, f));
  copied++;
}
await copyFile(runtime, join(out, "tree-sitter.wasm"));
copied++;

const size = (await stat(out)).size;
console.log(`[wasm] ${copied} wasm files ready in ${out} (${size}b dir entry)`);
