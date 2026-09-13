# Trusted-operator Docker runner hardening

Trusted-operator mode is for OpenClaw/Hermes/Claude patch lanes that need host credentials or side-effect capability. It is still more privileged than the public safe-default mode, so defaults are conservative.

## Defaults

With `A2A_DOCKER_RUNNER_TRUSTED_OPERATOR=1` and an OpenClaw/Hermes/Claude profile:

- `--network bridge` by default. Host networking requires `A2A_DOCKER_RUNNER_NETWORK=host`.
- `--read-only` root filesystem by default, plus a bounded writable `/tmp` tmpfs.
- `--user 1000:1000` by default. Root requires `A2A_DOCKER_RUNNER_USER=root` or `A2A_DOCKER_RUNNER_USER=0`.
- `--security-opt no-new-privileges` remains default unless `A2A_DOCKER_RUNNER_ALLOW_PRIVILEGE_ESCALATION=1` is set.

## Opt-in escape hatches

| Need | Explicit setting |
| --- | --- |
| Host network | `A2A_DOCKER_RUNNER_NETWORK=host` |
| Writable root filesystem | `A2A_DOCKER_RUNNER_READ_ONLY_ROOTFS=0` |
| Root user | `A2A_DOCKER_RUNNER_USER=root` |
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
  the container. Use an explicit numeric `uid[:gid]` so the check is static.

| Need | Explicit setting |
| --- | --- |
| Non-root container user matching uid1000-owned secrets | `A2A_DOCKER_RUNNER_USER=1000:1000` |
| Root container user with root-owned secrets (`gh-hosts-root.yml`) | `A2A_DOCKER_RUNNER_USER=root` |

## Migration note

Existing trusted workers that assumed host networking, root, or a writable root filesystem must set the corresponding explicit variable. This is a deliberate fail-closed hardening change for #1204.

Switching an existing worker from `A2A_DOCKER_RUNNER_USER=root` to
`A2A_DOCKER_RUNNER_USER=1000:1000` is not a standalone variable flip: repoint the
gh hosts secret mount to the uid1000-owned file (`gh-hosts-uid1000.yml`) in the
same change, then re-run `doctor` and confirm `secretMountReadability` reports
`status: "ok"` before dispatching. Flipping the user while the mount still points
at the root-owned `gh-hosts-root.yml` leaves the token unreadable under
`--cap-drop ALL` and surfaces as `start_comment_failed` rather than a permission
error.
