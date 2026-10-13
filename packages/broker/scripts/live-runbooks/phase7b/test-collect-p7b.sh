#!/bin/bash
# Regression tests for collect-p7b.sh (a2a-nexus#2379). Hermetic: synthetic raw
# captures (COLLECT_RAW) + COLLECT_DRY=1 — no ssh, no GitHub post, no notify.
# The rows mirror the shape of the real 2026-10-12/13 r2 observations.
# Usage: test-collect-p7b.sh [path/to/collect-p7b.sh]
set -u
SUT="$(readlink -f "${1:-$(dirname "$0")/collect-p7b.sh}")"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "ok   - $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL - $1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; }

# row <ts> <label> <rate_since_b6> [epoch] [503] [snapshot_rc] [age]
row() { echo "$1 label=$2 snapshot_rc=${6:-0} state-shadow-snapshot: pass window=2026-10-12T01:15:44.642Z+1.0h replay=1/1 unexplained=0 rate=1/1 unexplained=0 503=${5:-0} state_unavailable=0 ownership_conflict=0 prune_fail=0 prune_lost_fence=0 ready={\"ready\":true,\"effectiveGrade\":\"single-process\",\"reasonCodes\":[]} token=1 epoch=${4:-23} rate_rows=$3 rate_since_b6=$3 newest_rate_age_s=${7:-2} fence_bytes=1 disk=76%"; }
GO_OK='2026-10-12T10:21:05+0900 [execute] B8 timer T+24h at 2026-10-13 10:15:42 (persistent, next=Tue 2026-10-13 10:15:42 KST)
2026-10-12T10:21:07+0900 EXIT=0'
# raw <file> <obs-rows> <boot-local> <units> [live-started] [go]
raw() {
  { echo "##GO"; printf '%s\n' "${6:-$GO_OK}"
    echo "##SVC"; echo "Result=success"
    echo "##OBS"; [ -n "$2" ] && printf '%s\n' "$2"
    echo "##B6"; echo "2026-10-12T01:15:42Z"
    echo "##BOOT"; echo "$3"; echo "+0900"
    echo "##LIVE"; echo "${5:-2026-10-12T01:15:45.1Z} restarts=0 rev=7f23cd70e36abf942363dd367a39f7d123249935"; echo 'readyz={"ready":true}'
    echo "##UNITS"; [ -n "$4" ] && printf '%s\n' "$4"
    echo "##TIMERS"; echo "##HOLD"; echo "none"; echo "##SCHED"; echo; echo "##END"; echo "ssh_rc=0"; } > "$T/$1.raw"
}
judge() { # <name> <mode>   (collector clock pinned to the r2 b8 run, 2026-10-13 10:50 KST, unless NOW=…)
  P7B_COLLECT_NOW="${NOW:-2026-10-13 10:50 +0900}" COLLECT_RAW="$T/$1.raw" COLLECT_DRY=1 P7B_COLLECT_OUT="$T/out" P7B_SPOOL="$T/spool" P7B_WIKI_NODE=collector \
    bash "$SUT" "$2" > "$T/out.$1" 2>&1; echo $? > "$T/rc.$1"; }
has() { grep -q -- "$2" "$T/out.$1"; }
expect() { # <name> <desc> <pattern>... (all must match, rc 0)
  local n=$1 d=$2 p; shift 2
  [ "$(cat "$T/rc.$n")" = 0 ] || { bad "$d" "rc=$(cat "$T/rc.$n") $(tail -3 "$T/out.$n" | tr '\n' ' ')"; return; }
  for p in "$@"; do has "$n" "$p" || { bad "$d" "missing '$p' :: $(grep -E 'Verdict|단서|원인' "$T/out.$n" | tr '\n' ' ')"; return; }; done
  ok "$d"; }
nothas() { if has "$1" "$2"; then bad "$3" "unexpected '$2'"; else ok "$3"; fi; }

R4="$(row 20261012T012105Z T+5m 141)
$(row 20261012T021545Z T+1h 1541)
$(row 20261012T071600Z T+6h 9234)
$(row 20261012T131603Z T+12h 18463)"
UPEND='a2a-p7b-observe-24h-20261012T100003 oncal=2026-10-13T10:15:42 stamp=2026-10-12T10:21:05 enabled=enabled last='
URAN='a2a-p7b-observe-24h-20261012T100003 oncal=2026-10-13T10:15:42 stamp=2026-10-13T10:15:43 enabled=disabled last=Failed_with_result_exit-code.'
UGONE='a2a-p7b-observe-24h-20261012T100003 oncal=2026-10-13T10:15:42 stamp=2026-10-12T10:21:05 enabled=disabled last='

# 1. clean PASS: 5 rows, no restart → PASS, no caveat
raw pass "$R4
$(row 20261013T011600Z T+24h 36869)" "2026-09-26 03:15:23" ""
judge pass b8; expect pass "clean 24h run → PASS" "Verdict\*\*: PASS"; nothas pass "단서" "clean run carries no restart caveat"
has pass "fence_held=1" && ! has pass "token=1" && ok "fence owner flag scrubbed to fence_held" || bad "fence owner flag scrubbed"

# 2. the real 2026-10-13 case: 03:15 reboot inside the window, manual T+24h (epoch 23→24) → PASS + caveat
raw restart "$R4
$(row 20261013T022639Z T+24h 36869 24)" "2026-10-13 03:15:23" "" "2026-10-12T18:15:37.524797998Z"
judge restart b8
expect restart "reboot inside the window → PASS with restart caveat" "Verdict\*\*: PASS" "단서\*\*: 관측 창 안 재시작" "epoch 23→24" "host boot 2026-10-13 03:15:23" "broker started 2026-10-12T18:15:37Z" "무중단 연속 24h 관측이 아니다"

# 3. r2's 10:50 situation: reboot inside the window, no T+24h row, no persistent unit → timer_lost_reboot
raw lost "$R4" "2026-10-13 03:15:23" ""
judge lost b8; expect lost "missing T+24h + boot in window → INCOMPLETE timer_lost_reboot" "Verdict\*\*: INCOMPLETE" '분류\*\*: .timer_lost_reboot.' "관측 창 안 재부팅(2026-10-13 03:15:23" "임시 타이머였을 가능성"

# 4. the persistent T+24h unit ran but wrote no row → observe_failed
raw obsfail "$R4" "2026-09-26 03:15:23" "$URAN"
judge obsfail b8; expect obsfail "T+24h unit ran, no row → INCOMPLETE observe_failed" "Verdict\*\*: INCOMPLETE" '분류\*\*: .observe_failed.' "Failed with result exit-code" "트리거 2026-10-13 10:15:43"
nothas obsfail '분류\*\*: .timer_lost_reboot.' "observe_failed is not mistaken for a lost timer"

# 5. collector fired early: persistent unit still pending → not_due
raw notdue "$R4" "2026-09-26 03:15:23" "$UPEND"
NOW="2026-10-13 09:00 +0900" judge notdue b8; expect notdue "pending persistent timer → INCOMPLETE not_due" '분류\*\*: .not_due.' "영구 타이머 대기 중(2026-10-13 10:15:42)"

# 6. no boot, unit never ran, no next elapse → timer_not_fired
raw notfired "$R4" "2026-09-26 03:15:23" "$UGONE"
judge notfired b8; expect notfired "no reboot, unit never ran → INCOMPLETE timer_not_fired" '분류\*\*: .timer_not_fired.' "원인 확인 필요"

# 6b. reboot inside the window, persistent unit present but it never caught up → timer_lost_reboot (unit variant)
raw caught "$R4" "2026-10-13 03:15:23" "$UGONE"
judge caught b8; expect caught "boot in window, persistent unit never ran → timer_lost_reboot (따라잡지 못함)" '분류\*\*: .timer_lost_reboot.' "따라잡지 못함"

# 7. criteria violation wins over a missing row → FAIL
raw viol "$(row 20261012T012105Z T+5m 141)
$(row 20261012T021545Z T+1h 1541 23 2)" "2026-09-26 03:15:23" ""
judge viol b8; expect viol "503 in a row → FAIL (even without T+24h)" "Verdict\*\*: FAIL" "bad=2"
raw stale "$R4
$(row 20261013T011600Z T+24h 36869 23 0 0 900)" "2026-09-26 03:15:23" ""
judge stale b8; expect stale "newest_rate_age_s > 300 → FAIL" "Verdict\*\*: FAIL" "stale=1"
raw nonmono "$R4
$(row 20261013T011600Z T+24h 100)" "2026-09-26 03:15:23" ""
judge nonmono b8; expect nonmono "rate_since_b6 not increasing → FAIL" "Verdict\*\*: FAIL" "nonmono=1"

# 8. result mode: go exit codes map to the right headline
raw r0 "" "2026-09-26 03:15:23" ""
judge r0 result; expect r0 "go EXIT=0 → 전환 완료, T+24h due time parsed from the persistent-timer line" "전환 완료" "Expected end time\*\*: B8 T+24h 관측 2026-10-13 10:15:42 KST"
raw r9 "" "2026-09-26 03:15:23" "" "" "2026-10-12T10:00:01+0900 GO-ABORT(9): reboot-hold failed
2026-10-12T10:00:01+0900 EXIT=9"
judge r9 result; expect r9 "go EXIT=9 (reboot-hold failed) → 변경 전 중단" "변경 전 중단 (exit 9)"
raw r21 "" "2026-09-26 03:15:23" "" "" "2026-10-12T10:05:00+0900 EXIT=21"
judge r21 result; expect r21 "go EXIT=21 → 정지/개입 필요" "정지/개입 필요 (exit 21)"

# 9. no observe.log → nothing judged, rc 0
raw empty "" "2026-09-26 03:15:23" ""
judge empty b8; expect empty "no observe.log → 'no observe.log', rc 0" "no observe.log"

# 10. the collector refuses to run without a host unless given a raw capture
P7B_COLLECT_OUT="$T/out" bash "$SUT" b8 > "$T/out.nohost" 2>&1; r=$?
[ "$r" = 64 ] && grep -q "P7B_SSH_HOST" "$T/out.nohost" && ok "no P7B_SSH_HOST and no COLLECT_RAW → 64" || bad "no host → 64" "rc=$r $(cat "$T/out.nohost")"

echo "---- $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
