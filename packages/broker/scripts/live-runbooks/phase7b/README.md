# Shared-state Phase 7-B operator runbook scripts

Operator-run bash scripts for the shared-state Phase 7-B cutover (rate V1 serving)
on the team1 broker host, plus the result/B8 verdict collector that runs on a
separate collector node. Context: issue #1504 (shared-state/HA contract), #2369
(r2 plan), #2379 (r3 reboot hardening).

| File | Runs on | Purpose |
|---|---|---|
| `go.sh` | broker host | One-shot driver fired by an operator-installed timer at the approved window start: time guard → run-once marker → `run-b.sh reboot-hold` → dry-run → shadow window → `run-b.sh execute`. |
| `run-b.sh` | broker host | `dry-run` (B0/B1), `execute` (B0..B8 with approved rollback), `reboot-hold <h>`, `reboot-release`. Generates a per-run `observe-b-<run>.sh` for the B8 observations. |
| `collect-p7b.sh` | collector node | Read-only ssh capture; posts the execution result and the B8 pre-verdict to the issue. |
| `test-run-b.sh`, `test-collect-p7b.sh` | CI / anywhere | Hermetic suites (every host probe stubbed). Run by `scripts/live-runbook-p7b.test.mjs`. |

Nothing here runs by itself. Every broker-changing step (`execute`) and the
reboot hold need a fresh owner approval phrase, passed as `P7B_APPROVAL`.

## Why r3: never schedule with transient timers

During r2 (2026-10-12) the T+24h observation never ran:

1. unattended-upgrades had already scheduled `shutdown -r 03:15` at 06:22.
2. The reboot hold was set at 10:00. An apt hold
   (`Unattended-Upgrade::Automatic-Reboot "false"`) only stops *new*
   schedules, so the existing one fired anyway.
3. The B8 timers were `systemd-run` transient units. Those live in `/run` and
   vanish on reboot.
4. The hold-expiry timer was transient too, so the hold would have outlived its
   approval if it had not been removed by hand.

r3 rules:

- **Use persistent one-shot units for every deferred action.**
  - `schedule_persistent` writes `<unit>.service` and `<unit>.timer` under
    `/etc/systemd/system` (`OnCalendar=` absolute time written in UTC with an
    explicit `UTC` suffix, `Persistent=true`, `After=docker.service`), then runs
    `daemon-reload` and `enable --now`.
  - The service carries `Environment=` for `HOME` and `P7B_*` (a system service
    has no login environment). Its `ExecStopPost=` disables and stops its own
    timer, so it fires exactly once.
  - A missed elapse runs right after the next boot.
  - The unit files stay as evidence. The `Persistent=` stamp file
    `/var/lib/systemd/timers/stamp-<unit>.timer` records the trigger time; its
    mtime survives reboots, whereas `systemctl show` goes blank once a
    self-disabled one-shot is unloaded.
- **`reboot-hold` cancels what is already scheduled.**
  - It refuses when a hold is already present (50): one hold at a time.
  - It writes the hold first and schedules the persistent expiry. The expiry
    runs a plain `/bin/rm -f <hold>`, never a script from the checkout, so a
    checkout that moves within the hold cannot leave the hold in place.
  - It checks that `apt-config dump` now reports `Automatic-Reboot "false"`.
  - Only then does it run `shutdown -c` if `/run/systemd/shutdown/scheduled`
    exists, and re-checks.
  - Any failure releases the hold and aborts before a broker change:
    51 hold write, 52 expiry unit, 53 schedule survived the cancel, 54 hold not
    effective.
  - A pending `/var/run/reboot-required` is logged. That reboot is re-scheduled
    by unattended-upgrades after the hold expires.
- **B0 checks the effective policy, not the hold file.**
  - A pending scheduled shutdown is a FAIL in both modes.
  - `Automatic-Reboot "true"` is a WARN in `dry-run` and a FAIL in `execute`.
    The B8 window is at least 24h, so it always contains the daily reboot time.
- **Observations are per run and boot-safe.** Each run writes its own
  `observe-b-<run>.sh`, and each row carries `run=`. The collector judges only
  the newest run (its B6 tag), so a re-run in the same state directory does not
  mix rows. A catch-up right after boot waits for readyz (`P7B_OBS_WAIT`,
  default 300 s, then `P7B_OBS_SETTLE` 60 s) and records `waited_s=`.
- **Observation rows carry `boot=` and `broker_started=`.** The collector
  reports a restart inside the window (epoch change, host boot or broker start
  after B6) as a caveat: that run is "no violations after a restart", not a
  continuous 24h run. When the T+24h row is missing, the collector names the
  cause:
  - `observe_failed`: the unit triggered but wrote no row.
  - `timer_lost_reboot`: a boot inside the window, and no unit or no catch-up.
  - `not_due`: the timer is still pending.
  - `timer_not_fired`: none of the above.

## Run sequence (broker host)

```bash
cd <checkout>/packages/broker/scripts/live-runbooks/phase7b
# 1. rehearsal any time before the window: dry-run only, no hold, no marker
GO_PREFLIGHT=1 P7B_EXPECT_REV=<40-hex> ./go.sh
# 2. install the go timer (permanent unit; Persistent=false on purpose — a late
#    fire is refused by the time guard anyway). Example for a 10:00 KST window:
#      /etc/systemd/system/a2a-p7b-<tag>-go.service
#        [Service] Type=oneshot
#        Environment=P7B_TAG=<tag> P7B_EXPECT_REV=<40-hex> P7B_DIR=<state dir>
#        Environment="P7B_WINDOW_START=YYYY-MM-DD 10:00" "P7B_WINDOW_END=YYYY-MM-DD 11:00"
#        Environment="P7B_APPROVAL=<owner phrase>"
#        ExecStart=<checkout>/packages/broker/scripts/live-runbooks/phase7b/go.sh
#      /etc/systemd/system/a2a-p7b-<tag>-go.timer
#        [Timer] OnCalendar=YYYY-MM-DD 10:00:00 Asia/Seoul  Persistent=false
```

`go.sh` holds the reboot for `P7B_HOLD_HOURS` (default 26). That covers the
run, T+24h and margin.
- If the dry-run or the shadow check fails, or `execute` stops before a broker
  change (rc 2/11/12/13), `go.sh` releases the hold at once.
- Otherwise the hold stays until its persistent expiry timer removes it.

## Collector (collector node)

Install it with its own persistent timer after T+24h, for example
`p7b-collect@b8.timer` with `OnCalendar=<T+24h + 35 min> Asia/Seoul` and
`Persistent=true`. Set the remote location through the environment:

```bash
P7B_SSH_HOST=<broker-host-alias> P7B_REMOTE_DIR=<state dir on the broker host> \
P7B_REMOTE_BROKER_DIR=<checkout>/packages/broker ./collect-p7b.sh b8
COLLECT_DRY=1 ...   # print the comment instead of posting
```

## Tests

```bash
bash test-run-b.sh ./run-b.sh            # run-b.sh + go.sh ordering
bash test-collect-p7b.sh ./collect-p7b.sh
node --test ../../live-runbook-p7b.test.mjs   # from packages/broker/scripts/live-runbooks/phase7b
```
