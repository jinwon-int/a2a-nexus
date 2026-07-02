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

## Migration note

Existing trusted workers that assumed host networking, root, or a writable root filesystem must set the corresponding explicit variable. This is a deliberate fail-closed hardening change for #1204.
