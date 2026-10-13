#!/bin/bash
# a2a-nexus#1504 Phase 7-B (rate V1 serving cutover) — operator runbook driver.
# History: r1 aborted at B1 (fixed-path evidence EEXIST, 2026-10-09); r2
# (a2a-nexus#2369) made evidence per-run and window/revision run-time inputs and
# cut over on 2026-10-12. r3 (a2a-nexus#2379) hardens against host reboots after
# r2's T+24h observation was lost to a pre-scheduled unattended-upgrades reboot:
#   - every deferred action (B8 observations, reboot-hold expiry) is a PERSISTENT
#     one-shot systemd timer under $P7B_UNIT_DIR (default /etc/systemd/system),
#     Persistent=true, self-disabling — never a `systemd-run` transient timer,
#     which lives in /run and silently vanishes on reboot
#   - `reboot-hold <hours>` writes the apt hold AND cancels a reboot that
#     unattended-upgrades had already scheduled (`shutdown -c`); the hold file only
#     stops NEW schedules. If a schedule survives the cancel it aborts (53).
#   - B0 FAILs on a pending scheduled shutdown/reboot; it WARNs (dry-run) or FAILs
#     (execute) when the effective unattended Automatic-Reboot is still true
#     (the B8 window is >= 24h, so it always contains the daily reboot time)
#   - each B8 observation row carries boot= and broker_started= so a verdict can
#     tell "timer lost to a reboot" from "observation failed"
# B2..B7 (stop, fence check, backup, shadow delete + RATE=on, drain, start,
# verify with approved rollback) are unchanged from r1/r2.
# Approval: execute and reboot-hold need a FRESH owner approval phrase.
#
# Usage:
#   P7B_EXPECT_REV=<40-hex> run-b.sh dry-run
#       B0/B1 read-only checks + plan. Writes only evidence/log files in $D.
#   P7B_EXPECT_REV=<40-hex> P7B_WINDOW_START='YYYY-MM-DD HH:MM' \
#   P7B_WINDOW_END='YYYY-MM-DD HH:MM' P7B_APPROVAL='<owner phrase>' run-b.sh execute
#       window is KST, must be <= 3h, end in the future; refused outside it.
#   P7B_APPROVAL='<owner phrase>' run-b.sh reboot-hold <hours 1..48>
#       hold auto-reboot, cancel an already-scheduled reboot, persistent expiry.
#   run-b.sh reboot-release
#       remove the hold and disable hold-expiry timers (manual / pre-execute abort;
#       the persistent expiry timer itself runs a plain /bin/rm -f <hold>).
# Exit codes: 0 ok · 2 window refused · 11 B0 · 12 B1 shadow unexplained≠0 ·
#   13 B1 tool error/no evidence · 20..25 B2..B6 stop-states (see die sites) ·
#   30..33 rollback problems · 40 rolled back ·
#   50 hold already present · 51 hold file write · 52 hold-expiry unit · 53 scheduled reboot not cancelled ·
#   54 hold not effective (apt-config still Automatic-Reboot=true) · 64 usage
set -uo pipefail
MODE="${1:-dry-run}"
HOME="${HOME:-/root}"   # unset under a system service
SELF="${P7B_SELF:-$(readlink -f "${BASH_SOURCE[0]:-$0}")}"
D="${P7B_DIR:-$HOME/a2a-phase7b}"
BR="${P7B_BROKER_DIR:-$(cd "$(dirname "$SELF")/../../.." 2>/dev/null && pwd)}"   # <checkout>/packages/broker
ENVF="$BR/.env"
DATA=/var/lib/a2a-broker
STATE="$DATA/state.sqlite"
FENCE="$DATA/state.json.shared-state-v1.sqlite"
SHADOW="$DATA/state.json.shadow-v1.sqlite"
EXPECT_REV="${P7B_EXPECT_REV:-}"
C=a2a-broker
SPOOL="${P7B_SPOOL:-$HOME/.claude/state/telegram-spool}"
LOG="$D/run-b.log"
RUN_ID="$(date +%Y%m%dT%H%M%S)-${MODE}-$$"
DRAIN_SEC=930          # 15 min + 30 s margin, measured from the stop
VERIFY_WINDOW_SEC=300  # 5 min post-start log window
MAX_WINDOW_SEC=10800   # an approval window longer than 3h is refused
REBOOT_HOLD=/etc/apt/apt.conf.d/99-phase7-reboot-hold
UNIT_DIR="${P7B_UNIT_DIR:-/etc/systemd/system}"
UNIT_PREFIX="${P7B_UNIT_PREFIX:-a2a-p7b}"
SHUTDOWN_SCHEDULED="${P7B_SHUTDOWN_SCHEDULED:-/run/systemd/shutdown/scheduled}"
REBOOT_REQUIRED="${P7B_REBOOT_REQUIRED:-/var/run/reboot-required}"
mkdir -p -m 700 "$D"
umask 077

ts() { date '+%Y-%m-%dT%H:%M:%S%z'; }
log() { printf '%s [%s] %s\n' "$(ts)" "$MODE" "$*" | tee -a "$LOG"; }
notify() { # <text>
  mkdir -p "$SPOOL" 2>/dev/null || return 0
  local f="$SPOOL/$(date -u +%Y-%m-%dT%H-%M-%SZ)-A2AP7B-$$_$RANDOM.json"
  jq -nc --arg ts "$(ts)" --arg node "$(hostname -s)" --arg text "$1" \
    '{ts:$ts, event:"SelfUpdate", node:$node, text:$text, dedup:("A2AP7B:"+$text[0:40])}' > "$f" 2>/dev/null || rm -f "$f"
}
die() { log "ABORT: $1"; notify "❌ #1504 P7-B 중단: $1"; exit "${2:-10}"; }

fence_state() { # prints "token=<0|1> epoch=<n>"
  node -e 'const {DatabaseSync}=require("node:sqlite");const f=new DatabaseSync(process.argv[1],{readOnly:true});const r=f.prepare("SELECT owner_token IS NOT NULL AS t, lifecycle_epoch e FROM shared_state_ownership WHERE id=1").get();console.log("token="+(r.t?1:0)+" epoch="+r.e)' "$FENCE" 2>/dev/null
}
edge_secret() { docker inspect "$C" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | sed -n 's/^EDGE_SECRET=//p' | head -1; }
readyz_ok() { curl -s -m 5 http://127.0.0.1:8787/readyz | grep -q '"ready":true.*"effectiveGrade":"single-process"'; }
health_status() { docker inspect "$C" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null; }
running() { [ "$(docker inspect "$C" --format '{{.State.Running}}' 2>/dev/null)" = true ]; }
rate_rows() { node -e 'const {DatabaseSync}=require("node:sqlite");const f=new DatabaseSync(process.argv[1],{readOnly:true});console.log(f.prepare("SELECT COUNT(*) n FROM shared_state_rate_cost").get().n)' "$FENCE" 2>/dev/null; }
img_label() { docker image inspect broker-a2a-broker:latest --format "{{index .Config.Labels \"$1\"}}" 2>/dev/null; }

# ---- reboot safety (#2379) ---------------------------------------------------
apt_auto_reboot() { # prints "<effective Automatic-Reboot|unset> <Automatic-Reboot-Time|unset>"
  local d v t
  d=$(apt-config dump 2>/dev/null)
  v=$(printf '%s\n' "$d" | sed -n 's/^Unattended-Upgrade::Automatic-Reboot "\(.*\)";$/\1/p' | tail -1)
  t=$(printf '%s\n' "$d" | sed -n 's/^Unattended-Upgrade::Automatic-Reboot-Time "\(.*\)";$/\1/p' | tail -1)
  echo "${v:-unset} ${t:-unset}"
}
scheduled_shutdown() { # prints "<mode>@<local time>" and returns 0 when a shutdown/reboot is pending
  [ -f "$SHUTDOWN_SCHEDULED" ] || return 1
  local u m when="?"
  u=$(sed -n 's/^USEC=//p' "$SHUTDOWN_SCHEDULED" | head -1)
  m=$(sed -n 's/^MODE=//p' "$SHUTDOWN_SCHEDULED" | head -1)
  [[ "$u" =~ ^[0-9]+$ ]] && when=$(date -d "@$(( u / 1000000 ))" '+%Y-%m-%d %H:%M:%S%z')
  echo "${m:-unknown}@${when}"
}
reboot_checks() { # B0 part. ok → prints a note, 0 · FAIL → prints the reason, 1
  local s ar note
  if s=$(scheduled_shutdown); then
    echo "scheduled ${s} pending — run 'run-b.sh reboot-hold <h>' (it cancels with shutdown -c) or cancel it first"; return 1
  fi
  ar=$(apt_auto_reboot)
  case "$ar" in
    true\ *)
      if [ "$MODE" = execute ]; then
        echo "unattended Automatic-Reboot effective=true (time ${ar#* }) — the >=24h B8 window contains it; reboot hold not effective"; return 1
      fi
      note="auto_reboot=true@${ar#* }(WARN: inside the 24h B8 window — execute requires reboot-hold)" ;;
    *) note="auto_reboot=${ar%% *}" ;;
  esac
  [ -e "$REBOOT_REQUIRED" ] && note="$note reboot_required=yes"
  echo "$note"
}

# Persistent one-shot timer. Unit files live on disk (not /run), so they survive
# a reboot; Persistent=true runs an elapse that was missed while the host was
# down right after boot; the service disables (and stops) its own timer when it
# finishes, so it never fires twice. The files are kept as evidence.
SAFE_ARG='^[A-Za-z0-9_./+:=@-]+$'
schedule_persistent() { # <unit> <'YYYY-MM-DD HH:MM:SS' local> <description> <command> [args...] → prints next elapse
  local u=$1 at=$2 desc=$3 a next envs ats oncal; shift 3
  [[ "$u" =~ ^[A-Za-z0-9_.@-]+$ ]] || { echo "bad unit name '$u'"; return 1; }
  [[ "$at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}\ [0-9]{2}:[0-9]{2}:[0-9]{2}$ ]] || { echo "bad OnCalendar '$at'"; return 1; }
  ats=$(date -d "$at" +%s 2>/dev/null || echo 0)
  [ "$ats" -gt "$(date +%s)" ] || { echo "OnCalendar '$at' is not in the future"; return 1; }
  # write an explicit UTC time: `date` follows the caller's TZ, systemd follows
  # /etc/localtime — a bare local time would shift if the two differ
  oncal="$(date -u -d "@$ats" '+%Y-%m-%d %H:%M:%S') UTC"
  [[ "$desc" =~ ^[A-Za-z0-9\ _.:+/#-]+$ ]] || { echo "unsafe description '$desc'"; return 1; }
  # ExecStart/Environment are written verbatim: refuse anything systemd would
  # re-interpret (%, $, quotes, whitespace)
  envs=("HOME=$HOME" "P7B_DIR=$D" "P7B_SPOOL=$SPOOL" "P7B_UNIT_DIR=$UNIT_DIR" "P7B_UNIT_PREFIX=$UNIT_PREFIX" "P7B_BROKER_DIR=$BR")
  for a in "$@" "${envs[@]}"; do [[ "$a" =~ $SAFE_ARG ]] || { echo "unsafe ExecStart/Environment value '$a'"; return 1; }; done
  if [ -e "$UNIT_DIR/$u.timer" ] || [ -e "$UNIT_DIR/$u.service" ]; then echo "unit $u already exists (never overwritten)"; return 1; fi
  ( umask 022
    # After=docker.service: a Persistent= catch-up right after boot must not
    # run before the broker's container runtime is up
    { printf '%s\n' "[Unit]" "Description=$desc (a2a-nexus#1504 P7-B one-shot, run $RUN_ID)" \
        "After=docker.service network-online.target" "Wants=network-online.target" "" "[Service]" "Type=oneshot"
      printf 'Environment=%s\n' "${envs[@]}"
      printf '%s\n' "ExecStart=$*" "ExecStopPost=-/bin/systemctl disable --now $u.timer"; } > "$UNIT_DIR/$u.service" &&
    printf '%s\n' "[Unit]" "Description=$desc (a2a-nexus#1504 P7-B one-shot, run $RUN_ID)" "" \
      "[Timer]" "OnCalendar=$oncal" "AccuracySec=1min" "Persistent=true" "Unit=$u.service" "" \
      "[Install]" "WantedBy=timers.target" > "$UNIT_DIR/$u.timer" ) || { echo "cannot write units in $UNIT_DIR"; return 1; }
  if ! { systemctl daemon-reload && systemctl enable --now "$u.timer"; } >/dev/null 2>&1; then
    rm -f "$UNIT_DIR/$u.timer" "$UNIT_DIR/$u.service"; systemctl daemon-reload >/dev/null 2>&1
    echo "systemctl enable --now $u.timer failed (units removed)"; return 1
  fi
  next=$(systemctl show "$u.timer" -p NextElapseUSecRealtime --value 2>/dev/null)
  if [ -z "$next" ] || [ "$next" = n/a ]; then
    systemctl disable --now "$u.timer" >/dev/null 2>&1; rm -f "$UNIT_DIR/$u.timer" "$UNIT_DIR/$u.service"; systemctl daemon-reload >/dev/null 2>&1
    echo "$u.timer enabled but has no next elapse (disabled, units removed)"; return 1
  fi
  echo "$next"
}

reboot_release() {
  local t n=0
  rm -f "$REBOOT_HOLD"
  for t in "$UNIT_DIR/$UNIT_PREFIX"-hold-expire-*.timer; do
    [ -e "$t" ] || continue
    systemctl disable --now "$(basename "$t")" >/dev/null 2>&1; n=$((n+1))
  done
  logger -t a2a-p7b "reboot-hold released" 2>/dev/null || true
  log "reboot hold released (hold file removed, $n hold-expire timer(s) disabled; now $(apt_auto_reboot))"
  notify "🔓 #1504 P7-B 재부팅 보류 해제 — 자동 재부팅 정책 복귀 ($(apt_auto_reboot))"
}

reboot_hold() { # <hours>
  local h="${1:-}" exp unit r s ar
  { [[ "$h" =~ ^[0-9]+$ ]] && [ "$h" -ge 1 ] && [ "$h" -le 48 ]; } || { echo "usage: $0 reboot-hold <hours 1..48>"; exit 64; }
  [ -n "${P7B_APPROVAL:-}" ] || { echo "P7B_APPROVAL(오너 승인 문구) 미지정"; exit 64; }
  [[ "$P7B_APPROVAL" != *$'\n'* ]] || { echo "P7B_APPROVAL must be a single line"; exit 64; }
  [[ "$REBOOT_HOLD" =~ $SAFE_ARG ]] || { echo "unsafe hold path $REBOOT_HOLD"; exit 64; }
  # one hold at a time: a second hold would be released by the first one's expiry
  [ -e "$REBOOT_HOLD" ] && { echo "reboot hold already present ($REBOOT_HOLD) — run-b.sh reboot-release first"; exit 50; }
  exp=$(date -d "+$h hours" '+%Y-%m-%d %H:%M:%S'); unit="$UNIT_PREFIX-hold-expire-${RUN_ID%%-*}"
  log "=== reboot-hold ${h}h until $exp · approval: ${P7B_APPROVAL}"
  { printf '%s\n' \
      "// a2a-nexus#1504 Phase 7-B: hold unattended auto-reboot — approval: ${P7B_APPROVAL}" \
      "// Security updates still install; only the automatic reboot is deferred (reboot-required stays pending)." \
      "// Removed by the persistent timer ${unit}.timer (${exp}) via: /bin/rm -f ${REBOOT_HOLD}" \
      'Unattended-Upgrade::Automatic-Reboot "false";' > "$REBOOT_HOLD"; } 2>/dev/null || die "보류 파일 작성 실패($REBOOT_HOLD)" 51
  chmod 644 "$REBOOT_HOLD" 2>/dev/null
  # The expiry runs /bin/rm directly, never this script: a checkout that moves
  # or disappears within the hold must not leave the hold in place forever.
  r=$(schedule_persistent "$unit" "$exp" "P7-B reboot-hold expiry" /bin/rm -f "$REBOOT_HOLD") \
    || { rm -f "$REBOOT_HOLD"; die "보류 해제 영구 타이머 생성 실패: $r (보류 제거함)" 52; }
  log "hold-expiry timer $unit next=$r"
  ar=$(apt_auto_reboot)
  case "$ar" in false\ *) ;; *) reboot_release; die "보류가 적용되지 않음(apt-config Automatic-Reboot=${ar%% *}) — 더 뒤 순서의 설정 파일 확인" 54 ;; esac
  # The hold only stops NEW schedules: a reboot unattended-upgrades already
  # scheduled (shutdown -r <time>) still fires unless it is cancelled here.
  if s=$(scheduled_shutdown); then
    log "pending scheduled ${s} → shutdown -c"
    shutdown -c >> "$LOG" 2>&1; sleep 1
    if s=$(scheduled_shutdown); then reboot_release; die "예약된 재부팅 취소 실패(${s}) — 보류 해제함, 실행 중단" 53; fi
    log "scheduled reboot cancelled"; logger -t a2a-p7b "scheduled reboot cancelled by reboot-hold" 2>/dev/null || true
  fi
  [ -e "$REBOOT_REQUIRED" ] && log "reboot-required present: the kernel/security reboot stays pending and is re-scheduled by unattended-upgrades after the hold is released"
  log "reboot hold set (effective $(apt_auto_reboot)) until $exp"
  exit 0
}

SNAP_LAST=""
shadow_snapshot() { # <label> <outfile> → 0 pass · 2 unexplained≠0 · 3 tool error/no evidence
  local out="$2" so="$D/.snap-$1-$RUN_ID.out" rc
  if [ -e "$out" ]; then SNAP_LAST="evidence file already exists: $out (never overwritten)"; log "shadow snapshot $1 refused: $SNAP_LAST"; return 3; fi
  ( cd "$BR" && EDGE_SECRET="$(edge_secret)" node scripts/shared-state-shadow-snapshot.mjs \
      --base-url http://127.0.0.1:8787 --label "$1" --out "$out" ) > "$so" 2>&1
  rc=$?
  SNAP_LAST="$(tail -1 "$so")"
  log "shadow snapshot $1 rc=$rc out=$out $SNAP_LAST"
  if [ $rc -eq 0 ] && printf '%s\n' "$SNAP_LAST" | grep -q 'state-shadow-snapshot: pass'; then return 0; fi
  [ $rc -eq 2 ] && return 2
  return 3   # rc 3 (no evidence: /health read or file write failed), 64 usage, crash, or rc 0 without a pass line
}

window_check() { # validates P7B_WINDOW_START/END (KST) for execute; echoes a reason on refusal
  local s="${P7B_WINDOW_START:-}" e="${P7B_WINDOW_END:-}" lo hi now
  [ -n "$s" ] && [ -n "$e" ] || { echo "P7B_WINDOW_START/END 미지정"; return 1; }
  [ -n "${P7B_APPROVAL:-}" ] || { echo "P7B_APPROVAL(오너 승인 문구) 미지정"; return 1; }
  [[ "$s" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}\ [0-9]{2}:[0-9]{2}$ && "$e" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}\ [0-9]{2}:[0-9]{2}$ ]] \
    || { echo "창 형식은 'YYYY-MM-DD HH:MM'(KST)"; return 1; }
  lo=$(date -d "$s +0900" +%s 2>/dev/null) && hi=$(date -d "$e +0900" +%s 2>/dev/null) || { echo "창 시각 해석 실패"; return 1; }
  [ "$hi" -gt "$lo" ] || { echo "창 종료가 시작보다 이르거나 같음"; return 1; }
  [ $(( hi - lo )) -le "$MAX_WINDOW_SEC" ] || { echo "창 길이 $(( (hi-lo)/60 ))분 > 상한 $((MAX_WINDOW_SEC/60))분"; return 1; }
  now=$(date +%s)
  { [ "$now" -ge "$lo" ] && [ "$now" -le "$hi" ]; } || { echo "승인 창($s~$e KST) 밖"; return 1; }
}

compose_up() {
  ( cd "$BR" && A2A_BROKER_REVISION="$(img_label org.opencontainers.image.revision)" \
      A2A_BROKER_CREATED="$(img_label org.opencontainers.image.created)" \
      docker compose up -d --no-build "$C" ) >> "$LOG" 2>&1
}
wait_healthy() { # <timeout-sec>
  local i
  for i in $(seq 1 "$1"); do [ "$(health_status)" = healthy ] && return 0; sleep 1; done
  return 1
}

b0_checks() {
  local n rev free need inflight caps hold rb
  n=$(docker ps --format '{{.Names}}' | grep -cx "$C"); [ "$n" = 1 ] || { echo "broker containers=$n"; return 1; }
  readyz_ok || { echo "readyz not ready/single-process"; return 1; }
  rev=$(docker inspect "$C" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
  [ "$rev" = "$EXPECT_REV" ] || { echo "image revision $rev != $EXPECT_REV"; return 1; }
  grep -q '^BROKER_SHARED_STATE_V1_REPLAY=' "$ENVF" || { echo ".env has no REPLAY line"; return 1; }
  ! grep -q '^BROKER_SHARED_STATE_V1_RATE=' "$ENVF" || { echo ".env already has a RATE line"; return 1; }
  if [ -f "$REBOOT_HOLD" ]; then hold=present
  elif [ "$MODE" = execute ]; then echo "reboot hold file missing"; return 1
  else hold="ABSENT(WARN: execute requires it)"; fi
  rb=$(reboot_checks) || { echo "$rb"; return 1; }
  free=$(df --output=avail -B1 / | tail -1)
  need=$(( 3 * ( $(stat -c %s "$STATE") + $(stat -c %s "$STATE-wal" 2>/dev/null || echo 0) + $(stat -c %s "$FENCE") ) ))
  [ "$free" -ge "$need" ] || { echo "disk free $free < 3x state $need"; return 1; }
  inflight=$(node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1],{readOnly:true});console.log(d.prepare("SELECT COUNT(*) n FROM broker_tasks WHERE status NOT IN (\x27succeeded\x27,\x27failed\x27,\x27canceled\x27,\x27blocked\x27)").get().n)' "$STATE" 2>/dev/null)
  [ "$inflight" = 0 ] || { echo "in-flight tasks=$inflight"; return 1; }
  caps=$(docker exec -w /app/packages/broker "$C" node --input-type=module -e '
const v=await import("./dist/shared-state-storage-v1-values.js"); const t=await import("./dist/shared-state-time-v1-values.js");
const V=Object.values(v).find(x=>x&&x.limits&&x.limits.maxRateLimit); const T=Object.values(t).find(x=>x&&x.limits&&x.limits.maxDurationMs);
const e=process.env, n=(k,d)=>Number(e[k]??d); const rw=n("RATE_LIMIT_WINDOW_SEC",60), rm=n("RATE_LIMIT_MAX_REQUESTS",10), ww=n("WORKER_RATE_LIMIT_WINDOW_SEC",rw), wm=n("WORKER_RATE_LIMIT_MAX_REQUESTS",60);
const ok=(l,w)=>Number.isSafeInteger(Math.max(1,l))&&Math.max(1,l)<=V.limits.maxRateLimit&&Math.max(1,w)*1000<=Number(T.limits.maxDurationMs);
console.log((ok(rm,rw)&&ok(wm,ww)&&Math.max(rw,ww)<=900)?"pass":"fail");' 2>/dev/null)
  [ "$caps" = pass ] || { echo "rate cap/drain check: ${caps:-error}"; return 1; }
  echo "ok rev=${rev:0:8} $(fence_state) inflight=0 caps=pass disk_free=$((free/1073741824))G reboot_hold=$hold $rb"
}

rollback() { # <reason>  (approved: "#1504 P7-B 롤백승인")
  log "ROLLBACK start: $1"; notify "⚠️ #1504 P7-B 검증 실패 → 롤백 시작: $1"
  local t0 fs
  docker stop -t 120 "$C" >> "$LOG" 2>&1; t0=$(date +%s)
  fs=$(fence_state); log "rollback fence: $fs"
  case "$fs" in token=0*) ;; *) die "롤백 중 fence token 잔존($fs) — fence정리승인 없음, 브로커 정지 상태 유지" 30 ;; esac
  sed -i '/^BROKER_SHARED_STATE_V1_RATE=/d' "$ENVF"
  grep -q '^BROKER_SHARED_STATE_V1_RATE=' "$ENVF" && die "롤백: .env RATE 줄 제거 실패" 31
  log "rollback: RATE line removed; draining until stop+${DRAIN_SEC}s"
  while [ $(( $(date +%s) - t0 )) -lt "$DRAIN_SEC" ]; do sleep 10; done
  compose_up; wait_healthy 120 || die "롤백 기동 후 healthy 아님" 32
  sleep 10; readyz_ok || die "롤백 기동 후 readyz 실패" 33
  log "ROLLBACK done: $(fence_state)"; notify "↩️ #1504 P7-B 롤백 완료 — rate는 프로세스 메모리 limiter로 복귀, replay V1 유지. $(fence_state)"
  exit 40
}

# B8 observation script (read-only), per #2369 C review of 7f23cd70:
#   rate_since_b6   rows with numeric event_at >= B6 — the success signal. The
#                   plain rate_rows total is kept for continuity but becomes a
#                   ~24h sliding window once runtime prune (#2347, retention
#                   24h) catches up, so it can legitimately FALL after T+24h.
#   newest_rate_age_s  seconds since the newest rate row (fresh = serving).
#   prune_fail / prune_lost_fence  "runtime prune: failed|skipped (…)" lines since B6.
#   boot / broker_started (#2379)  host boot and container start (UTC); a value
#                   later than B6 means the observation spans a restart.
# Uses the same numeric predicate as the prune (CAST(event_at_unix_ms AS INTEGER)).
#   run / waited_s (#2379)  run tag (rows of an older run in the same $D are
#                   ignored by the collector) and seconds spent waiting for readyz
#                   (a Persistent= catch-up right after boot waits up to
#                   P7B_OBS_WAIT=300 s, then P7B_OBS_SETTLE=60 s for traffic).
OBS_TAG="${RUN_ID%%-*}"
OBS_SCRIPT="$D/observe-b-$OBS_TAG.sh"
write_observe_script() { # uses $D $BR $C $FENCE $B6ISO
  local b6ms; b6ms=$(( $(date -d "$B6ISO" +%s) * 1000 ))
  cat > "$OBS_SCRIPT" <<EOS
#!/bin/bash
# #1504 Phase 7-B B8 observation (read-only). Generated by run-b.sh run $RUN_ID.
set -u
D=$D; L=\${1:-manual}; RUN=$OBS_TAG
W=0; while [ \$W -lt \${P7B_OBS_WAIT:-300} ] && ! curl -s -m 5 http://127.0.0.1:8787/readyz | grep -q '"ready":true'; do sleep 10; W=\$((W+10)); done
[ \$W -gt 0 ] && sleep \${P7B_OBS_SETTLE:-60}
TS=\$(date -u +%Y%m%dT%H%M%SZ)
cd $BR || exit 3
EDGE_SECRET=\$(docker inspect $C --format "{{range .Config.Env}}{{println .}}{{end}}" | sed -n "s/^EDGE_SECRET=//p" | head -1) \\
  node scripts/shared-state-shadow-snapshot.mjs --base-url http://127.0.0.1:8787 --label "B8-\$L" --out "\$D/shadow-B8-\$L-\$TS.json" > "\$D/.snap-B8-\$L-\$RUN.out" 2>&1
RC=\$?
LOGS=\$(docker logs --since $B6ISO $C 2>&1)
C503=\$(printf "%s\n" "\$LOGS" | grep -c -- " 503"); CSU=\$(printf "%s\n" "\$LOGS" | grep -c state_unavailable); COC=\$(printf "%s\n" "\$LOGS" | grep -c ownership_conflict)
PFAIL=\$(printf "%s\n" "\$LOGS" | grep -cE "runtime prune: (failed|skipped) \\(")
PLOST=\$(printf "%s\n" "\$LOGS" | grep -c "runtime prune: .*lost_fence")
READY=\$(curl -s -m 5 http://127.0.0.1:8787/readyz | tr -d "\n" | cut -c1-80)
FENCE=\$(node -e 'const {DatabaseSync}=require("node:sqlite");const f=new DatabaseSync("$FENCE",{readOnly:true});const r=f.prepare("SELECT owner_token IS NOT NULL AS t, lifecycle_epoch e FROM shared_state_ownership WHERE id=1").get();const n=f.prepare("SELECT COUNT(*) n FROM shared_state_rate_cost").get().n;const s=f.prepare("SELECT COUNT(*) n, MAX(CAST(event_at_unix_ms AS INTEGER)) m FROM shared_state_rate_cost WHERE CAST(event_at_unix_ms AS INTEGER) >= ?").get($b6ms);const age=s.m==null?"none":Math.round((Date.now()-Number(s.m))/1000);console.log("token="+(r.t?1:0)+" epoch="+r.e+" rate_rows="+n+" rate_since_b6="+s.n+" newest_rate_age_s="+age)' 2>/dev/null)
SZ=\$(stat -c %s $FENCE 2>/dev/null || echo 0)
BOOT=\$(date -u -d "\$(uptime -s 2>/dev/null)" +%Y%m%dT%H%M%SZ 2>/dev/null || echo unknown)
BST=\$(date -u -d "\$(docker inspect $C --format "{{.State.StartedAt}}" 2>/dev/null)" +%Y%m%dT%H%M%SZ 2>/dev/null || echo unknown)
echo "\$TS label=\$L snapshot_rc=\$RC \$(tail -1 \$D/.snap-B8-\$L-\$RUN.out) 503=\$C503 state_unavailable=\$CSU ownership_conflict=\$COC prune_fail=\$PFAIL prune_lost_fence=\$PLOST ready=\$READY \$FENCE fence_bytes=\$SZ disk=\$(df --output=pcent / | tail -1 | tr -d " ") boot=\$BOOT broker_started=\$BST run=\$RUN waited_s=\$W" >> "\$D/observe.log"
EOS
  chmod 700 "$OBS_SCRIPT"
}

main() {
case "$MODE" in
  dry-run|execute) ;;
  reboot-hold) reboot_hold "${2:-}" ;;
  reboot-release) log "=== reboot-release"; reboot_release; exit 0 ;;
  *) echo "usage: $0 dry-run|execute|reboot-hold <hours>|reboot-release"; exit 64 ;;
esac
[[ "$EXPECT_REV" =~ ^[0-9a-f]{40}$ ]] || { echo "P7B_EXPECT_REV must be the full 40-hex image revision to expect (got '${EXPECT_REV}')"; exit 64; }
log "=== run-b.sh $MODE start (pid $$, run $RUN_ID, expect_rev ${EXPECT_REV:0:8})"
if [ "$MODE" = execute ]; then
  wr=$(window_check) || die "승인 창 검사 거부: $wr" 2
  log "approval window ${P7B_WINDOW_START}~${P7B_WINDOW_END} KST · approval: ${P7B_APPROVAL}"
  notify "▶️ #1504 P7-B 시작 (rate V1 serving 전환, 약 17분 브로커 비가용)"
fi

# B0 precheck
r=$(b0_checks) || die "B0 사전점검 실패: $r" 11
log "B0 pass: $r"
# B1 shadow evidence (gate 4 is judged on this pre-stop snapshot); per-run file, never reused
B1OUT="$D/shadow-B1-prestop-$RUN_ID.json"
shadow_snapshot B1-prestop "$B1OUT"; src=$?
case $src in
  0) ;;
  2) die "B1 shadow 불합격(unexplained≠0): $SNAP_LAST" 12 ;;
  *) die "B1 스냅샷 도구 오류/증거 없음(판정 불가, 데이터 불합격 아님): $SNAP_LAST" 13 ;;
esac
log "B1 pass ($B1OUT)"

if [ "$MODE" = dry-run ]; then
  log "dry-run plan: B2 docker stop -t 120 → B3 fence token=0 check → B4 backup $DATA/backups/pre-phase7-rate-<ts>/ (state+fence+.env, shadow excluded) → B5 delete shadow ($(stat -c %s "$SHADOW" 2>/dev/null || echo 0)B) + append RATE=on + drain ${DRAIN_SEC}s → B6 compose up --no-build → B7 ${VERIFY_WINDOW_SEC}s verify → B8 persistent observe timers in $UNIT_DIR"
  log "=== dry-run done (no changes)"; exit 0
fi

# B2 stop
T0ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ); echo "$T0ISO" > "$D/T0-stop-$RUN_ID"
docker stop -t 120 "$C" >> "$LOG" 2>&1; rc=$?; T0=$(date +%s)
running && die "B2 docker stop 후에도 실행 중(rc=$rc)" 20
docker logs --since "$T0ISO" "$C" 2>&1 | grep -o 'drain completed in [0-9]*ms' | tail -1 | sed 's/^/B2 /' | tee -a "$LOG" || true
log "B2 stopped rc=$rc"

# B3 fence release verification (read-only)
FS=$(fence_state); log "B3 fence: $FS"
case "$FS" in
  token=0*) E=${FS##*epoch=} ;;
  *) die "B3 fence token 잔존($FS) — fence정리승인 없음. 브로커 정지 상태로 오너 판단 대기" 21 ;;
esac

# B4 backup (shadow excluded; its size is recorded only)
BK="$DATA/backups/pre-phase7-rate-$(date -u +%Y%m%dT%H%M%SZ)"; mkdir -p -m 700 "$BK"; echo "$BK" > "$D/backup-path-$RUN_ID"
for f in "$STATE" "$STATE-wal" "$STATE-shm" "$FENCE" "$FENCE-wal" "$FENCE-shm" "$ENVF"; do [ -e "$f" ] && cp -p "$f" "$BK/"; done
ICS=$(node -e 'const {DatabaseSync}=require("node:sqlite");for(const p of process.argv.slice(1)){const d=new DatabaseSync(p,{readOnly:true});process.stdout.write(d.prepare("PRAGMA integrity_check").get().integrity_check+" ")}' "$BK/state.sqlite" "$BK/$(basename "$FENCE")" 2>/dev/null)
TASKS=$(node -e 'const {DatabaseSync}=require("node:sqlite");console.log(new DatabaseSync(process.argv[1],{readOnly:true}).prepare("SELECT COUNT(*) n FROM broker_tasks").get().n)' "$BK/state.sqlite" 2>/dev/null)
log "B4 backup $BK integrity=[$ICS] tasks=$TASKS shadow_size=$(stat -c %s "$SHADOW" 2>/dev/null || echo 0)"
if [ "$ICS" != "ok ok " ]; then
  log "B4 integrity failed — restarting unchanged (no config change made)"
  compose_up; wait_healthy 120 && readyz_ok && die "B4 백업 무결성 실패 → 변경 없이 재기동함" 22
  die "B4 백업 무결성 실패 + 무변경 재기동도 실패" 23
fi

# B5 shadow delete (approved) + RATE flag + drain
if lsof "$SHADOW" >/dev/null 2>&1; then die "B5 shadow 파일을 아직 연 프로세스가 있음" 24; fi
rm -f "$SHADOW" "$SHADOW-journal" "$SHADOW-wal" "$SHADOW-shm"; log "B5 shadow file deleted"
[ -n "$(tail -c1 "$ENVF")" ] && echo >> "$ENVF"
echo 'BROKER_SHARED_STATE_V1_RATE=on' >> "$ENVF"
log "B5 .env diff keys: +BROKER_SHARED_STATE_V1_RATE; draining until stop+${DRAIN_SEC}s"
while [ $(( $(date +%s) - T0 )) -lt "$DRAIN_SEC" ]; do sleep 10; done
log "B5 drain elapsed $(( $(date +%s) - T0 ))s"

# B6 start (same image, --no-build)
B6ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ); echo "$B6ISO" > "$D/B6-start-$RUN_ID"
compose_up
if ! wait_healthy 120; then
  if docker logs --since "$B6ISO" "$C" 2>&1 | grep -q ownership_conflict; then
    docker stop -t 120 "$C" >> "$LOG" 2>&1
    die "B6 ownership_conflict — 정지함. fence정리승인 필요" 25
  fi
  rollback "B6 기동 후 120초 내 healthy 아님"
fi
log "B6 healthy rev=$(docker inspect "$C" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' | cut -c1-8)"

# B7 verification
sleep 15
readyz_ok || rollback "B7 readyz 실패"
FS2=$(fence_state); [ "$FS2" = "token=1 epoch=$((E+1))" ] || rollback "B7 fence 기대값 token=1 epoch=$((E+1)) ≠ $FS2"
R1=$(rate_rows); log "B7 rate rows t0=$R1"
sleep "$VERIFY_WINDOW_SEC"
R2=$(rate_rows)
L=$(docker logs --since "$B6ISO" "$C" 2>&1)
CSU=$(printf '%s\n' "$L" | grep -c state_unavailable); COC=$(printf '%s\n' "$L" | grep -c ownership_conflict)
C503=$(printf '%s\n' "$L" | grep -c -- ' 503'); CBUSY=$(printf '%s\n' "$L" | grep -c SQLITE_BUSY)
log "B7 rate rows t+${VERIFY_WINDOW_SEC}s=$R2 state_unavailable=$CSU ownership_conflict=$COC 503=$C503 SQLITE_BUSY=$CBUSY"
{ [ "${R2:-0}" -gt "${R1:-0}" ] 2>/dev/null; } || rollback "B7 V1 rate 행이 증가하지 않음($R1→$R2)"
[ "$CSU$COC$C503$CBUSY" = 0000 ] || rollback "B7 로그 이상 state_unavailable=$CSU ownership_conflict=$COC 503=$C503 busy=$CBUSY"
readyz_ok || rollback "B7 최종 readyz 실패"
log "B7 pass $FS2"

# B8 observation: persistent one-shot timers (OnCalendar absolute time,
# Persistent=true — they survive a reboot and catch up right after boot).
write_observe_script
tfail=0
for h in 1 6 12 24; do
  at=$(date -d "@$(( $(date -d "$B6ISO" +%s) + h*3600 ))" '+%Y-%m-%d %H:%M:%S')
  if nx=$(schedule_persistent "$UNIT_PREFIX-observe-${h}h-${RUN_ID%%-*}" "$at" "P7-B B8 observation T+${h}h" "$OBS_SCRIPT" "T+${h}h"); then
    log "B8 timer T+${h}h at $at (persistent, next=$nx)"
  else
    tfail=$((tfail+1)); log "B8 timer T+${h}h FAILED: $nx"
  fi
done
"$OBS_SCRIPT" "T+5m" ; log "B8 T+5m: $(tail -1 "$D/observe.log")"
[ "$tfail" = 0 ] || notify "⚠️ #1504 P7-B B8 관측 타이머 ${tfail}개 생성 실패 — 수동 관측 필요(run-b.log 확인)"
notify "✅ #1504 P7-B 전환 완료 — rate V1 serving. $FS2, rate 행 ${R1}→${R2}, 5분 503/state_unavailable/ownership_conflict 0. 관측 타이머 T+1/6/12/24h(영구 유닛) 설정"
log "=== execute done"
exit 0
}

# Tests source this file with P7B_SOURCE_ONLY=1 to stub host probes, then call main.
[ "${P7B_SOURCE_ONLY:-0}" = 1 ] || main "$@"
