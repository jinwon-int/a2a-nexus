# Trusted-operator Docker runner hardening

Trusted-operator mode is for OpenClaw/Hermes/Claude patch lanes that need host credentials or side-effect capability. It is still more privileged than the public safe-default mode, so defaults are conservative.

## Defaults

With `A2A_DOCKER_RUNNER_TRUSTED_OPERATOR=1` and an OpenClaw/Hermes/Claude profile:

- `--network bridge` by default. Host networking requires `A2A_DOCKER_RUNNER_NETWORK=host`.
- `--read-only` root filesystem by default, plus a bounded writable `/tmp` tmpfs.
- `--user 1000:1000` by default. Root requires `A2A_DOCKER_RUNNER_USER=root` or `A2A_DOCKER_RUNNER_USER=0`.
- `--cap-drop ALL` by default (#2256 A1). Needed capabilities are re-added with `A2A_DOCKER_RUNNER_CAP_ADD`; `A2A_DOCKER_RUNNER_CAP_DROP=none` keeps the engine's default capability set.
- `--security-opt no-new-privileges` remains default unless `A2A_DOCKER_RUNNER_ALLOW_PRIVILEGE_ESCALATION=1` is set.

The read-only rootfs, non-root user, and `--cap-drop ALL` defaults are the
same in public safe-default mode (#2256 A2). Public mode rejects every escape
hatch below. `doctor` reports the effective values in `containerHardening`.

## Opt-in escape hatches

| Need | Explicit setting |
| --- | --- |
| Host network | `A2A_DOCKER_RUNNER_NETWORK=host` |
| Writable root filesystem | `A2A_DOCKER_RUNNER_READ_ONLY_ROOTFS=0` |
| Root user | `A2A_DOCKER_RUNNER_USER=root` |
| Keep engine default capabilities | `A2A_DOCKER_RUNNER_CAP_DROP=none` (or an explicit list without `ALL`; `doctor` warns) |
| Add a capability | `A2A_DOCKER_RUNNER_CAP_ADD=<CAP>[,<CAP>]` |
| Privilege escalation | `A2A_DOCKER_RUNNER_ALLOW_PRIVILEGE_ESCALATION=1` |

## Secret-mount ownership contract (`--cap-drop ALL` + container user)

`--cap-drop ALL` also removes `CAP_DAC_OVERRIDE`, so the container user cannot
bypass permission bits even as root. A profile secret mount (Piri/Claude/
Codex/Hermes/OpenClaw config dirs, the gh hosts token file) that is owned by a
different uid without group/others read is therefore **unreadable inside the
container** and fails with misleading errors such as `piri_config_mount_missing`
or `start_comment_failed` (#1802, #1809).

Rules:

- Match `A2A_DOCKER_RUNNER_USER` to the secret-file owner. The reference
  trusted-worker deployment uses `A2A_DOCKER_RUNNER_USER=1000:1000` with
  uid1000-owned secret files (`gh-hosts-uid1000.yml`).
- Keep `--cap-drop ALL`. The fix is ownership alignment, not capability
  relaxation.
- `doctor` (`secretMountReadability`) preflights this before a task runs:
  `status: "fail"` means the current host/user combination would fail inside
  the container. Numeric `uid[:gid]` values are checked directly; the explicit
  `root` escape hatch (and the equivalent unset `--user` image default) is
  checked as uid 0, including the no-`CAP_DAC_OVERRIDE` case.

| Need | Explicit setting |
| --- | --- |
| Non-root container user matching uid1000-owned secrets | `A2A_DOCKER_RUNNER_USER=1000:1000` |
| Root container user with root-owned secrets (`gh-hosts-root.yml`) | `A2A_DOCKER_RUNNER_USER=root` |

## Migration note

Existing trusted workers that assumed host networking, root, or a writable root filesystem must set the corresponding explicit variable. This is a deliberate fail-closed hardening change for #1204.

#2256 A1: an unset `A2A_DOCKER_RUNNER_CAP_DROP` used to mean "drop nothing"
and now means `--cap-drop ALL`. Workers that already set
`A2A_DOCKER_RUNNER_CAP_DROP=ALL` see no change. A worker that intentionally
relied on the old unset behavior must set `A2A_DOCKER_RUNNER_CAP_DROP=none` or
re-add specific capabilities with `A2A_DOCKER_RUNNER_CAP_ADD`. Because
`--cap-drop ALL` removes `CAP_DAC_OVERRIDE`, run `doctor` after upgrading and
fix any `secretMountReadability` failure by aligning secret ownership (above),
not by relaxing capabilities.
