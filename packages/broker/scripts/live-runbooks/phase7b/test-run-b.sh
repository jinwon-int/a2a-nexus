#!/bin/bash
# Regression tests for run-b.sh (a2a-nexus#2369 r2, #2379 r3). Hermetic: every
# host probe (docker, readyz, systemctl, shutdown, apt-config) is a shell-function
# stub; fixture SQLite files and a stub snapshot tool honouring the real tool's
# EXIT contract and `wx` write. Never touches a broker, systemd or apt.
# Usage: test-run-b.sh [path/to/run-b.sh]
set -u
SUT="$(readlink -f "${1:-$(dirname "$0")/run-b.sh}")"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "ok   - $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL - $1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; }

REV=7f23cd70e36abf942363dd367a39f7d123249935
BR="$T/broker"; mkdir -p "$BR/scripts" "$T/data" "$T/spool"
printf 'X=1\nBROKER_SHARED_STATE_V1_REPLAY=on\n' > "$BR/.env"
touch "$T/hold"
# stub snapshot tool: STUB_SNAP=pass|unexplained|noev|nopassline
cat > "$BR/scripts/shared-state-shadow-snapshot.mjs" <<'JS'
import fs from "node:fs";
const a = process.argv.slice(2); const out = a[a.indexOf("--out") + 1];
const mode = process.env.STUB_SNAP || "pass";
if (mode === "noev") { process.stderr.write("state-shadow-snapshot: /health read failed: ECONNREFUSED\n"); process.exit(3); }
try { fs.writeFileSync(out, "{}\n", { flag: "wx", mode: 0o600 }); }
catch (e) { process.stderr.write(`state-shadow-snapshot: cannot write ${out}: ${e.code}\n`); process.exit(3); }
process.stdout.write(`wrote ${out}\n`);
if (mode === "unexplained") { process.stderr.write("state-shadow-snapshot: FAIL replay unexplained=3\n"); process.exit(2); }
if (mode === "nopassline") { process.stderr.write("something else\n"); process.exit(0); }
process.stderr.write("state-shadow-snapshot: pass window=stub replay=1/1 unexplained=0 rate=1/1 unexplained=0\n"); process.exit(0);
JS
# fixture sqlite: state (broker_tasks, none in flight) + fence (token=1 epoch=22)
node -e '
const {DatabaseSync}=require("node:sqlite");
const s=new DatabaseSync(process.argv[1]); s.exec("CREATE TABLE broker_tasks(id TEXT, status TEXT); INSERT INTO broker_tasks VALUES(\x27a\x27,\x27succeeded\x27)");
const f=new DatabaseSync(process.argv[2]); f.exec("CREATE TABLE shared_state_ownership(id INTEGER, owner_token TEXT, lifecycle_epoch INTEGER); INSERT INTO shared_state_ownership VALUES(1,\x27t\x27,22); CREATE TABLE shared_state_rate_cost(namespace TEXT NOT NULL, bucket_key_digest TEXT NOT NULL, event_at_unix_ms TEXT NOT NULL, cost INTEGER NOT NULL, entry_ordinal INTEGER NOT NULL, PRIMARY KEY (namespace, bucket_key_digest, entry_ordinal)) STRICT"); const now=Date.now(), ins=f.prepare("INSERT INTO shared_state_rate_cost VALUES(\x27g\x27,\x27b\x27,?,1,?)"); [now-7200000,now-7100000,now-300000,now-200000,now-100000].forEach((t,i)=>ins.run(String(t),i));
' "$T/data/state.sqlite" "$T/data/fence.sqlite" 2>/dev/null || { echo "fixture creation failed"; exit 2; }

# Host stubs shared by every sourced run (#2379 additions: systemctl, shutdown,
# apt-config view, scheduled-shutdown / reboot-required paths, unit dir).
#   STUB_APT        apt_auto_reboot answer while no hold file exists (default "false unset")
#   STUB_APT_STUCK  answer even when the hold file exists (simulates an overriding later file)
#   STUB_SCHED      path of the scheduled-shutdown file (default: absent)
#   STUB_CANCEL_OK  shutdown -c removes the scheduled file
#   STUB_ENABLE_FAIL / STUB_NEXT  systemctl enable failure / NextElapse answer
# shellcheck disable=SC2016
STUBS='
    STATE="$T/data/state.sqlite"; FENCE="$T/data/fence.sqlite"; SHADOW="$T/data/shadow.sqlite"
    REBOOT_HOLD="${STUB_HOLD:-$T/hold}"
    SHUTDOWN_SCHEDULED="${STUB_SCHED:-$T/nosched}"; REBOOT_REQUIRED="${STUB_RR:-$T/norr}"
    mkdir -p "$UNIT_DIR"; SYSLOG="$T/sys.$NAME"
    apt_auto_reboot() { if [ -n "${STUB_APT_STUCK:-}" ]; then echo "$STUB_APT_STUCK"
      elif [ -f "$REBOOT_HOLD" ]; then echo "false 03:15"; else echo "${STUB_APT:-false unset}"; fi; }
    systemctl() { echo "systemctl $*" >> "$SYSLOG"; case "$1" in
        show) echo "${STUB_NEXT-Wed 2026-10-14 10:00:00 KST}" ;;
        enable) [ -z "${STUB_ENABLE_FAIL:-}" ] ;;
      esac; }
    shutdown() { echo "shutdown $*" >> "$SYSLOG"; [ -n "${STUB_CANCEL_OK:-}" ] && rm -f "$SHUTDOWN_SCHEDULED"; return 0; }
    logger() { :; }
    docker() { case "$1" in
        ps) echo a2a-broker ;;
        inspect) case "$*" in *revision*) echo "${STUB_REV:-}" ;; *Env*) echo "EDGE_SECRET=stub" ;; *) echo false ;; esac ;;
        exec) echo pass ;;
        *) echo "STUB docker $*" >> "$T/docker-mutations"; return 99 ;;   # stop/compose etc. never real
      esac; }
    systemd-run() { echo "STUB systemd-run $*" >> "$T/docker-mutations"; }
    readyz_ok() { return 0; }
'
# run <name> <mode-and-args> [VAR=val ...] — runs main in a fresh bash (fresh $$ → fresh RUN_ID)
run() {
  local name=$1 args=$2; shift 2
  env "$@" P7B_SOURCE_ONLY=1 P7B_DIR="$T/d" P7B_BROKER_DIR="$BR" P7B_SPOOL="$T/spool" P7B_UNIT_DIR="$T/units/$name" \
    SUT="$SUT" T="$T" NAME="$name" ARGS="$args" STUBS="$STUBS" bash -c '
    set -- $ARGS; source "$SUT"; eval "$STUBS"; main "$@"' > "$T/out.$name" 2>&1
  echo $? > "$T/rc.$name"
}
# fn <name> <function> [args...] — sources the SUT with stubs and calls one function
fn() {
  local name=$1; shift
  env ${FN_ENV:-} P7B_SOURCE_ONLY=1 P7B_DIR="$T/d" P7B_BROKER_DIR="$BR" P7B_SPOOL="$T/spool" P7B_UNIT_DIR="$T/units/$name" \
    SUT="$SUT" T="$T" NAME="$name" STUBS="$STUBS" bash -c '
    CALL=("$@"); set -- dry-run; source "$SUT"; eval "$STUBS"; "${CALL[@]}"' _ "$@" > "$T/out.$name" 2>&1
  echo $? > "$T/rc.$name"
}
rc()  { cat "$T/rc.$1"; }
has() { grep -q -- "$2" "$T/out.$1"; }
expect() { # <name> <rc> <pattern> <desc>
  if [ "$(rc "$1")" = "$2" ] && has "$1" "$3"; then ok "$4"; else bad "$4" "rc=$(rc "$1") want $2 / pattern '$3' :: $(tail -2 "$T/out.$1" | tr '\n' ' ')"; fi; }
WS="P7B_WINDOW_START=$(TZ=Asia/Seoul date -d '-10 min' '+%F %H:%M')"; WE="P7B_WINDOW_END=$(TZ=Asia/Seoul date -d '+50 min' '+%F %H:%M')"

# 1. usage gates
run usage1 bogus STUB_REV=$REV P7B_EXPECT_REV=$REV;   expect usage1 64 "usage" "unknown mode → 64"
run usage2 dry-run STUB_REV=$REV;                      expect usage2 64 "P7B_EXPECT_REV" "missing EXPECT_REV → 64"
run usage3 dry-run STUB_REV=$REV P7B_EXPECT_REV=7f23cd70; expect usage3 64 "40-hex" "short EXPECT_REV → 64"

# 2. dry-run pass, twice in a row (r1 bug: second run hit EEXIST)
run dry1 dry-run STUB_REV=$REV P7B_EXPECT_REV=$REV;   expect dry1 0 "dry-run done" "dry-run #1 passes B0/B1"
run dry2 dry-run STUB_REV=$REV P7B_EXPECT_REV=$REV;   expect dry2 0 "dry-run done" "dry-run #2 right after #1 passes (per-run evidence file)"
n=$(ls "$T/d"/shadow-B1-prestop-*-dry-run-*.json 2>/dev/null | wc -l)
[ "$n" = 2 ] && ok "two distinct B1 evidence files kept" || bad "two distinct B1 evidence files kept" "found $n"
has dry1 "reboot_hold=present" && ok "B0 reports reboot_hold=present" || bad "B0 reports reboot_hold=present"

# 3. r1 reproduction: dry-run then execute in window → B1 passes; stops at stubbed B3 (no real mutation)
run exec1 execute STUB_REV=$REV P7B_EXPECT_REV=$REV P7B_APPROVAL=test "$WS" "$WE"
if has exec1 "B1 pass" && [ "$(rc exec1)" != 13 ] && [ "$(rc exec1)" != 12 ]; then ok "execute after dry-run passes B1 (r1 EEXIST fixed); stopped later at rc=$(rc exec1)"; else bad "execute after dry-run passes B1" "$(tail -3 "$T/out.exec1" | tr '\n' ' ')"; fi
grep -q "STUB docker stop" "$T/docker-mutations" 2>/dev/null && ok "post-B1 path only reached stubbed docker (no host mutation)" || bad "post-B1 path reached stub" "no stub stop recorded"

# 4. B1 outcome mapping
run un dry-run STUB_REV=$REV P7B_EXPECT_REV=$REV STUB_SNAP=unexplained; expect un 12 "B1 shadow 불합격(unexplained≠0)" "unexplained (tool rc 2) → 12 불합격"
run ne dry-run STUB_REV=$REV P7B_EXPECT_REV=$REV STUB_SNAP=noev;        expect ne 13 "도구 오류/증거 없음" "no evidence (tool rc 3) → 13 도구 오류"
run np dry-run STUB_REV=$REV P7B_EXPECT_REV=$REV STUB_SNAP=nopassline;  expect np 13 "도구 오류/증거 없음" "rc 0 without pass line → 13"

# 5. existing evidence file is never overwritten
echo keep > "$T/existing.json"
P7B_SOURCE_ONLY=1 P7B_DIR="$T/d" P7B_BROKER_DIR="$BR" P7B_SPOOL="$T/spool" bash -c '
  set -- dry-run; source "'"$SUT"'"; edge_secret(){ :; }; shadow_snapshot X "'"$T"'/existing.json"; echo "rc=$?"' > "$T/out.exist" 2>&1
if grep -q "rc=3" "$T/out.exist" && [ "$(cat "$T/existing.json")" = keep ]; then ok "pre-existing evidence → refused (3), file untouched"; else bad "pre-existing evidence refused" "$(cat "$T/out.exist")"; fi

# 6. B0 revision mismatch
run rev dry-run STUB_REV=4417b6d7e12949b50d07ff43189858c49d0a591b P7B_EXPECT_REV=$REV; expect rev 11 "image revision 4417b6d7" "running rev ≠ EXPECT_REV → B0 11"

# 7. reboot hold: dry-run WARN, execute refuses
run h1 dry-run STUB_REV=$REV P7B_EXPECT_REV=$REV STUB_HOLD=$T/nohold; expect h1 0 "reboot_hold=ABSENT" "dry-run without reboot hold → WARN, still 0"
run h2 execute STUB_REV=$REV P7B_EXPECT_REV=$REV STUB_HOLD=$T/nohold P7B_APPROVAL=test "$WS" "$WE"; expect h2 11 "reboot hold file missing" "execute without reboot hold → B0 11"

# 8. approval window gates (all must refuse with 2 before B0)
run w0 execute STUB_REV=$REV P7B_EXPECT_REV=$REV;  expect w0 2 "미지정" "execute without window → 2"
run w1 execute STUB_REV=$REV P7B_EXPECT_REV=$REV P7B_APPROVAL=x "P7B_WINDOW_START=2026-10-09 21:59" "P7B_WINDOW_END=2026-10-09 23:00"; expect w1 2 "밖" "r1's expired window → 2"
run w2 execute STUB_REV=$REV P7B_EXPECT_REV=$REV P7B_APPROVAL=x "P7B_WINDOW_START=$(TZ=Asia/Seoul date -d '-1 hour' '+%F %H:%M')" "P7B_WINDOW_END=$(TZ=Asia/Seoul date -d '+3 hour' '+%F %H:%M')"; expect w2 2 "상한" "window > 3h → 2"
run w3 execute STUB_REV=$REV P7B_EXPECT_REV=$REV P7B_APPROVAL=x "P7B_WINDOW_START=2026-10-12 22:00 KST" "P7B_WINDOW_END=2026-10-12 23:00"; expect w3 2 "형식" "malformed window → 2"
run w4 execute STUB_REV=$REV P7B_EXPECT_REV=$REV "$WS" "$WE"; expect w4 2 "P7B_APPROVAL" "missing approval phrase → 2"
run w5 execute STUB_REV=$REV P7B_EXPECT_REV=$REV P7B_APPROVAL=x "P7B_WINDOW_START=2026-10-12 23:00" "P7B_WINDOW_END=2026-10-12 22:00"; expect w5 2 "이르거나" "end ≤ start → 2"
wb=0; for w in w0 w1 w2 w3 w4 w5; do has $w "B0 pass" && wb=1; done
[ "$wb" = 0 ] && ok "window refusals happen before B0" || bad "window refusals happen before B0" "B0 ran"

# 9. B8 observation script (r2 metrics + r3 boot/broker_started) against the fixture: 2 rows before B6, 3 after
mkdir -p "$T/bin"
cat > "$T/bin/docker" <<'SH'
#!/bin/bash
case "$1" in
  inspect) case "$*" in *StartedAt*) echo "2026-10-12T18:15:37.524797998Z" ;; *) echo "EDGE_SECRET=stub" ;; esac ;;
  logs) printf '%s\n' "x" "[a2a-broker] shared-state V1 runtime prune: failed (lost_fence)" "[a2a-broker] shared-state V1 runtime prune: skipped (adapter_not_ready)" "[a2a-broker] shared-state V1 runtime prune: recovered (was failed:lost_fence)" "[a2a-broker] shared-state V1 runtime prune: 60 runs deleted nonce=3 rateCost=2" ;;
  *) echo "STUB docker $*" >> "$T_MUT"; exit 99 ;;
esac
SH
printf '#!/bin/bash\necho "{\\"ready\\":true}"\n' > "$T/bin/curl"; chmod +x "$T/bin/docker" "$T/bin/curl"
P7B_SOURCE_ONLY=1 P7B_DIR="$T/d8" P7B_BROKER_DIR="$BR" P7B_SPOOL="$T/spool" T="$T" SUT="$SUT" bash -c '
  set -- execute; source "$SUT"; FENCE="$T/data/fence.sqlite"
  B6ISO=$(date -u -d "-10 min" +%Y-%m-%dT%H:%M:%SZ); write_observe_script' > "$T/out.b8gen" 2>&1
OBS8=$(ls "$T/d8"/observe-b-*.sh 2>/dev/null | head -1)
T_MUT="$T/docker-mutations" PATH="$T/bin:$PATH" "${OBS8:-$T/d8/missing}" T+test > "$T/out.b8run" 2>&1
L8=$(tail -1 "$T/d8/observe.log" 2>/dev/null)
chk() { if printf '%s\n' "$L8" | grep -qE -- "$1"; then ok "B8: $2"; else bad "B8: $2" "line: $L8 $(cat "$T/out.b8gen" "$T/out.b8run")"; fi; }
chk "rate_rows=5( |$)"            "total rate_rows kept (5)"
chk "rate_since_b6=3( |$)"        "rate_since_b6 counts only rows at/after B6 (3)"
chk "newest_rate_age_s=(9[0-9]|1[0-3][0-9])( |$)" "newest_rate_age_s ≈ 100s"
chk "prune_fail=2( |$)"           "prune failed|skipped counted (2), recovered/summary not"
chk "prune_lost_fence=2( |$)"     "lost_fence mentions counted (failed + recovered-from)"
chk " 503=0 "                      "prune summary line does not trip the 503 grep"
chk "snapshot_rc=0 "              "B8 snapshot evidence written"
chk " boot=[0-9]{8}T[0-9]{6}Z( |$)" "r3: host boot time recorded (UTC)"
chk " broker_started=20261012T181537Z( |$)" "r3: broker container start recorded (UTC)"
# docker prints nothing (container missing) → broker_started=unknown, not "today 00:00Z"
mkdir -p "$T/bin2"; printf '#!/bin/bash\ncase "$1" in inspect) exit 0 ;; logs) exit 0 ;; esac\nexit 99\n' > "$T/bin2/docker"
chmod +x "$T/bin2/docker"
T_MUT="$T/docker-mutations" PATH="$T/bin2:$T/bin:$PATH" "$OBS8" T+nodocker > "$T/out.b8nd" 2>&1
chk0=$(tail -1 "$T/d8/observe.log" 2>/dev/null)
printf '%s\n' "$chk0" | grep -q "label=T+nodocker .* broker_started=unknown " && ok "r3: missing container → broker_started=unknown (no false restart)" || bad "r3: broker_started unknown" "$chk0"
chk " run=[0-9]{8}T[0-9]{6} waited_s=0$" "r3: row carries the run tag and waited_s (readyz already up → 0)"
[ -n "$OBS8" ] && [ "$(basename "$OBS8")" != observe-b.sh ] && ok "r3: observe script is per run (observe-b-<tag>.sh)" || bad "r3: per-run observe script" "$(ls "$T/d8")"
grep -q 'P7B_OBS_WAIT:-300' "$OBS8" && grep -q 'readyz' "$OBS8" && ok "r3: observation waits for readyz before measuring (boot catch-up)" || bad "r3: readyz wait in observe script"
# a catch-up right after boot: readyz down for the first two polls → waits, then measures
printf '#!/bin/bash\nn=$(cat "$T/curl.n" 2>/dev/null || echo 0); echo $((n+1)) > "$T/curl.n"\n[ "$n" -ge 2 ] && echo "{\\"ready\\":true}"\nexit 0\n' > "$T/bin/curl"; rm -f "$T/curl.n"
mkdir -p "$T/bin2"; printf '#!/bin/bash\nexit 0\n' > "$T/bin2/sleep"; chmod +x "$T/bin/curl" "$T/bin2/sleep"
T="$T" T_MUT="$T/docker-mutations" PATH="$T/bin2:$T/bin:$PATH" "$OBS8" T+late > "$T/out.b8late" 2>&1
L8=$(tail -1 "$T/d8/observe.log" 2>/dev/null)
chk "label=T\+late .* waited_s=20$" "r3: boot catch-up waited for readyz (2 polls → waited_s=20) before the row"

# ---- r3 (#2379) -------------------------------------------------------------
SCHED="$T/sched"; mksched() { printf 'USEC=%s\nWARN_WALL=1\nMODE=reboot\n' "$(( ($(date +%s) + 3600) * 1000000 ))" > "$SCHED"; }

# 10. B0 reboot checks
mksched
run rb1 dry-run STUB_REV=$REV P7B_EXPECT_REV=$REV STUB_SCHED="$SCHED"; expect rb1 11 "scheduled reboot@" "pending scheduled reboot → B0 FAIL 11 (dry-run too)"
run rb2 dry-run STUB_REV=$REV P7B_EXPECT_REV=$REV STUB_HOLD=$T/nohold STUB_APT="true 03:15"; expect rb2 0 "auto_reboot=true@03:15(WARN" "dry-run with auto-reboot on and no hold → WARN, 0"
run rb3 execute STUB_REV=$REV P7B_EXPECT_REV=$REV P7B_APPROVAL=test "$WS" "$WE" STUB_APT_STUCK="true 03:15"; expect rb3 11 "Automatic-Reboot effective=true" "execute: hold file present but auto-reboot still effective → B0 11"
touch "$T/rr"
run rb4 dry-run STUB_REV=$REV P7B_EXPECT_REV=$REV STUB_RR="$T/rr"; expect rb4 0 "reboot_required=yes" "reboot-required is reported in the B0 line"
has rb4 "auto_reboot=false" && ok "hold present → auto_reboot=false reported" || bad "hold present → auto_reboot=false reported" "$(grep 'B0 pass' "$T/out.rb4")"

# 11. schedule_persistent
AT=$(date -d '+2 hours' '+%Y-%m-%d %H:%M:%S')
fn sp1 schedule_persistent a2a-p7b-observe-24h-test "$AT" "P7-B B8 observation T+24h" "$T/d/observe-b.sh" "T+24h"
U="$T/units/sp1/a2a-p7b-observe-24h-test"
ATU="$(date -u -d "@$(date -d "$AT" +%s)" '+%Y-%m-%d %H:%M:%S') UTC"
if [ "$(rc sp1)" = 0 ] && grep -qx "OnCalendar=$ATU" "$U.timer" && grep -qx "Persistent=true" "$U.timer" && grep -qx "WantedBy=timers.target" "$U.timer"; then
  ok "persistent timer written (OnCalendar absolute UTC, Persistent=true, WantedBy timers.target)"; else bad "persistent timer written" "$(cat "$T/out.sp1" "$U.timer" 2>&1)"; fi
grep -qx "ExecStart=$T/d/observe-b.sh T+24h" "$U.service" && grep -qx "ExecStopPost=-/bin/systemctl disable --now a2a-p7b-observe-24h-test.timer" "$U.service" \
  && ok "service runs the command once and disables its own timer" || bad "service ExecStart/ExecStopPost" "$(cat "$U.service")"
grep -qx "After=docker.service network-online.target" "$U.service" && ok "service orders after docker (boot catch-up)" || bad "service After=docker" "$(cat "$U.service")"
grep -qx "Environment=P7B_DIR=$T/d" "$U.service" && grep -q "^Environment=HOME=" "$U.service" && ok "service carries P7B_DIR/HOME (no login env under systemd)" || bad "service Environment" "$(cat "$U.service")"
grep -q "systemctl enable --now a2a-p7b-observe-24h-test.timer" "$T/sys.sp1" && grep -q "systemctl daemon-reload" "$T/sys.sp1" && has sp1 "Wed 2026-10-14" \
  && ok "daemon-reload + enable --now, prints next elapse" || bad "enable sequence" "$(cat "$T/sys.sp1" "$T/out.sp1")"
fn sp2 schedule_persistent a2a-p7b-x "$(date -d '-1 hour' '+%Y-%m-%d %H:%M:%S')" "x" /bin/true; expect sp2 1 "not in the future" "past OnCalendar refused"
fn sp3 schedule_persistent a2a-p7b-x "$AT" "x" /bin/sh -c "rm -rf /"; expect sp3 1 "unsafe ExecStart" "ExecStart arg with spaces refused"
fn sp4 schedule_persistent a2a-p7b-x "$AT" "x" /bin/echo '100%'; expect sp4 1 "unsafe ExecStart" "ExecStart arg with % specifier refused"
mkdir -p "$T/units/sp5"; echo keep > "$T/units/sp5/a2a-p7b-x.timer"
fn sp5 schedule_persistent a2a-p7b-x "$AT" "x" /bin/true
if [ "$(rc sp5)" = 1 ] && has sp5 "never overwritten" && [ "$(cat "$T/units/sp5/a2a-p7b-x.timer")" = keep ]; then ok "existing unit never overwritten"; else bad "existing unit never overwritten" "$(cat "$T/out.sp5")"; fi
FN_ENV="STUB_ENABLE_FAIL=1" fn sp6 schedule_persistent a2a-p7b-x "$AT" "x" /bin/true
if [ "$(rc sp6)" = 1 ] && has sp6 "units removed" && [ ! -e "$T/units/sp6/a2a-p7b-x.timer" ]; then ok "enable failure → units removed, rc 1"; else bad "enable failure cleanup" "$(cat "$T/out.sp6")"; ls "$T/units/sp6"; fi
FN_ENV="STUB_NEXT=" fn sp7 schedule_persistent a2a-p7b-x "$AT" "x" /bin/true
if [ "$(rc sp7)" = 1 ] && has sp7 "no next elapse" && [ ! -e "$T/units/sp7/a2a-p7b-x.timer" ] && grep -q "systemctl disable --now a2a-p7b-x.timer" "$T/sys.sp7"; then
  ok "enabled timer without a next elapse → disabled, units removed, rc 1"; else bad "no next elapse cleanup" "$(cat "$T/out.sp7")"; fi

# 12. reboot-hold / reboot-release
run rh0 "reboot-hold" P7B_APPROVAL=x; expect rh0 64 "reboot-hold <hours" "reboot-hold without hours → 64"
run rh0b "reboot-hold 26"; expect rh0b 64 "P7B_APPROVAL" "reboot-hold without approval phrase → 64"
run rh1 "reboot-hold 26" P7B_APPROVAL=test STUB_HOLD="$T/hold-rh1"
if [ "$(rc rh1)" = 0 ] && grep -qx 'Unattended-Upgrade::Automatic-Reboot "false";' "$T/hold-rh1" && grep -q "approval: test" "$T/hold-rh1"; then ok "reboot-hold writes the apt hold with the approval phrase"; else bad "reboot-hold writes hold" "$(tail -3 "$T/out.rh1")"; fi
E1=$(ls "$T/units/rh1"/a2a-p7b-hold-expire-*.service 2>/dev/null | head -1)
[ -n "$E1" ] && grep -qx "ExecStart=/bin/rm -f $T/hold-rh1" "$E1" && grep -qx "Persistent=true" "${E1%.service}.timer" \
  && ok "hold expiry is a persistent timer running a plain '/bin/rm -f <hold>' (no checkout dependency)" || bad "hold expiry unit" "$(ls "$T/units/rh1" 2>&1; cat "$E1" 2>&1)"
if grep -q "^shutdown" "$T/sys.rh1" 2>/dev/null; then bad "no pending reboot → shutdown -c not called"; else ok "no pending reboot → shutdown -c not called"; fi
touch "$T/hold-rh6"
run rh6 "reboot-hold 26" P7B_APPROVAL=test STUB_HOLD="$T/hold-rh6"; expect rh6 50 "already present" "a hold already present → 50 (no overlapping holds)"
run rh7 "reboot-hold 26" "P7B_APPROVAL=line1
line2" STUB_HOLD="$T/hold-rh7"
if [ "$(rc rh7)" = 64 ] && [ ! -e "$T/hold-rh7" ]; then ok "multi-line approval phrase → 64, no hold written"; else bad "multi-line approval → 64" "rc=$(rc rh7)"; fi
mksched
run rh2 "reboot-hold 26" P7B_APPROVAL=test STUB_HOLD="$T/hold-rh2" STUB_SCHED="$SCHED" STUB_CANCEL_OK=1 STUB_RR="$T/rr"
if [ "$(rc rh2)" = 0 ] && grep -q "shutdown -c" "$T/sys.rh2" && has rh2 "scheduled reboot cancelled" && [ ! -e "$SCHED" ] && [ -e "$T/hold-rh2" ]; then
  ok "already-scheduled reboot → shutdown -c, hold kept, rc 0"; else bad "scheduled reboot cancelled" "$(tail -4 "$T/out.rh2")"; fi
has rh2 "reboot-required present" && ok "reboot-required pending is logged" || bad "reboot-required pending is logged"
mksched
run rh3 "reboot-hold 26" P7B_APPROVAL=test STUB_HOLD="$T/hold-rh3" STUB_SCHED="$SCHED"
if [ "$(rc rh3)" = 53 ] && has rh3 "예약된 재부팅 취소 실패" && [ ! -e "$T/hold-rh3" ] && grep -q "systemctl disable --now a2a-p7b-hold-expire-" "$T/sys.rh3"; then
  ok "schedule survives shutdown -c → 53, hold + expiry timer released"; else bad "uncancellable schedule → 53" "rc=$(rc rh3) $(tail -3 "$T/out.rh3")"; fi
rm -f "$SCHED"
run rh4 "reboot-hold 26" P7B_APPROVAL=test STUB_HOLD="$T/hold-rh4" STUB_APT_STUCK="true 03:15"
if [ "$(rc rh4)" = 54 ] && [ ! -e "$T/hold-rh4" ]; then ok "hold not effective in apt-config → 54, hold removed"; else bad "hold not effective → 54" "rc=$(rc rh4) $(tail -2 "$T/out.rh4")"; fi
run rh5 "reboot-hold 26" P7B_APPROVAL=test STUB_HOLD="$T/hold-rh5" STUB_ENABLE_FAIL=1
if [ "$(rc rh5)" = 52 ] && [ ! -e "$T/hold-rh5" ]; then ok "expiry timer cannot be created → 52, hold removed (never an unbounded hold)"; else bad "expiry failure → 52" "rc=$(rc rh5) $(tail -2 "$T/out.rh5")"; fi
# release cannot remove the hold → rc 1, expiry timers kept (they are the only remaining remover)
mkdir -p "$T/ro-hold"; touch "$T/ro-hold/hold"; mkdir -p "$T/units/relf"; touch "$T/units/relf/a2a-p7b-hold-expire-20261012T100003.timer"
P7B_SOURCE_ONLY=1 P7B_DIR="$T/d" P7B_BROKER_DIR="$BR" P7B_SPOOL="$T/spool" P7B_UNIT_DIR="$T/units/relf" SUT="$SUT" T="$T" NAME=relf STUBS="$STUBS" STUB_HOLD="$T/ro-hold/hold" bash -c '
  set -- reboot-release; source "$SUT"; eval "$STUBS"; rm() { :; }; main reboot-release' > "$T/out.relf" 2>&1; echo $? > "$T/rc.relf"
if [ "$(rc relf)" = 1 ] && has relf "NOT released" && ! grep -q "disable --now a2a-p7b-hold-expire" "$T/sys.relf" 2>/dev/null; then
  ok "release that cannot remove the hold → rc 1, expiry timers kept"; else bad "release failure keeps timers" "rc=$(rc relf) $(cat "$T/out.relf")"; fi
touch "$T/hold-rel"; mkdir -p "$T/units/rel"; touch "$T/units/rel/a2a-p7b-hold-expire-20261012T100003.timer"
run rel reboot-release STUB_HOLD="$T/hold-rel"
if [ "$(rc rel)" = 0 ] && [ ! -e "$T/hold-rel" ] && grep -q "systemctl disable --now a2a-p7b-hold-expire-20261012T100003.timer" "$T/sys.rel"; then
  ok "reboot-release removes the hold and disables hold-expiry timers"; else bad "reboot-release" "$(cat "$T/out.rel")"; fi

# 13. no transient timers left anywhere in the driver (they vanish on reboot)
if grep -nE '^[^#]*\bsystemd-run\b' "$SUT" >/dev/null; then bad "no systemd-run invocation in run-b.sh" "$(grep -nE '^[^#]*\bsystemd-run\b' "$SUT")"; else ok "no systemd-run invocation in run-b.sh"; fi
grep -q 'schedule_persistent "$UNIT_PREFIX-observe-' "$SUT" && ok "B8 observations use schedule_persistent" || bad "B8 observations use schedule_persistent"

# 14. go.sh ordering (#2379): hold (with pending-reboot cancel) BEFORE the dry-run;
#     a dry-run/shadow failure after the hold releases it; preflight never holds.
GO="$(dirname "$SUT")/go.sh"
cat > "$T/runb-stub" <<'SH'
#!/bin/bash
echo "$*" >> "$STUB_CALLS"
case "$1" in
  reboot-hold) exit "${STUB_HOLD_RC:-0}" ;;
  reboot-release) exit 0 ;;
  dry-run) echo "B0 pass: ok"; echo "shadow snapshot B1-prestop rc=0 state-shadow-snapshot: pass window=x+${STUB_SHADOW_H:-30.0}h"; echo "dry-run done"; exit "${STUB_DRY_RC:-0}" ;;
  execute) exit "${STUB_EXEC_RC:-0}" ;;
esac
SH
chmod +x "$T/runb-stub"
gorun() { # <name> [VAR=val ...]
  local name=$1; shift
  env P7B_RUNB="$T/runb-stub" P7B_DIR="$T/go-$name" P7B_SPOOL="$T/spool" P7B_TAG=t STUB_CALLS="$T/calls.$name" \
    P7B_EXPECT_REV=$REV "P7B_WINDOW_START=$(TZ=Asia/Seoul date -d '-5 min' '+%F %H:%M')" "P7B_WINDOW_END=$(TZ=Asia/Seoul date -d '+55 min' '+%F %H:%M')" \
    P7B_APPROVAL=test "$@" bash "$GO" > "$T/out.go-$name" 2>&1; echo $? > "$T/rc.go-$name"; touch "$T/calls.$name"; }
calls() { tr '\n' ',' < "$T/calls.$1" | sed 's/,$//'; }
gorun ok1
[ "$(cat "$T/rc.go-ok1")" = 0 ] && [ "$(calls ok1)" = "reboot-hold 26,dry-run,execute" ] && ok "go: reboot-hold 26 → dry-run → execute, in that order" || bad "go order" "rc=$(cat "$T/rc.go-ok1") calls=$(calls ok1)"
gorun hold STUB_HOLD_RC=53
[ "$(cat "$T/rc.go-hold")" = 9 ] && [ "$(calls hold)" = "reboot-hold 26" ] && ok "go: reboot-hold failure → 9, nothing else runs" || bad "go hold failure" "rc=$(cat "$T/rc.go-hold") calls=$(calls hold)"
gorun dry STUB_DRY_RC=11
[ "$(cat "$T/rc.go-dry")" = 7 ] && [ "$(calls dry)" = "reboot-hold 26,dry-run,reboot-release" ] && ok "go: dry-run failure after hold → 7 and the hold is released" || bad "go dry failure release" "rc=$(cat "$T/rc.go-dry") calls=$(calls dry)"
gorun shw STUB_SHADOW_H=4.3
[ "$(cat "$T/rc.go-shw")" = 8 ] && [ "$(calls shw)" = "reboot-hold 26,dry-run,reboot-release" ] && ok "go: shadow window < 24h → 8 and the hold is released" || bad "go shadow release" "rc=$(cat "$T/rc.go-shw") calls=$(calls shw)"
gorun pre GO_PREFLIGHT=1
[ "$(cat "$T/rc.go-pre")" = 0 ] && [ "$(calls pre)" = "dry-run" ] && ok "go: GO_PREFLIGHT runs only the dry-run (no hold, no execute)" || bad "go preflight" "rc=$(cat "$T/rc.go-pre") calls=$(calls pre)"
gorun late "P7B_WINDOW_START=$(TZ=Asia/Seoul date -d '-45 min' '+%F %H:%M')"
[ "$(cat "$T/rc.go-late")" = 5 ] && [ "$(calls late)" = "" ] && ok "go: fired past the guard → 5, nothing runs" || bad "go time guard" "rc=$(cat "$T/rc.go-late") calls=$(calls late)"
gorun twice; gorun twice
[ "$(cat "$T/rc.go-twice")" = 6 ] && ok "go: run-once marker → second fire 6" || bad "go marker" "rc=$(cat "$T/rc.go-twice")"
gorun ex11 STUB_EXEC_RC=11
[ "$(cat "$T/rc.go-ex11")" = 11 ] && [ "$(calls ex11)" = "reboot-hold 26,dry-run,execute,reboot-release" ] && ok "go: execute stops before a broker change (11) → hold released" || bad "go execute 11 release" "rc=$(cat "$T/rc.go-ex11") calls=$(calls ex11)"
gorun ex40 STUB_EXEC_RC=40
[ "$(cat "$T/rc.go-ex40")" = 40 ] && [ "$(calls ex40)" = "reboot-hold 26,dry-run,execute" ] && ok "go: rollback (40) keeps the hold until its expiry" || bad "go execute 40 keeps hold" "rc=$(cat "$T/rc.go-ex40") calls=$(calls ex40)"
gorun hh P7B_HOLD_HOURS=30
grep -qx "reboot-hold 30" "$T/calls.hh" && ok "go: P7B_HOLD_HOURS is passed to reboot-hold" || bad "go hold hours" "$(calls hh)"

echo "---- $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
