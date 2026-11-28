#!/usr/bin/env bash
# mcp-tasks-register.sh — register the no-live MCP Tasks server with Claude Code
# on ONE operator node (a2a-nexus #2591 design §7 step 3 preparation).
#
# Default is a DRY RUN: it validates inputs and prints the exact
# `claude mcp add` command. Nothing is registered without --apply.
# Registering it on a node is the approval-gated step 3 itself; run --apply
# only with that approval. Rollback: --remove (or `claude mcp remove`).
#
# The edge secret is never an argument here and never reaches the MCP
# config: only the env file's PATH is passed (A2A_MCP_TASKS_ENV_FILE). The
# server reads the secret from that file at start-up (design §4.2).
#
# Usage:
#   mcp-tasks-register.sh --broker-url URL --env-file PATH --requester-id ID \
#       --role ROLE --targets NODE[,NODE...] [--kind node] [--state-dir DIR] \
#       [--name a2a-tasks] [--scope user] [--entry PATH] [--apply]
#   mcp-tasks-register.sh --remove [--name a2a-tasks] [--scope user] [--apply]
#
# Exit codes: 0 ok (dry run printed, or applied) · 2 refused input · 1 claude failed.
set -euo pipefail

NAME="a2a-tasks"
SCOPE="user"
KIND="node"
APPLY=0
REMOVE=0
BROKER_URL="" ENV_FILE="" REQUESTER_ID="" ROLE="" TARGETS="" STATE_DIR=""
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENTRY="$HERE/../dist/mcp-tasks-server/cli.js"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"

refuse() { echo "refused: $*" >&2; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --broker-url) BROKER_URL="${2:-}"; shift 2 ;;
    --env-file) ENV_FILE="${2:-}"; shift 2 ;;
    --requester-id) REQUESTER_ID="${2:-}"; shift 2 ;;
    --role) ROLE="${2:-}"; shift 2 ;;
    --kind) KIND="${2:-}"; shift 2 ;;
    --targets) TARGETS="${2:-}"; shift 2 ;;
    --state-dir) STATE_DIR="${2:-}"; shift 2 ;;
    --name) NAME="${2:-}"; shift 2 ;;
    --scope) SCOPE="${2:-}"; shift 2 ;;
    --entry) ENTRY="${2:-}"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    --remove) REMOVE=1; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) refuse "unknown argument: $1" ;;
  esac
done

[[ "$NAME" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || refuse "--name must be 1..64 of [A-Za-z0-9._-]"
case "$SCOPE" in local|user|project) ;; *) refuse "--scope must be local, user, or project" ;; esac

run() {
  printf '%q ' "$@"; echo
  if [ "$APPLY" -eq 1 ]; then "$@" || exit 1; fi
}

if [ "$REMOVE" -eq 1 ]; then
  [ "$APPLY" -eq 1 ] || echo "# dry run — add --apply to remove"
  run "$CLAUDE_BIN" mcp remove --scope "$SCOPE" "$NAME"
  exit 0
fi

[ -n "$BROKER_URL" ] || refuse "--broker-url is required"
[ -n "$ENV_FILE" ] || refuse "--env-file is required"
[ -n "$REQUESTER_ID" ] || refuse "--requester-id is required"
[ -n "$ROLE" ] || refuse "--role is required"
[ -n "$TARGETS" ] || refuse "--targets is required"
case "$(printf '%s' "$ROLE" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')" in
  hub|operator) refuse "--role must not be hub or operator (design §4.2)" ;;
esac
case "$BROKER_URL" in
  https://*) ;;
  http://127.0.0.1*|http://localhost*|http://\[::1\]*) ;;
  *) refuse "--broker-url must be https, or http to a loopback host" ;;
esac
case "$ENV_FILE" in /*) ;; *) refuse "--env-file must be an absolute path" ;; esac
[ -f "$ENV_FILE" ] && [ ! -L "$ENV_FILE" ] || refuse "--env-file must be an existing regular file"
mode="$(stat -c '%a' "$ENV_FILE")"
[ $(( 8#$mode & 8#077 )) -eq 0 ] || refuse "--env-file must not be accessible by group or other (mode $mode)"
[ "$(stat -c '%u' "$ENV_FILE")" = "$(id -u)" ] || refuse "--env-file must be owned by this user"
[ -f "$ENTRY" ] || refuse "entry point not built: $ENTRY (run the broker build first)"

ENTRY="$(cd "$(dirname "$ENTRY")" && pwd)/$(basename "$ENTRY")"
args=(mcp add --scope "$SCOPE" "$NAME"
  -e "A2A_MCP_TASKS_BROKER_URL=$BROKER_URL"
  -e "A2A_MCP_TASKS_ENV_FILE=$ENV_FILE"
  -e "A2A_MCP_TASKS_REQUESTER_ID=$REQUESTER_ID"
  -e "A2A_MCP_TASKS_REQUESTER_KIND=$KIND"
  -e "A2A_MCP_TASKS_REQUESTER_ROLE=$ROLE"
  -e "A2A_MCP_TASKS_ALLOWED_TARGETS=$TARGETS")
[ -z "$STATE_DIR" ] || args+=(-e "A2A_MCP_TASKS_STATE_DIR=$STATE_DIR")
args+=(-- node "$ENTRY")

# Validate the exact configuration the client will pass before registering it.
env -i HOME="$HOME" PATH="$PATH" \
  A2A_MCP_TASKS_BROKER_URL="$BROKER_URL" A2A_MCP_TASKS_ENV_FILE="$ENV_FILE" \
  A2A_MCP_TASKS_REQUESTER_ID="$REQUESTER_ID" A2A_MCP_TASKS_REQUESTER_KIND="$KIND" \
  A2A_MCP_TASKS_REQUESTER_ROLE="$ROLE" A2A_MCP_TASKS_ALLOWED_TARGETS="$TARGETS" \
  ${STATE_DIR:+A2A_MCP_TASKS_STATE_DIR="$STATE_DIR"} \
  node "$ENTRY" --check-config >/dev/null 2>&1 || refuse "the entry point refused this configuration (run it with --check-config to see why)"

[ "$APPLY" -eq 1 ] || echo "# dry run — add --apply to register"
run "$CLAUDE_BIN" "${args[@]}"
