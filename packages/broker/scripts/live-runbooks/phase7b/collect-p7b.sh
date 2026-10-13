#!/bin/bash
# a2a-nexus#1504 Phase 7-B — result / B8 verdict collector, run on a separate
# collector node (read-only ssh to the broker host). Exists because r1's failure
# went unreported for ~2 days: the outcome is posted to the issue automatically,
# whatever it is.
#   collect-p7b.sh result   → execution outcome (go.sh EXIT code)
#   collect-p7b.sh b8       → B8 auto pre-verdict (PASS / FAIL / INCOMPLETE)
# r3 (#2379): when the T+24h row is missing the verdict now names the cause —
#   observe_failed (the T+24h unit ran but wrote no row) · timer_lost_reboot (a
#   host boot inside the B8 window; r2's transient timers vanished this way) ·
#   not_due (the persistent timer is still pending) · timer_not_fired (unknown) —
#   and every verdict flags a restart inside the window (epoch change, host boot or
#   broker start after B6) as a caveat: then it is not a continuous 24h run.
# Install it with a persistent timer of its own (Persistent=true) — see README.md.
#
# Env: P7B_SSH_HOST (required unless COLLECT_RAW) · P7B_REMOTE_DIR (default
#   /root/a2a-phase7b) · P7B_REMOTE_BROKER_DIR (broker checkout for the .env RATE
#   check; optional) · P7B_REMOTE_UNIT_DIR (default /etc/systemd/system) ·
#   P7B_REMOTE_UNIT_PREFIX (default a2a-p7b) · P7B_COLLECT_OUT (default $HOME/.claude/state/p7b-collect) · P7B_REPO / P7B_ISSUE
#   (default jinwon-int/a2a-nexus #1504) · P7B_WIKI=1 to also open a Family Wiki
#   LOG PR (needs wiki-agent; P7B_WIKI_NODE names the LOG id, default hostname -s)
# COLLECT_DRY=1   print the comment instead of posting/notifying
# COLLECT_RAW=f   use a saved raw capture instead of ssh (tests)
set -uo pipefail
MODE="${1:-result}"
HOME="${HOME:-/root}"
OUT="${P7B_COLLECT_OUT:-$HOME/.claude/state/p7b-collect}"; mkdir -p -m 700 "$OUT"
TS=$(date +%Y%m%dT%H%M%S); RAW="$OUT/$MODE-$TS.raw"; MD="$OUT/$MODE-$TS.md"
REPO="${P7B_REPO:-jinwon-int/a2a-nexus}"; ISSUE="${P7B_ISSUE:-1504}"
SPOOL="${P7B_SPOOL:-$HOME/.claude/state/telegram-spool}"
NODE="${P7B_WIKI_NODE:-$(hostname -s)}"
log() { printf '%s %s\n' "$(date '+%FT%T%z')" "$*" >> "$OUT/collect.log"; }
notify() { [ "${COLLECT_DRY:-0}" = 1 ] && return 0; mkdir -p "$SPOOL" || return 0
  local f; f="$SPOOL/$(date -u +%Y-%m-%dT%H-%M-%SZ)-A2AP7B-collect-$$.json"
  jq -nc --arg ts "$(date '+%FT%T%z')" --arg node "$(hostname -s)" --arg text "$1" \
    '{ts:$ts, event:"SelfUpdate", node:$node, text:$text, dedup:("A2AP7B:"+$text[0:40])}' > "$f" 2>/dev/null || rm -f "$f"; }
case "$MODE" in result|b8) ;; *) echo "usage: $0 result|b8"; exit 64 ;; esac

if [ -n "${COLLECT_RAW:-}" ]; then cp "$COLLECT_RAW" "$RAW"
else
  [ -n "${P7B_SSH_HOST:-}" ] || { echo "P7B_SSH_HOST is required"; exit 64; }
  # shellcheck disable=SC2029  # the remote dirs are expanded locally on purpose
  timeout 60 ssh -o BatchMode=yes -o ConnectTimeout=10 "$P7B_SSH_HOST" \
    "D='${P7B_REMOTE_DIR:-/root/a2a-phase7b}' BRD='${P7B_REMOTE_BROKER_DIR:-}' UD='${P7B_REMOTE_UNIT_DIR:-/etc/systemd/system}' UP='${P7B_REMOTE_UNIT_PREFIX:-a2a-p7b}' bash -s" > "$RAW" 2>&1 <<'REMOTE'
G=$(ls -t "$D"/go-*.log 2>/dev/null | head -1)
echo "##GO";     [ -n "$G" ] && tail -80 "$G"
echo "##SVC";    u=$(systemctl list-units --all --no-legend 'a2a-p7b*go.service' 2>/dev/null | awk '{print $1}' | head -1)
                 [ -n "$u" ] && systemctl show "$u" -p Result -p ExecMainStatus -p ExecMainStartTimestamp -p ExecMainExitTimestamp
echo "##OBS";    cat "$D/observe.log" 2>/dev/null
echo "##B6";     b=$(ls -t "$D"/B6-start-* 2>/dev/null | head -1); [ -n "$b" ] && { echo "${b##*/B6-start-}"; cat "$b"; }
echo "##BOOT";   uptime -s; date +%z
echo "##LIVE";   docker inspect -f '{{.State.StartedAt}} restarts={{.RestartCount}} rev={{index .Config.Labels "org.opencontainers.image.revision"}}' a2a-broker
                 if [ -n "$BRD" ]; then echo "rate_line=$(grep -c '^BROKER_SHARED_STATE_V1_RATE=' "$BRD/.env")"; fi
                 echo "readyz=$(curl -s -m5 http://127.0.0.1:8787/readyz | tr -d '\n' | cut -c1-160)"
# A finished self-disabling one-shot is unloaded, so `systemctl show` is blank for
# it; the durable evidence is the Persistent= stamp file (mtime = last trigger,
# survives reboot) and the journal's last Finished/Failed line.
echo "##UNITS";  for t in "$UD/$UP"-*observe-*.timer; do [ -e "$t" ] || continue; n=$(basename "$t" .timer)
                   st=/var/lib/systemd/timers/stamp-$n.timer
                   oc=$(sed -n 's/^OnCalendar=//p' "$t" | head -1)
                   echo "$n oncal_s=$( [ -n "$oc" ] && date -d "$oc" +%s 2>/dev/null || echo 0) stamp_s=$(stat -c %Y "$st" 2>/dev/null || echo 0) enabled=$(systemctl is-enabled "$n.timer" 2>/dev/null) last=$(journalctl -u "$n.service" -n 30 -o cat --no-pager 2>/dev/null | grep -E '^(Finished|Failed|.*Failed with result)' | tail -1 | cut -c1-80 | tr ' ' _)"; done
echo "##TIMERS"; systemctl list-timers --all --no-legend | grep -i p7b
echo "##HOLD";   ls /etc/apt/apt.conf.d/ | grep phase7 || echo none
echo "##SCHED";  cat /run/systemd/shutdown/scheduled 2>/dev/null | tr '\n' ' ' || true; echo
echo "##END"
REMOTE
  echo "ssh_rc=$?" >> "$RAW"
fi
sec() { awk -v s="##$1" '$0==s{f=1;next} /^##[A-Z0-9]+$/{f=0} f' "$RAW"; }
# fence-owner flag is not a secret, but keep the "token=" notation out of public comments
scrub() { sed -E 's/token=([01])/fence_held=\1/g; s/(EDGE_SECRET|SECRET|PASSWORD)=[^ ]*/\1=<redacted>/g'; }
GO=$(sec GO)
# Rows/units of the newest run only (#2379): B6 section = "<RUN_ID>\n<B6 ISO>".
# r2 rows carry no run= field and are judged as a whole (legacy).
TAG=$(sec B6 | sed -n 1p | grep -oE '^[0-9]{8}T[0-9]{6}' || true)
OBS=$(sec OBS)
if [ -n "$TAG" ] && printf '%s\n' "$OBS" | grep -q " run="; then OBS=$(printf '%s\n' "$OBS" | grep -E " run=$TAG( |$)"); fi
UNITS=$(sec UNITS); [ -n "$TAG" ] && UNITS=$(printf '%s\n' "$UNITS" | grep -E -- "-$TAG " || true)
EXITN=$(printf '%s\n' "$GO" | grep -oE 'EXIT=[0-9]+' | tail -1 | cut -d= -f2)
T24=$(printf '%s\n' "$GO" | sed -nE 's/.*B8 timer T\+24h at ([0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}).*/\1/p' | tail -1)

z2s() { local z=$1; [[ "$z" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || return 1; date -u -d "${z:0:8} ${z:9:2}:${z:11:2}:${z:13:2}" +%s; }
B6S=$(date -d "$(sec B6 | tail -1)" +%s 2>/dev/null || echo 0)
BOOTZ=$(sec BOOT | sed -n 2p)
# every host boot we know of: the rows' boot= values plus the boot at collect time
boots_s() {
  local z b
  for z in $(printf '%s\n' "$OBS" | grep -oE '(^| )boot=[0-9TZ]+' | cut -d= -f2 | sort -u); do z2s "$z"; done
  b=$(sec BOOT | sed -n 1p); [ -n "$b" ] && date -d "$b ${BOOTZ:-+0000}" +%s 2>/dev/null
}
fmt_s() { TZ=Asia/Seoul date -d "@$1" '+%Y-%m-%d %H:%M:%S KST'; }
# Restart caveat: epoch change across rows, a host boot or broker start after B6.
restart_caveat() {
  local eps out="" b bs=() z bst bsts
  eps=$(printf '%s\n' "$OBS" | grep -oE '(^| )epoch=[0-9]+' | cut -d= -f2 | uniq | paste -sd'>' - | sed 's/>/→/g')
  [ "$(printf '%s' "$eps" | grep -c '→')" -gt 0 ] && out="epoch ${eps}"
  if [ "$B6S" -gt 0 ]; then
    for b in $(boots_s | sort -un); do [ "$b" -gt "$B6S" ] && bs+=("$(fmt_s "$b")"); done
    [ ${#bs[@]} -gt 0 ] && out="${out:+$out · }host boot ${bs[*]}"
    bst=$(printf '%s\n' "$OBS" | grep -oE '(^| )broker_started=[0-9TZ]+' | cut -d= -f2 | sort -u | tail -1)
    if [ -n "$bst" ]; then bsts=$(z2s "$bst" || echo 0)
    else bst=$(sec LIVE | head -1 | cut -d' ' -f1); bsts=$(date -d "$bst" +%s 2>/dev/null || echo 0); bst="${bst%%.*}Z (live)"; fi
    [ "$bsts" -gt $(( B6S + 300 )) ] && out="${out:+$out · }broker started ${bst}"
  fi
  printf '%s' "$out"
}
ufield() { printf '%s' "$1" | grep -oE "(^| )$2=[^ ]*" | head -1 | sed -E "s/^ ?$2=//"; }
missing24_cause() { # prints "<cause>|<사유>"
  local u24 t24s oncals stamps last en now b inwin=""
  u24=$(printf '%s\n' "$UNITS" | grep -E 'observe-24h' | head -1)
  oncals=$(ufield "$u24" oncal_s); oncals=${oncals:-0}
  stamps=$(ufield "$u24" stamp_s); stamps=${stamps:-0}
  last=$(ufield "$u24" last | tr _ ' '); en=$(ufield "$u24" enabled)
  t24s=$oncals; [ "$t24s" -gt 0 ] || t24s=$(date -d "$T24 ${BOOTZ:-+0000}" +%s 2>/dev/null || echo 0)
  now=$(date -d "${P7B_COLLECT_NOW:-now}" +%s)
  for b in $(boots_s | sort -un); do
    if [ "$B6S" -gt 0 ] && [ "$b" -gt "$B6S" ] && { [ "$t24s" = 0 ] || [ "$b" -le "$t24s" ]; }; then inwin=$(fmt_s "$b"); fi
  done
  if [ -n "$u24" ] && [ "$oncals" -gt 0 ] && [ "$stamps" -ge "$oncals" ]; then
    echo "observe_failed|T+24h 관측은 실행됐으나 행 없음 — 관측 실패(트리거 $(fmt_s "$stamps"), journal: ${last:-없음}; 브로커 호스트 .snap-B8-T+24h-*.out 확인)"
  elif [ -n "$u24" ] && [ "$en" = enabled ] && [ "$oncals" -gt "$now" ]; then
    echo "not_due|T+24h 관측 미도래 — 영구 타이머 대기 중($(fmt_s "$oncals"))"
  elif [ -n "$inwin" ]; then
    if [ -z "$u24" ]; then echo "timer_lost_reboot|T+24h 관측 타이머 소실 — 관측 창 안 재부팅(${inwin}), 영구 관측 유닛 없음(임시 타이머였을 가능성)"
    else echo "timer_lost_reboot|T+24h 관측 미실행 — 관측 창 안 재부팅(${inwin}) 후 영구 유닛이 따라잡지 못함(enabled=${en:-?})"; fi
  else
    echo "timer_not_fired|T+24h 관측 타이머 미발화 — 원인 확인 필요(관측 창 안 재부팅 없음, unit=${u24:+있음}${u24:-없음} enabled=${en:-?})"
  fi
}

if [ "$MODE" = result ]; then
  case "${EXITN:-none}" in
    0)  V="✅ 전환 완료 (B7 통과) — B8 관측 진행 중"; MARK="open" ;;
    40) V="↩️ B7 검증 실패 → 승인된 롤백 완료 (rate는 메모리 limiter로 복귀)"; MARK="closed" ;;
    2|5|6|7|8|9|11|12|13) V="⏹ 변경 전 중단 (exit $EXITN) — 브로커 변경 없음"; MARK="closed" ;;
    2[0-5]|3[0-3]) V="🚨 정지/개입 필요 (exit $EXITN) — 브로커가 정지 상태이거나 롤백 이상일 수 있음, 즉시 확인"; MARK="closed" ;;
    none) V="❓ 실행 기록 없음 — 타이머 미발화 또는 수집 실패(ssh 결과 확인)"; MARK="closed" ;;
    *)  V="⚠️ 예상 밖 exit $EXITN — 확인 필요"; MARK="closed" ;;
  esac
  {
    echo "<!-- future-ending-test-issue-tracking: $MARK -->"
    echo "## Phase 7-B 실행 결과 (자동 수집 $(date '+%Y-%m-%d %H:%M') KST · ${NODE} \`collect-p7b.sh result\`)"
    echo
    echo "**판정**: $V"
    if [ "$MARK" = open ]; then
      echo "**Tracking model**: clock-based · **Expected end time**: B8 T+24h 관측 ${T24:-(로그 확인)} KST · **Next action**: \`collect-p7b.sh b8\` 자동 판정(T+24h 이후 collector 타이머) → 오너 확인"
    else
      echo "**Verdict**: $( [ "${EXITN:-}" = 0 ] && echo PASS || echo INCOMPLETE ) — 재실행은 새 승인 필요"
    fi
    echo; echo "<details><summary>go / run 로그 (마지막 부분)</summary>"; echo; echo '```'
    printf '%s\n' "$GO" | grep -vE '^\s*$' | tail -40 | scrub
    echo '```'; echo "</details>"; echo
    echo '```'; echo "service: $(sec SVC | tr '\n' ' ')"; sec LIVE | scrub; echo "timers:"; sec TIMERS; echo "reboot hold: $(sec HOLD | tr '\n' ' ')"; echo "scheduled shutdown: $(sec SCHED | tr '\n' ' ')"; echo '```'
  } > "$MD"
  NOTE="#1504 P7-B 결과: $V"
else  # b8
  if [ -z "$OBS" ]; then
    why="no observe.log"; [ -n "$TAG" ] && [ -n "$(sec OBS)" ] && why="no observation rows for the newest run $TAG (older runs' rows ignored)"
    log "b8: $why (execution outcome exit=${EXITN:-none}); nothing to judge"; echo "$why" > "$MD"
    [ "${EXITN:-}" = 0 ] && notify "⚠️ #1504 P7-B B8 관측 로그 없음 — 확인 필요"
    [ "${COLLECT_DRY:-0}" = 1 ] && cat "$MD"; exit 0
  fi
  RES=$(printf '%s\n' "$OBS" | awk '
    { lab=""; for(i=1;i<=NF;i++){ split($i,kv,"="); v[kv[1]]=kv[2]; if(kv[1]=="label") lab=kv[2] }
      n++; labs=labs" "lab
      bad += (v["503"]+0) + (v["state_unavailable"]+0) + (v["ownership_conflict"]+0) + (v["prune_fail"]+0) + (v["prune_lost_fence"]+0)
      if (v["snapshot_rc"]!="0") snap++
      if (v["newest_rate_age_s"]=="none" || v["newest_rate_age_s"]+0 > 300) stale++
      r=v["rate_since_b6"]+0; if (n>1 && r<=prev) nonmono++; prev=r; last=r }
    END { printf "n=%d labels=%s bad=%d snap_nonzero=%d stale=%d nonmono=%d last_rate_since_b6=%d", n, labs, bad, snap+0, stale+0, nonmono+0, last }')
  has24=$(printf '%s\n' "$OBS" | grep -c 'label=T+24h')
  kv() { printf '%s\n' "$RES" | grep -oE "(^| )$1=[0-9]+" | cut -d= -f2; }
  bad=$(kv bad); snap_nonzero=$(kv snap_nonzero); stale=$(kv stale); nonmono=$(kv nonmono)
  CAUSE=""
  if [ "$bad" != 0 ] || [ "$snap_nonzero" != 0 ] || [ "$stale" != 0 ] || [ "$nonmono" != 0 ]; then VER=FAIL; WHY="기준 위반: $RES"
  elif [ "$has24" = 0 ]; then VER=INCOMPLETE; c=$(missing24_cause); CAUSE=${c%%|*}; WHY="T+24h 관측 행 없음 — ${c#*|}"
  else VER=PASS; WHY="모든 기준 충족"; fi
  CAVEAT=$(restart_caveat)
  {
    echo "<!-- future-ending-test-issue-tracking: closed -->"
    echo "## Phase 7-B B8 관측 자동 판정 — **$VER** (자동 $(date '+%Y-%m-%d %H:%M') KST · ${NODE} \`collect-p7b.sh b8\`) — **오너 확인 필요**"
    echo
    echo "**Verdict**: $VER — $WHY"
    [ -n "$CAUSE" ] && echo "**누락 원인 분류**: \`$CAUSE\` (observe_failed · timer_lost_reboot · not_due · timer_not_fired)"
    [ -n "$CAVEAT" ] && echo "**단서**: 관측 창 안 재시작 — ${CAVEAT}. 무중단 연속 24h 관측이 아니다(재시작 후 위반 0 여부로만 읽을 것)."
    echo "**기준**([#2369 계획](https://github.com/jinwon-int/a2a-nexus/issues/2369#issuecomment-6105114498)): 각 관측에서 503·state_unavailable·ownership_conflict·prune_fail·prune_lost_fence = 0, snapshot_rc = 0, newest_rate_age_s ≤ 300, rate_since_b6 단조 증가, T+24h 행 존재. \`rate_rows\` 총량 감소는 실패 아님(24h 보존 prune)."
    echo "**요약**: \`$RES\`"
    echo; echo '```'; printf '%s\n' "$OBS" | scrub; echo '```'
    echo; echo '```'; sec LIVE | scrub; echo "boot: $(sec BOOT | tr '\n' ' ')· B6: $(sec B6 | tail -1) · T+24h due: ${T24:-?}"; echo "run: ${TAG:-legacy}"; echo "units:"; printf '%s\n' "$UNITS"; echo "reboot hold: $(sec HOLD | tr '\n' ' ')"; echo '```'
  } > "$MD"
  NOTE="#1504 P7-B B8 자동 판정: $VER — $WHY${CAVEAT:+ (단서: $CAVEAT)} (오너 확인 필요)"
fi

# ---- Family Wiki record (optional, best-effort, after the GitHub post) --------
# Own clone (WORK_DIR) so an interactive session's half-done edits in the
# default worktree can never be swept into this PR; the wiki-agent worktree
# lock under $WIKI_HOME/run is still shared, so the two never run at once.
# COLLECT_WIKI_DRY=1: build + insert the entry, print the diff, then revert (no PR).
WIKI_WORK_DIR="${P7B_WIKI_WORK_DIR:-$HOME/.wiki-agent/wiki-pr-work-p7b/seoyoon-family-wiki}"
wiki_entry() { # <issue-comment-url>
  local day dayd
  day=$(TZ=Asia/Seoul date +%Y%m%d); dayd=$(TZ=Asia/Seoul date +%Y-%m-%d)
  if [ "$MODE" = result ]; then
    echo "## [LOG-${day}-${NODE}-@SEQ@] ${dayd} KST — a2a-nexus#${ISSUE} Phase 7-B 실행 결과(자동 기록): $(printf '%s' "$V" | sed -E 's/^[^ ]+ //')"
    echo "- **결과**: $V — go exit \`${EXITN:-none}\`. 상세·로그: [#${ISSUE} 코멘트]($1)."
    [ "$MARK" = open ] && echo "- **B8 관측**: T+24h ${T24:-(로그 확인)} KST, 판정은 \`collect-p7b.sh b8\`가 자동 게시."
    echo "- **라이브**: $(sec LIVE | scrub | tr '\n' ' ' | sed -E 's/ +$//') · 재부팅 보류: $(sec HOLD | tr '\n' ' ' | sed -E 's/ +$//')"
  else
    echo "## [LOG-${day}-${NODE}-@SEQ@] ${dayd} KST — a2a-nexus#${ISSUE} Phase 7-B B8 관측 자동 판정: ${VER} (오너 확인 필요)"
    echo "- **판정**: ${VER} — ${WHY}. 상세·관측 원본: [#${ISSUE} 코멘트]($1)."
    [ -n "$CAVEAT" ] && echo "- **단서**: 관측 창 안 재시작 — ${CAVEAT} (무중단 연속 24h 아님)."
    echo "- **요약**: \`$(printf '%s' "$RES" | scrub)\`"
  fi
  echo "- **기록 경로**: ${NODE} \`collect-p7b.sh ${MODE}\` 자동 작성(a2a-nexus \`packages/broker/scripts/live-runbooks/phase7b/\`)."
}
wiki_record() { # <issue-comment-url> → 0 ok / 1 failed (never fatal)
  local dir day last seq entry out rc
  dir=$(WORK_DIR="$WIKI_WORK_DIR" wiki-agent write-path 2>>"$OUT/collect.log" | tail -1) || return 1
  [ -f "$dir/pages/log.md" ] || { log "wiki: no log.md in $dir"; return 1; }
  day=$(TZ=Asia/Seoul date +%Y%m%d)
  last=$(cat "$dir/pages/log.md" "$dir/pages/log-archive-$(TZ=Asia/Seoul date +%Y-%m-%d).md" 2>/dev/null \
         | grep -oE "LOG-${day}-${NODE}-[0-9]+" | sed -E 's/.*-//' | sort -n | tail -1)
  seq=$(( ${last:-0} + 1 ))
  entry=$(wiki_entry "$1" | sed "s/@SEQ@/$seq/")
  printf '%s\n' "$entry" | grep -Eiq '[A-Z0-9_]*(TOKEN|SECRET|PASSWORD)[[:space:]]*=' && { log "wiki: entry tripped secret guard pattern; skipped"; return 1; }
  ENTRY="$entry" python3 - "$dir/pages/log.md" <<'PY' || return 1
import os, sys
p = sys.argv[1]; L = open(p, encoding="utf-8").read().split("\n")
i = next(k for k, l in enumerate(L) if l.startswith("## [LOG-"))   # top, below the digest block
L[i:i] = os.environ["ENTRY"].split("\n") + [""]
open(p, "w", encoding="utf-8").write("\n".join(L))
PY
  if [ "${COLLECT_WIKI_DRY:-0}" = 1 ]; then
    git -C "$dir" --no-pager diff -U0 -- pages/log.md; git -C "$dir" checkout -q -- pages/log.md; log "wiki dry: LOG-${day}-${NODE}-${seq} (reverted)"; return 0
  fi
  out=$(cd "$dir" && WORK_DIR="$WIKI_WORK_DIR" wiki-agent pr 2>&1); rc=$?
  printf '%s\n' "$out" | tail -5 >> "$OUT/collect.log"
  if [ $rc -eq 0 ] && printf '%s\n' "$out" | grep -q "PR created"; then
    log "wiki: LOG-${day}-${NODE}-${seq} $(printf '%s\n' "$out" | grep -oE 'https://github.com/[^ ]+/pull/[0-9]+' | tail -1)"; return 0
  fi
  log "wiki: pr failed rc=$rc"; git -C "$dir" checkout -q -- pages/log.md 2>/dev/null; return 1
}

if [ "${COLLECT_DRY:-0}" = 1 ]; then cat "$MD"; log "$MODE dry: $NOTE"
  [ "${COLLECT_WIKI_DRY:-0}" = 1 ] && wiki_record "https://github.com/${REPO}/issues/${ISSUE}#issuecomment-DRYRUN"
  exit 0; fi
url=$(gh issue comment "$ISSUE" --repo "$REPO" --body-file "$MD" 2>>"$OUT/collect.log") \
  || { log "$MODE post FAILED"; notify "⚠️ $NOTE — GitHub 게시 실패, $MD 확인"; echo "EXIT=1" >> "$OUT/collect.log"; exit 1; }
log "$MODE posted $url"
WNOTE=""
if [ "${P7B_WIKI:-0}" = 1 ]; then
  if wiki_record "$url"; then WNOTE=" · Wiki 기록 PR 생성"; else WNOTE=" · ⚠️ Wiki 기록 실패(수동 기록 필요)"; fi
fi
notify "$NOTE $url$WNOTE"; echo "EXIT=0 $url wiki=${WNOTE}" >> "$OUT/collect.log"
