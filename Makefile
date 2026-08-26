# codeflow3d — install, run with hot reload, kill everything, test end to end.
#
#   make install     dependencies + tree-sitter wasm grammars
#   make run         hot-reload dev stack (foreground)
#   make up          same, in the background
#   make kill        stop everything this project starts
#   make test        end-to-end check of the whole stack
#
# Override the ports or the traced repository per invocation:
#   make run REPO=/path/to/repo UI_PORT=6000 API_PORT=6001
#
# Written for the GNU Make 3.81 that ships with macOS: no .ONESHELL, no
# .SHELLFLAGS, one shell per recipe line. Anything that needs state across
# statements lives in scripts/daemon.ts instead.

SHELL := /bin/bash
.DEFAULT_GOAL := help

ROOT     := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))
UI_PORT  ?= 5188
API_PORT ?= 5189
# Empty: dev.ts traces this repository's own source.
REPO     ?=
RUN_DIR  := $(ROOT)/.run
LOG      := $(RUN_DIR)/dev.log

# `make test` uses its own ports, so testing never disturbs a dev session and a
# dev session never fails a test run.
E2E_UI_PORT  ?= 5288
E2E_API_PORT ?= 5289

DEV := PORT=$(UI_PORT) API_PORT=$(API_PORT)

.PHONY: help install run dev up down kill kill-all restart logs status \
        build start typecheck test test-e2e gif shots clean

help:
	@printf '\n  codeflow3d\n\n'
	@printf '  make install     bun install + tree-sitter wasm grammars\n'
	@printf '  make run         dev stack with hot reload (foreground, ctrl-c to stop)\n'
	@printf '  make up          dev stack in the background\n'
	@printf '  make logs        follow the background log\n'
	@printf '  make status      ports, pid, and what the API reports\n'
	@printf '  make kill-all    stop every process and free every port this project uses\n'
	@printf '  make kill        the same thing, shorter to type\n'
	@printf '  make restart     kill, then up\n'
	@printf '  make test        end-to-end: API, watcher, viewer, HMR, write-back\n'
	@printf '  make gif         re-record docs/live-trace.gif from a real trace\n'
	@printf '  make shots       re-take the screenshots in docs/architecture.md\n'
	@printf '  make build       production client bundle\n'
	@printf '  make start       serve the built bundle from the API port\n'
	@printf '  make typecheck   tsc --noEmit\n'
	@printf '  make clean       remove build output and run state\n\n'
	@printf '  viewer  http://localhost:%s\n' '$(UI_PORT)'
	@printf '  api     http://localhost:%s\n' '$(API_PORT)'
	@printf '  trace a different repo:  make run REPO=/path/to/repo\n\n'

# ------------------------------------------------------------------ install

install:
	@command -v bun >/dev/null || { echo "bun is required — see https://bun.sh"; exit 1; }
	cd $(ROOT) && bun install
	@# postinstall stages the grammars; without them nothing parses, so fail
	@# here rather than at the first file the analyser opens.
	@test -n "$$(ls -A $(ROOT)/wasm 2>/dev/null)" \
	  || { echo "tree-sitter grammars missing — run: bun scripts/sync-wasm.ts"; exit 1; }
	@printf 'installed — %s tree-sitter grammars ready\n' "$$(ls $(ROOT)/wasm | wc -l | tr -d ' ')"

# ------------------------------------------------------------------ run

# Hot reload on all three levels: `bun --watch` restarts the API when server
# code changes, Vite serves the client over HMR, and chokidar re-parses the
# traced repository on every write there.
run dev:
	cd $(ROOT) && $(DEV) bun scripts/dev.ts $(REPO)

up:
	@mkdir -p $(RUN_DIR)
	@cd $(ROOT) && $(DEV) bun scripts/daemon.ts start $(REPO)

restart:
	@$(MAKE) --no-print-directory kill && $(MAKE) --no-print-directory up

logs:
	@mkdir -p $(RUN_DIR) && touch $(LOG) && tail -f $(LOG)

status:
	@cd $(ROOT) && $(DEV) bun scripts/daemon.ts status

# ------------------------------------------------------------------ kill

# `kill-all` is the thorough one, and `kill`/`down` are the same thing: the dev
# stack is a tree (dev.ts -> bun --watch API + Vite -> esbuild workers), and any
# node of it can outlive its parent and keep holding a port. The script collects
# candidates from the pidfile, from every port this project can bind, and from
# command lines belonging to this checkout, then walks down to their children and
# escalates SIGTERM to SIGKILL. It refuses to touch the editor or this shell.
kill kill-all down:
	@$(ROOT)/scripts/kill-all.sh

# ------------------------------------------------------------------ build, test

build:
	cd $(ROOT) && bun run build

start: build
	cd $(ROOT) && NODE_ENV=production bun server/index.ts $(if $(REPO),--path $(REPO),) --port $(API_PORT)

typecheck:
	cd $(ROOT) && bun run typecheck

# Boots the real stack on its own ports, drives it, tears it down.
test test-e2e:
	@mkdir -p $(RUN_DIR)
	cd $(ROOT) && PORT=$(E2E_UI_PORT) API_PORT=$(E2E_API_PORT) bun scripts/e2e.ts

# ------------------------------------------------------------------ the docs
#
# The recording in the README and the stills in docs/architecture.md are of a
# live trace, so they are produced by running one: the script stages a copy of
# this repository, boots the stack against it, writes real files into it on a
# schedule, and films the viewer reacting. Needs Chrome and ffmpeg.
gif:
	cd $(ROOT) && bun scripts/record-trace.ts

shots:
	cd $(ROOT) && bun scripts/record-trace.ts --stills

clean:
	rm -rf $(ROOT)/client/dist $(RUN_DIR)
	@echo "cleaned"
