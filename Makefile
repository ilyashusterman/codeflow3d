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

# Everything `make kill` is responsible for. Patterns are project-scoped, so an
# unrelated bun or vite elsewhere on the machine is left alone.
PORTS    := $(UI_PORT) $(API_PORT) $(E2E_UI_PORT) $(E2E_API_PORT)
PATTERNS := scripts/dev.ts scripts/e2e.ts server/index.ts client/vite.config.ts

DEV := PORT=$(UI_PORT) API_PORT=$(API_PORT)

.PHONY: help install run dev up down kill kill-all restart logs status \
        build start typecheck test test-e2e clean

help:
	@printf '\n  codeflow3d\n\n'
	@printf '  make install     bun install + tree-sitter wasm grammars\n'
	@printf '  make run         dev stack with hot reload (foreground, ctrl-c to stop)\n'
	@printf '  make up          dev stack in the background\n'
	@printf '  make logs        follow the background log\n'
	@printf '  make status      ports, pid, and what the API reports\n'
	@printf '  make kill        stop every process this project starts\n'
	@printf '  make restart     kill, then up\n'
	@printf '  make test        end-to-end: API, watcher, viewer, HMR, write-back\n'
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

# Ports first — that is what actually blocks a restart — then any straggler
# holding no socket: a crashed Vite child, a --watch supervisor mid-reload.
kill kill-all down:
	@test -f $(RUN_DIR)/dev.pid && kill "$$(cat $(RUN_DIR)/dev.pid)" 2>/dev/null \
	  && printf '  pid %s -> stopped\n' "$$(cat $(RUN_DIR)/dev.pid)" || true
	@for p in $(PORTS); do pids=$$(lsof -ti tcp:$$p 2>/dev/null); \
	  if [ -n "$$pids" ]; then kill $$pids 2>/dev/null; \
	    printf '  port %s -> stopped %s\n' "$$p" "$$(echo $$pids | tr '\n' ' ')"; fi; done
	@for pat in $(PATTERNS); do pids=$$(pgrep -f "$$pat" 2>/dev/null); \
	  if [ -n "$$pids" ]; then kill $$pids 2>/dev/null; \
	    printf '  %s -> stopped %s\n' "$$pat" "$$(echo $$pids | tr '\n' ' ')"; fi; done
	@sleep 0.8
	@# Whatever ignored SIGTERM gets SIGKILL, so `make up` is never blocked.
	@for p in $(PORTS); do pids=$$(lsof -ti tcp:$$p 2>/dev/null); \
	  if [ -n "$$pids" ]; then kill -9 $$pids 2>/dev/null; \
	    printf '  port %s -> SIGKILL %s\n' "$$p" "$$(echo $$pids | tr '\n' ' ')"; fi; done
	@for pat in $(PATTERNS); do pids=$$(pgrep -f "$$pat" 2>/dev/null); \
	  if [ -n "$$pids" ]; then kill -9 $$pids 2>/dev/null; fi; done
	@rm -f $(RUN_DIR)/dev.pid
	@echo "  all codeflow3d processes stopped"

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

clean:
	rm -rf $(ROOT)/client/dist $(RUN_DIR)
	@echo "cleaned"
