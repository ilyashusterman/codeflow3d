# codeflow3d

**Watch an AI edit your codebase, live, in 3D.**

An agent touches twenty files in a minute and hands you a wall of tool calls.
Point this at the repo it is working in: every file becomes a code window, every
call a path between them, and every write arrives as motion *while it happens*.

![Files arriving in a live trace: a new screen slides into the row and fades up while the others make room, a write reveals itself line by line, and the screen that runs out of slots fades out](docs/live-trace.gif)

*One take, unedited — every arrival is a real file, written while the recording ran.*

## Install

You need [Bun](https://bun.sh). Then:

```bash
git clone https://github.com/ilyashusterman/codeflow3d
cd codeflow3d
bun install
bun run dev /path/to/your/repo    # omit the path to trace this repo
```

Open <http://localhost:5188>, edit a file in that repo, save. The screen scrolls
to the edit, the changed lines type themselves in, and the definitions you
touched warm up.

**Keys** — WASD/arrows move, Q/E down and up, shift sprints, F switches orbit and
fly, Tab controls, C change log, G re-align, Escape backs out. Double-click a
screen to fly into it; click a row in the change log to edit that file full
screen (`edit` to type, `⌘S` writes to disk).

## For developers

**Languages** — TypeScript · TSX · JavaScript · JSX · Python · Rust · Go are
parsed into the call graph with tree-sitter. Imports resolve to real files (Node
relative/index, Python dotted packages, Rust `mod`/`crate`, Go package dirs), and
JSX usage counts as an edge, so a React tree is part of the graph. Every other
text file is tracked, diffed and given a screen, but contributes no nodes.

**Speed** — a full scan of this repo is ~300ms, a 2,700-file tree ~2s. An
incremental re-parse plus a complete graph rebuild is ~1ms; end to end, a save
reaches the screen in **~8ms**, re-rendering one screen rather than the view.

```
local path → chokidar → tree-sitter (one file) → resolve imports and call sites
           → diff → layout → WebSocket → React + three.js
```

**Makefile** — `make run`, `make up` (background), `make status`, `make kill`,
`make gif` (re-records the demo above), `make test` (boots the whole stack
against a throwaway repo and asserts the chain end to end, 73 checks).

**[How it works](docs/architecture.md)** — every element in the scene, edge
confidence tiers, unsaved-buffer capture, the 8ms path, the editor push
extension, GLB export, the HTTP/WebSocket API, production build.

Built on [tree-sitter](https://tree-sitter.github.io/tree-sitter/),
[Bun](https://bun.sh), [three.js](https://threejs.org),
[React Three Fiber](https://r3f.docs.pmnd.rs), [React](https://react.dev),
[zustand](https://zustand.docs.pmnd.rs),
[chokidar](https://github.com/paulmillr/chokidar) and [Vite](https://vite.dev).

## Collaboration

Open to any collaboration — ideas, features, integrations, or something built on
top of this. [shusterilyaman@gmail.com](mailto:shusterilyaman@gmail.com), or open
an issue on [GitHub](https://github.com/ilyashusterman/codeflow3d).

[MIT](LICENSE) — do what you like with it, keep the notice.
