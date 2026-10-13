#!/bin/bash
# a2a-nexus#1504 Phase 7-B — one-shot driver for an owner-approved run, fired once
# by an operator-installed permanent timer at the window start (see README.md).
# Order:
#   0 time guard (WINDOW_START .. +P7B_GO_GUARD_MIN, else no-op)  1 run-once marker
#   2 reboot hold: `run-b.sh reboot-hold` — writes the apt hold, cancels a reboot
#     that unattended-upgrades had ALREADY scheduled, persistent expiry timer (#2379;
#     r2 set the hold after a 03:15 reboot was already scheduled and lost T+24h)
#   3 pre-check dry-run (B0/B1)  4 shadow window >= P7B_MIN_SHADOW_H
#   5 run-b.sh execute (its own B0..B8 + approved rollback)
# Any failure in 0..4 stops BEFORE any broker change; a failure in 3..4 also
# releases the hold it set in 2.
# GO_PREFLIGHT=1: steps 3..4 only — no marker, no hold, no execute (rehearsal; the
# dry-run then reports a pending reboot as FAIL and auto-reboot as WARN).
#
# Inputs (env): P7B_TAG (file-name tag, default today KST YYYYMMDD) ·
#   P7B_EXPECT_REV (40-hex) · P7B_WINDOW_START / P7B_WINDOW_END ('YYYY-MM-DD HH:MM'
#   KST, <= 3h) · P7B_APPROVAL (owner phrase, logged verbatim) ·
#   P7B_HOLD_HOURS (default 26: run start .. T+24h observation + margin) ·
#   P7B_GO_GUARD_MIN (default 30) · P7B_MIN_SHADOW_H (default 24) · P7B_DIR
# Exit codes: 3 setup · 5 time guard · 6 marker exists · 7 dry-run failed ·
#   8 shadow window · 9 reboot hold failed · 64 usage · else run-b.sh execute's code
set -uo pipefail
HOME="${HOME:-/root}"
HERE="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]:-$0}")")" && pwd)"
RUNB="${P7B_RUNB:-$HERE/run-b.sh}"
D="${P7B_DIR:-$HOME/a2a-phase7b}"; export P7B_DIR="$D"
mkdir -p -m 700 "$D" && cd "$D" || exit 3
TAG="${P7B_TAG:-$(TZ=Asia/Seoul date +%Y%m%d)}"
REV="${P7B_EXPECT_REV:-}"
WIN_START="${P7B_WINDOW_START:-}"; WIN_END="${P7B_WINDOW_END:-}"
APPROVAL="${P7B_APPROVAL:-}"
HOLD_HOURS="${P7B_HOLD_HOURS:-26}"
GUARD_MIN="${P7B_GO_GUARD_MIN:-30}"
MIN_SHADOW_H="${P7B_MIN_SHADOW_H:-24}"
GLOG="$D/go-$TAG.log"
SPOOL="${P7B_SPOOL:-$HOME/.claude/state/telegram-spool}"
log() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" | tee -a "$GLOG"; }
notify() {
  mkdir -p "$SPOOL" 2>/dev/null || return 0
  local f; f="$SPOOL/$(date -u +%Y-%m-%dT%H-%M-%SZ)-A2AP7B-go-$$_$RANDOM.json"
  jq -nc --arg ts "$(date '+%FT%T%z')" --arg node "$(hostname -s)" --arg text "$1" \
    '{ts:$ts, event:"SelfUpdate", node:$node, text:$text, dedup:("A2AP7B:"+$text[0:40])}' > "$f" 2>/dev/null || rm -f "$f"
}
stop() { log "GO-ABORT($2): $1 — no broker change made"; [ "${GO_PREFLIGHT:-0}" = 1 ] || notify "❌ #1504 P7-B 사전 단계 중단: $1 (브로커 변경 없음)"; log "EXIT=$2"; exit "$2"; }
HOLD_SET=0
release_and_stop() { # <reason> <code>
  if [ "$HOLD_SET" = 1 ]; then "$RUNB" reboot-release >> "$GLOG" 2>&1 && log "reboot hold released (pre-execute abort)"; fi
  stop "$1" "$2"
}

[[ "$REV" =~ ^[0-9a-f]{40}$ ]] || { log "P7B_EXPECT_REV must be 40-hex"; exit 64; }
if [ "${GO_PREFLIGHT:-0}" != 1 ]; then
  [ -n "$WIN_START" ] && [ -n "$WIN_END" ] && [ -n "$APPROVAL" ] || { log "P7B_WINDOW_START/END and P7B_APPROVAL are required"; exit 64; }
  [[ "$HOLD_HOURS" =~ ^[0-9]+$ && "$GUARD_MIN" =~ ^[0-9]+$ ]] || { log "P7B_HOLD_HOURS / P7B_GO_GUARD_MIN must be integers"; exit 64; }
  now=$(date +%s); lo=$(date -d "$WIN_START +0900" +%s 2>/dev/null) || { log "bad P7B_WINDOW_START"; exit 64; }
  hi=$(( lo + GUARD_MIN * 60 ))
  { [ "$now" -ge "$lo" ] && [ "$now" -le "$hi" ]; } || stop "time guard: fired outside ${WIN_START}~+${GUARD_MIN}m KST" 5
  [ -e "$D/go-$TAG.started" ] && stop "run-once marker exists" 6
  date '+%FT%T%z' > "$D/go-$TAG.started"
  log "=== go start tag=$TAG (approval: $APPROVAL)"

  # 2 reboot hold (approved: 실행 직전 ~ +HOLD_HOURS) — also cancels an already-scheduled reboot
  P7B_APPROVAL="$APPROVAL" "$RUNB" reboot-hold "$HOLD_HOURS" >> "$GLOG" 2>&1; hrc=$?
  [ "$hrc" = 0 ] || stop "reboot-hold failed (run-b.sh rc=$hrc, see run-b.log)" 9
  HOLD_SET=1; log "reboot hold set for ${HOLD_HOURS}h (pending reboot, if any, cancelled)"
else
  log "=== go PREFLIGHT tag=$TAG (steps 3..4 only)"
fi

# 3 pre-check dry-run
out=$(P7B_EXPECT_REV=$REV "$RUNB" dry-run 2>&1); rc=$?
printf '%s\n' "$out" | grep -E 'B0 pass|snapshot B1|ABORT|dry-run done' | sed 's/^/  precheck: /' | tee -a "$GLOG" >/dev/null
[ "$rc" = 0 ] || release_and_stop "pre-check dry-run rc=$rc" 7

# 4 shadow window
h=$(printf '%s\n' "$out" | grep -oE 'window=[^ ]+\+[0-9.]+h' | tail -1 | sed -E 's/.*\+([0-9.]+)h$/\1/')
[ -n "$h" ] || release_and_stop "shadow window not parsed from B1 line" 8
awk -v h="$h" -v m="$MIN_SHADOW_H" 'BEGIN{exit !(h+0 >= m+0)}' || release_and_stop "shadow window ${h}h < ${MIN_SHADOW_H}h" 8
log "shadow window ${h}h >= ${MIN_SHADOW_H}h"
if [ "${GO_PREFLIGHT:-0}" = 1 ]; then log "PREFLIGHT ok (would set reboot hold and execute)"; log "EXIT=0"; exit 0; fi

# 5 execute
log "execute start"
P7B_EXPECT_REV=$REV P7B_WINDOW_START="$WIN_START" P7B_WINDOW_END="$WIN_END" P7B_APPROVAL="$APPROVAL" \
  "$RUNB" execute >> "$GLOG" 2>&1
rc=$?
log "execute finished rc=$rc"
log "EXIT=$rc"
exit "$rc"
