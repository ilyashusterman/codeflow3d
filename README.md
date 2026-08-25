# codeflow3d

A live 3D map of a local repository, and a place to work inside it.

Point it at a directory. Every file is parsed with tree-sitter, the call graph is
resolved from the imports actually in scope, and the result is laid out in 3D.
Every write, add and delete in that tree re-parses the affected file and
re-renders — an incremental save costs a couple of milliseconds, so an agent
editing files reads as heat moving through the graph while it happens.

Fly around it. Drag the screens where you want them. Double-click one to open
the file flat, read it, edit it, save it — the write goes to disk, the watcher
sees it, and the graph updates the same way it would for an edit made anywhere
else.

```bash
bun install
bun run dev                      # traces this repo's own source
bun run dev /path/to/your/repo    # or point it anywhere
```

Or through the Makefile, which also handles the background case and cleanup:

```bash
make install
make run                          # hot reload, foreground
make run REPO=/path/to/your/repo  # or point it anywhere
make up                           # the same stack, backgrounded
make status                       # ports, pid, and the live graph counts
make kill                         # stop everything this project starts
make test                         # end to end, on its own ports
```

Viewer at <http://localhost:5188>, API at <http://localhost:5189>. Switching
repositories at runtime is live — open the **repo** drawer and type a path, or
use **choose folder…** for a picker with breadcrumbs, keyboard navigation,
recents, and per-row hints showing each directory's repo marker and analyzable
file count.

## The connections are real

The graph is not name matching. Each file's imports are resolved to actual files
in the repository — Node relative/index resolution, Python dotted packages, Rust
`mod`/`crate` paths, Go package directories — and every call site is then
resolved against the bindings genuinely in scope in that file before any
guessing is allowed:

| Tier | Meaning |
| --- | --- |
| `local` | The callee is defined in the same file. |
| `import` | The callee arrived through an explicit import of that name. |
| `member` | A method call on a value that came from the target file. |
| `unique` | The name is unique repo-wide, but no import backs it — inference. |
| `weak` | The name is ambiguous; nearest plausible match — inference. |

The **repo** drawer shows the split as a bar per tier, so you can see how much
of the map is fact and how much is inference. On this repository it is
about 90% resolved. Calls into third-party packages resolve to nothing and are
counted as external rather than invented.

Languages: **TypeScript, TSX, JavaScript, JSX, Python, Rust, Go**. JSX element
usage counts as an edge, so a React component tree is part of the graph.
 
## What you are looking at

| Element | Meaning |
| --- | --- |
| **X axis** | Call depth — entry points on the left, leaves on the right. |
| **Z axis** | Module lane — files grouped by directory, so a module reads as a band. |
| **Y axis** | Position within the file, so a file's definitions stack in source order. |
| **Streamlines** | Real call paths. The braiding is *hierarchical edge bundling*: intermediate points are pulled toward their directory's trunk, so paths through the same module bundle together. `edge bundling: 0` shows the raw graph. |
| **Colour** | The flow scalar on the legend. Cool is settled code; warm is code written seconds ago — and the cooldown runs continuously on the GPU, so colour keeps changing between server messages instead of freezing until the next one. |
| **Glyphs** | Definitions the traced paths visit, sized by fan-in + fan-out. |
| **Screens** | The most recently *changed* files, newest first. Changed lines are tinted, deletions struck through, and a flow rail marks the lines the call graph runs through. |
| **Tailing** | Each screen holds a buffer around the action and scrolls inside it to follow the newest change, wherever it lands in the file — an edit at line 260 scrolls there. Toggle under **navigate → screens**. |
| **Unsaved edits** | A file being typed into shows *before* it is saved, with a dashed cyan frame and an `unsaved` tag. See below. |
| **Grid** | Floor, two wall grids and height posts, so the space reads as a volume rather than a plane. It assembles on load: lines arrive scattered and settle into place in order, outwards from the centre and upwards from the floor. |
| **Import map** | The file-to-file import graph, as arcs above the bundle. Observed, not inferred. |
| **Module tree** | The directory tree; branches warm up when something under them changes. |

## Moving around

**WASD** or the **arrow keys** move the camera in both navigation modes;
**Q/E** drop and rise; **shift** sprints. **Orbit** keeps mouse drag for
framing the graph from outside. **Fly** swaps that for pointer-lock look —
click empty space to capture the mouse, Escape to release.

The HUD is a strip along the bottom: project, counts, colour legend, latest
change, mode, camera position, and the drawers. **Tab** opens the controls,
**C** the change log, **F** switches navigation mode. Everything but the strip
fades while you are flying and returns a moment after you stop.

### Screens

**Click** a screen and it turns to face you — the screen comes to you rather
than you going to it, and it keeps that angle until you click it again from
somewhere else.

**Double-click** flies you in until it fills the frame, square-on at the
distance where it exactly fits. **Escape** flies back to the pose you left —
the same translation in reverse, which is what makes leaving feel like the
inverse of arriving rather than a cut. The controls come back the moment each
flight lands, and the orbit pivot moves with you, so you orbit the screen you
flew to instead of swinging around the graph centre you left behind.

**Drag** moves a screen like a card on glass: it holds its distance and tracks
the cursor in the camera's own plane, so a pixel of pointer movement is a
predictable amount of world movement. Depth is a separate, deliberate control —
the **scroll wheel** pushes it away or pulls it closer. Two earlier versions
got this wrong in instructive ways: one projected onto a plane fixed at grab
time, which stopped matching the camera the moment you looked elsewhere; the
other swung the screen around you on a sphere, which is right for a headset
controller and wrong for a mouse.

Arrangements, under **navigate → screens**:

| Arrangement | For |
| --- | --- |
| `wall` *(default)* | A responsive grid, floating above the call bundle — column count follows the screen count, so five screens read as a block rather than a strip you pan across. |
| `stagger` | Stepped back in depth, showing their order at a glance. |
| `arc` | The grid curved around you, so each screen is square-on. |

Screens start aligned and stay wherever you put them. **ALIGN** in the bottom
bar (or **G**) snaps them all back into the grid; it shows a count and turns
amber whenever something has been moved or turned, so it reads as a live action
only when it has work to do. There is also a size slider and a **reset screen
positions** button in the navigate drawer.

### Tethers

Each screen sends lines to the definitions that live in its file, and the two
kinds are separated on purpose: definitions the last write touched leave the
**left** edge and run warm, everything else leaves the **right** edge and runs
cool. A glance at one screen tells you how much of its file is in play and
where in the graph that work is landing. Toggle under **display → screen links**.

## Unsaved edits

A file watcher only ever sees writes, so a file being typed into is invisible
until someone hits save. VS Code — and Cursor, VSCodium, Windsurf, Insiders —
persist their dirty editors to disk for hot exit, and those backups are
readable: the first line is the file's URI, the rest is the buffer. codeflow3d
watches those stores, diffs each buffer against what is on disk, and shows the
result on the screen with a dashed frame and an `unsaved` tag. The change log
labels it `TYPING` rather than `SAVE`, and the tail follows the edit as you
type, exactly as it does for a saved one.

What this does and does not cover, because it matters:

- The editor writes those backups on a short debounce after you stop typing —
  about a second. It is live, not instantaneous.
- It covers VS Code-family editors. Vim, Emacs and JetBrains use their own
  formats and are not read; for those, and for anything else, turning on
  autosave produces the same effect through the ordinary watcher.
- A backup whose content matches what is on disk is a leftover, not a pending
  edit, and is ignored — editors leave stale ones behind.
- The format is undocumented, so every step fails soft. If a backup cannot be
  parsed it is skipped and the app behaves as if the feature were not there.

Set `CODEFLOW_BACKUP_DIRS` (colon-separated) to add locations, for an editor
installed somewhere unusual.

## Every file, not just source

`package.json`, `requirements.txt`, a README, a Dockerfile, YAML, TOML, SQL,
CSS — anything textual is tracked, diffed, tailed and given a screen. Those
files contribute no nodes or edges, so the graph stays a call graph; they are
there because a dependency bump is exactly the kind of change worth watching
happen.

## Flat mode

Click a row in the **changes** drawer to open that file full screen. Line numbers, syntax
colours, flow rails, and the lines that changed on the last write. **edit** to
type, **⌘S** to save, **Escape** or **✕** to return to 3D.

It stays live while open: when the watcher reports the file changed, the new
text is pulled in. If you have unsaved work, the incoming version is never
dropped on top of it — you are told the file changed and you choose which to
keep.

Writes are confined to the watched repository; the path is resolved and checked
against the root before anything is written.

## Settings are per repository

How you want to look at a repo is a property of that repo. Every view setting —
toggles, bundling strength, navigation mode, screen arrangement and size,
tailing, the open drawer, pinned files and dragged screen positions — is stored
in `localStorage` keyed by the repository's root path, and restored when you
point the viewer back at it.

## How it works

```
local path
   │
   ├─ chokidar ──────────── every add / change / unlink / rmdir
   ├─ tree-sitter (WASM) ── ONE changed file re-parsed; facts cached per file
   ├─ resolve ───────────── module specifiers → real files; call sites → bindings
   │                        in scope, with a confidence tier on every edge
   ├─ diff ──────────────── LCS over the changed region, so an inserted line
   │                        does not mark the whole file dirty
   ├─ layout ────────────── deterministic: geometry is hashed from stable ids, so
   │                        untouched streamlines stay pixel-identical and only
   │                        the edited part of the scene moves
   └─ WebSocket ─────────── one SceneGraph message → React + three renders it
```

A full scan of this repository is ~300ms; a 2,700-file tree parses in ~2s. An
incremental reparse plus a complete graph rebuild is ~1ms. End to end, a save
reaches the screen in **~8ms** (measured over the real socket, ten saves).

Most of that number is other people's latency, and getting it down meant
attacking the waiting rather than the work:

- **Batching was a trailing debounce**, so every new event *extended* the wait
  and saving two files was slower than saving one. It now flushes on the
  leading edge — a save you make by hand waits for nothing — while bursts still
  coalesce into one revision, with the tail capped so a steady stream of writes
  cannot defer a flush indefinitely.
- **FSEvents is the floor.** Measured here, chokidar reports a write in 12-17ms
  and a 5ms poll reports it in 3-6ms; macOS coalesces with a latency Node does
  not expose. Polling the whole tree to win that back would be exactly the CPU
  burn this project set out to avoid — so only the files *on screen* get a
  poll, which is a handful of `stat` calls and makes the file you are editing
  the fastest one in the repo. A write reported by both routes is dropped as a
  duplicate on content comparison, so the feed still shows one entry per save.
- **The write-stability window** was 12ms of pure latency guarding against a
  half-written file that atomic-rename saves never produce. It is now 4ms, and
  a torn read self-corrects on the next event anyway.

Typing into an unsaved buffer is cheaper still, because typing changes a file's
*text* and not its call graph: the node placement, streamlines, module trunks,
import arcs and line roles are all still correct, so they are held and only the
screens rebuild. That took the per-keystroke server cost from **33ms to 5ms**.
The cache is dropped the moment a parse actually changes the graph, a different
set of files goes hot, or a layout setting moves.

### A save is a state update, not a re-render

The scene used to travel as one object, so any change re-sent all of it and the
client replaced the lot — a save read as a reload. It is now diffed by section
against what each client was last sent, and only what moved is sent:

```
text-only edit (a string literal)   [panels]                                1.8KB
structural edit (a new function)    [nodes+edges+streamlines+importLinks+…] 11.3KB
unsaved keystroke                   [panels]                                1.5KB
idle                                nothing
```

Two things make that a *smart* update rather than a smaller one. A pure text
edit no longer counts as a graph change at all — the parsed facts are
fingerprinted, so editing a comment or a string literal leaves the fingerprint
identical and the cached layout stands. And on the client every absent section
is carried over **by reference**, so an unchanged array keeps its object
identity, React sees no new props, and those subtrees are skipped entirely. A
save re-renders one screen.

A full scene is sent once, when a repo is opened.

### Getting to realtime

Reading an editor's backup store is the route that needs no setup, and on a
default desktop install it is also the route that sees nothing — which is worth
stating plainly, because a viewer showing nothing looks broken.

Desktop VS Code and Cursor write hot-exit backups when a *window closes*, not
while you type. Measured directly: a dirty editor produced **zero** backup
writes over ten seconds. So with default settings a file only appears once you
save it. Where backups are written continuously — remote and web workspaces,
some forks — the scan works as intended. The viewer reports which of the three
routes is actually reporting, in the `repo` drawer, rather than leaving you to
guess.

So the supported answer is an extension that pushes instead of us polling —
bundled, dependency-free, and installed by copying:

```bash
bun editor/install.ts        # VS Code, Cursor, VSCodium, Windsurf, Antigravity, Trae
```

Restart the editor and a `codeflow3d` item appears in the status bar. It hooks
`onDidChangeTextDocument`, which fires on every keystroke, and POSTs the buffer
over a keep-alive connection — **median 0.6ms, p95 1.5ms** from keystroke to the
screen in the browser, about 2.5KB each, and nothing is ever written to disk.
Changes are coalesced into one frame (16ms), because holding a keystroke longer
than the display can show it buys nothing.

It is plain CommonJS against the `vscode` API with no build step, and it speaks
HTTP rather than a WebSocket on purpose: the global `WebSocket` only arrived in
Node 22 and the extension host still runs Node 20. Every open buffer is offered,
including files from other projects — the server resolves absolute paths against
whatever repo it is watching and quietly ignores the rest, so the extension never
has to know which project is open. `bun editor/install.ts --uninstall` removes it.

The same push is available directly, in the shape of dispatching an action:

```jsonc
// over the websocket (no HTTP overhead, this is the fast one)
{ "t": "buffer", "file": "src/api.ts", "content": "…the buffer as it stands…" }
{ "t": "bufferClosed", "file": "src/api.ts" }
```

```bash
# or, for anything that cannot hold a socket
curl -X POST localhost:5189/api/buffer -H 'content-type: application/json'   -d '{"file":"src/api.ts","content":"…"}'
# content: null withdraws the buffer
```

A pushed buffer outranks anything found on disk and updates the scene in one
hop: push → diff → rebuild screens → broadcast. Paths may be absolute, a
`file://` URI, or repo-relative; anything outside the watched tree is accepted
and ignored rather than rejected, so an editor streaming every buffer it has
does not have to filter first.

Failing all of that, `"files.autoSave": "afterDelay"` with a short
`files.autoSaveDelay` routes real writes through the ~8ms save path above. The
`repo` drawer reports which of the three routes is actually reporting, and
offers the settings to copy when it can see nothing else.

Only the part of the graph the viewer can actually use goes over the wire —
nodes a streamline visits or that belong to a file on screen, and the edges
between them. The statistics stay truthful about the whole graph. Without this
a large tree produced a 13MB message on every single save.

There is no post-processing pass. The glow comes from the streamline material
being emissive and the glyphs carrying additive halo sprites — a full-screen
pass costs GPU every frame, and the one that used to be here could silently
render the whole scene black.

## Layout

```
server/
  index.ts        Bun.serve — WebSocket, REST, static hosting in production
  analyzer.ts     incremental per-file parsing + cached graph assembly
  parse/
    languages.ts  per-language tree-sitter queries
    extract.ts    definitions, imports and call sites for one file
    resolve.ts    module resolution + scope-aware call resolution
  diff.ts         line diff, prefix/suffix-trimmed LCS
  layout.ts       graph → positions, bundled streamlines, screens, tree
  watcher.ts      chokidar, batched into one scene revision per quiet window
client/src/
  scene/          Scene, Streamlines, Glyphs, CodePanels, ModuleTree,
                  ImportLinks, Environment, GridLines, Controls, Grab
  lib/            tube geometry, transfer function, canvas textures, disposal
  export/         GLTFExporter pipeline
  ui/             HUD + drawers, change log, flat mode, folder picker, GLB viewer
shared/
  protocol.ts     the wire types both sides import
  highlight.ts    the tokenizer both sides use
```

## GLB export

`export .glb` serializes the live scene, saves it to `exports/`, downloads a
copy, and opens it at `/viewer?src=…`.

Three adjustments happen at export time, because the live look comes from shader
injection that glTF cannot express: shader-driven materials become unlit
vertex-coloured materials (`KHR_materials_unlit`, which is what the live shader
approximates, so the asset looks like the screen); the floor, grid and lights are
excluded, since a 30-unit ground plane would swallow the bounding box and make
every viewer frame the data as a speck; and the pulse-animation attributes are
stripped, as they mean nothing in a static file.

Nodes keep readable names (`streamlines`, `glyph-cores`, `panel:src/auth.js`,
`module-tree`), so the asset is navigable in Blender's outliner.

## API

| Route | Purpose |
| --- | --- |
| `GET /api/status` | what is being watched, current stats |
| `GET /api/scene` | the current `SceneGraph` as JSON |
| `GET /api/events` | recent file events, with diff hunks |
| `POST /api/watch` | `{ path }` — switch repositories |
| `GET /api/browse?path=&hidden=` | directory listing with repo markers and source counts |
| `GET /api/source?file=` | full source of a file in the open repo |
| `POST /api/write` | `{ file, content }` — save an edit, confined to the repo |
| `POST /api/glb` | persist a GLB body to `exports/` |
| `GET /api/exports` | list saved GLBs |
| `WS /ws` | `scene`, `event`, `status`, `log` frames |

## Production

```bash
bun run build
bun run start -- --path /path/to/repo --port 5189
```

One port serves the built client, the API and the WebSocket.
