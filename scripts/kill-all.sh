#!/usr/bin/env bash
#
# Stop everything this project starts.
#
# The dev stack is a small tree, not one process: `bun scripts/dev.ts` supervises
# a `bun --watch server/index.ts` API and a Vite dev server, Vite spawns esbuild
# service processes, and `make test` runs a second copy of all of it on its own
# ports. Any of them can outlive its parent — a crashed supervisor leaves the
# Vite child holding port 5188, and the next `make up` then fails for a reason
# that looks nothing like the cause.
#
# So this does not guess. It collects candidates three ways — the pidfile, every
# port the project can bind, and command lines belonging to this checkout — then
# walks down to their descendants, subtracts anything it must not touch, and
# escalates SIGTERM to SIGKILL for whatever ignores the first ask.
#
# Usage:  scripts/kill-all.sh [--quiet]
# Exit:   0 when nothing is left, 1 when something survived.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QUIET=0
[ "${1:-}" = "--quiet" ] && QUIET=1

# Every port this project can bind: viewer, API, the pair `make test` uses, the
# debug port in .claude/launch.json, and Vite's preview default.
PORTS="${PORTS_OVERRIDE:-5188 5189 5288 5289 5174 4173}"

# Command-line fragments that identify a process as ours. Relative script paths
# are how the Makefile and dev.ts invoke them; the absolute node_modules path
# catches the binaries they spawn in turn (vite, esbuild, tsc), which is what a
# bare script-name match misses.
PATTERNS="
scripts/dev.ts
scripts/daemon.ts
scripts/e2e.ts
scripts/sync-wasm.ts
server/index.ts
client/vite.config.ts
$ROOT/node_modules
"

# Never kill these, however well they match.
#
# The editor and this session both hold the project path in their command lines,
# and `pgrep -f` cannot tell the difference between a Vite server we started and
# the process that asked us to stop it. Getting this wrong takes the user's
# editor down with the dev stack.
# Editors, this session, and any browser that merely has the viewer open.
DENY='Visual Studio Code|Code Helper|Electron|extensionHost|tsserver|typescript/lib|claude|ugrep|rg --|kill-all\.sh'
DENY="$DENY"'|Google Chrome|Chromium|Safari|firefox|Brave Browser|Arc|Microsoft Edge|Playwright'

say() { [ "$QUIET" = 1 ] || printf '%s\n' "$*"; }
cmd_of() { ps -o command= -p "$1" 2>/dev/null | head -1; }
alive() { kill -0 "$1" 2>/dev/null; }

# ---------------------------------------------------------------- protected set

# This script, its shell, the make that called it, and every ancestor up to
# init. All of them can match a pattern; none of them may be killed.
protected=" $$ "
_p=$$
while [ -n "$_p" ] && [ "$_p" != "0" ] && [ "$_p" != "1" ]; do
  _p="$(ps -o ppid= -p "$_p" 2>/dev/null | tr -d ' ')"
  [ -n "$_p" ] && protected="$protected $_p "
done

is_protected() {
  case "$protected" in *" $1 "*) return 0 ;; esac
  local c
  c="$(cmd_of "$1")"
  [ -z "$c" ] && return 0                      # already gone
  printf '%s' "$c" | grep -qE "$DENY" && return 0
  return 1
}

# ---------------------------------------------------------------- collect

# The selection, as newline-separated "pid|reason" records.
#
# Not an associative array: macOS ships bash 3.2, which does not have them, and
# a kill script is the last thing that should need a newer shell installed first.
SEL=""

has_pid() { printf '%s' "$SEL" | grep -q "^$1|"; }
sel_pids() { printf '%s' "$SEL" | awk -F'|' 'NF{print $1}'; }
sel_reason() { printf '%s' "$SEL" | awk -F'|' -v p="$1" '$1==p {print $2; exit}'; }
sel_count() { printf '%s' "$SEL" | awk 'NF' | wc -l | tr -d ' '; }

add() { # add <pid> <reason>
  pid="$1"; why="$2"
  [ -z "$pid" ] && return
  case "$pid" in *[!0-9]*) return ;; esac
  is_protected "$pid" && return
  has_pid "$pid" && return
  SEL="${SEL}${pid}|${why}
"
}

# 1. whatever `make up` recorded
if [ -f "$ROOT/.run/dev.pid" ]; then
  add "$(tr -d ' \n' < "$ROOT/.run/dev.pid")" "pidfile"
fi

# 2. whatever is *listening* on one of our ports
#
#    Listeners only, deliberately. `lsof -ti tcp:5188` also returns every client
#    with an open connection to it — which is the editor's browser tab, or the
#    user's Chrome. Those do not stop the port being rebound, and killing the
#    editor to free a dev server is not a trade anyone wants.
for port in $PORTS; do
  for pid in $(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null); do add "$pid" "listening on $port"; done
done

# 3. anything whose command line says it belongs to this checkout
while read -r pat; do
  [ -z "$pat" ] && continue
  for pid in $(pgrep -f "$pat" 2>/dev/null); do add "$pid" "$pat"; done
done <<< "$PATTERNS"

# 4. descendants of all of the above: Vite's esbuild workers are children of a
#    child, so stopping the parent alone can leave them running
for _ in 1 2 3 4; do
  for pid in $(sel_pids); do
    for kid in $(pgrep -P "$pid" 2>/dev/null); do add "$kid" "child of $pid"; done
  done
done

if [ "$(sel_count)" -eq 0 ]; then
  say "  nothing running"
  exit 0
fi

# ---------------------------------------------------------------- stop

say "  stopping $(sel_count) process(es):"
for pid in $(sel_pids | sort -n); do
  say "$(printf '    %-7s %-22s %s' "$pid" "$(sel_reason "$pid")" "$(cmd_of "$pid" | cut -c1-58)")"
done

for pid in $(sel_pids); do kill -TERM "$pid" 2>/dev/null; done

# Give them a moment to close their watchers and sockets properly.
for _ in 1 2 3 4 5 6 7 8; do
  remaining=0
  for pid in $(sel_pids); do alive "$pid" && remaining=1; done
  [ "$remaining" = 0 ] && break
  sleep 0.25
done

killed9=""
for pid in $(sel_pids); do
  if alive "$pid"; then
    kill -KILL "$pid" 2>/dev/null && killed9="$killed9 $pid"
  fi
done
[ -n "$killed9" ] && say "    SIGKILL:$killed9"

rm -f "$ROOT/.run/dev.pid"

# ---------------------------------------------------------------- verify

sleep 0.3
left=""
for port in $PORTS; do
  held="$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null | tr '\n' ' ')"
  [ -n "$held" ] && left="$left port $port ($held);"
done
while read -r pat; do
  [ -z "$pat" ] && continue
  for pid in $(pgrep -f "$pat" 2>/dev/null); do
    is_protected "$pid" || left="$left pid $pid ($pat);"
  done
done <<< "$PATTERNS"

if [ -n "$left" ]; then
  say "  STILL RUNNING:$left"
  exit 1
fi
say "  all clear — every port free, no project processes left"
