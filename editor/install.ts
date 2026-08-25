/**
 * Install the live-typing extension into every VS Code-family editor found.
 *
 * These editors load unpacked extensions straight from their extensions
 * directory, so "installing" is a copy plus a restart — no packaging, no
 * marketplace, no build step. Run it again to update; pass `--uninstall` to
 * remove it.
 */
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(HERE, "vscode");
const FOLDER = "codeflow3d.codeflow3d-live-1.0.0";

/** Extension directories, by the name each editor uses. */
const EDITORS: Record<string, string> = {
  "VS Code": ".vscode",
  "VS Code Insiders": ".vscode-insiders",
  Cursor: ".cursor",
  VSCodium: ".vscode-oss",
  Windsurf: ".windsurf",
  Antigravity: ".antigravity",
  Trae: ".trae",
};

async function exists(path: string) {
  return stat(path).then(
    () => true,
    () => false,
  );
}

const uninstall = process.argv.includes("--uninstall");
const found: string[] = [];

for (const [name, dir] of Object.entries(EDITORS)) {
  const root = join(homedir(), dir, "extensions");
  // Only install where the editor actually keeps its extensions — creating the
  // directory would install into an editor that is not there.
  if (!(await exists(root))) continue;
  const target = join(root, FOLDER);

  if (uninstall) {
    if (await exists(target)) {
      await rm(target, { recursive: true, force: true });
      console.log(`  removed from ${name}`);
      found.push(name);
    }
    continue;
  }

  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  for (const file of await readdir(SOURCE)) {
    await cp(join(SOURCE, file), join(target, file));
  }
  console.log(`  installed into ${name}  (${target})`);
  found.push(name);
}

if (!found.length) {
  console.log(
    uninstall
      ? "\nNothing to remove."
      : "\nNo VS Code-family editor found. Looked for:\n" +
          Object.values(EDITORS)
            .map((d) => `  ~/${d}/extensions`)
            .join("\n"),
  );
  process.exit(1);
}

console.log(
  uninstall
    ? `\nRestart ${found.join(" / ")} to finish removing it.`
    : `\nRestart ${found.join(" / ")} — then type in any file inside the watched repo.\n` +
        `A "codeflow3d" item appears in the status bar; it lights up on the first keystroke.`,
);
