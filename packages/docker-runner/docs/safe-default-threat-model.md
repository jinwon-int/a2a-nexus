# Docker Runner Safe-Default Threat Model

Parent issue: `jinwon-int/a2a-nexus#957`
Implementation tracker: `jinwon-int/a2a-nexus#967`

## Scope

This document defines the first code-enforced boundary between:

1. **public safe-default mode** — the default for demos, public examples, and untrusted/multi-tenant-adjacent setups; and
2. **trusted-operator mode** — an explicit internal/operator lane for workers that intentionally need host-adjacent behavior.

The boundary is enforced by `validateRunnerConfig` before a task container starts. It is source-only/no-live testable and does not require a broker, container engine, provider call, database mutation, release, restart, or secret movement.

## Threats addressed

Public safe-default mode assumes task payloads and task commands may be adversarial or mistaken. The runner therefore rejects configuration that would turn a disposable task container into a host-adjacent execution environment:

| Risk | Public safe-default policy |
|---|---|
| Host network access | Reject `network: "host"`. |
| Privilege escalation | Require `no-new-privileges`; reject `A2A_DOCKER_RUNNER_ALLOW_PRIVILEGE_ESCALATION=1`. |
| Added Linux capabilities | Reject `capAdd` / `A2A_DOCKER_RUNNER_CAP_ADD`. |
| Retained Linux capabilities | Default `--cap-drop ALL`; reject `A2A_DOCKER_RUNNER_CAP_DROP=none` or any list without `ALL` (#2256 A1). |
| Root inside the container | Default `--user 1000:1000`; reject `A2A_DOCKER_RUNNER_USER=root` / `0` / `root:*` / `0:*` (#2256 A2). |
| Writable root filesystem | Default `--read-only` + bounded `/tmp` tmpfs; reject `A2A_DOCKER_RUNNER_READ_ONLY_ROOTFS=0` (#2256 A2). |
| Writable protected agent runtime/session mounts | Reuse the existing extra-mount preflight and reject writable `.openclaw`, `.hermes`, or `/run/secrets/*-dir` paths. |

## Trusted-operator mode

Trusted-operator mode is explicit:

```bash
export A2A_DOCKER_RUNNER_TRUSTED_OPERATOR=1
```

Use it only for operator-controlled workers where the operator intentionally accepts host-adjacent behavior such as:

- OpenClaw/Hermes patch profiles that need local gateway/profile compatibility;
- host network mode for a known internal service dependency;
- privilege-escalation opt-out or added capabilities for a specific trusted image.

Trusted-operator mode does **not** disable all safety checks. In particular, writable protected OpenClaw/Hermes runtime or session mounts remain blocked by the extra-mount preflight.

## Non-goals

This slice does not claim full container sandboxing. It does not replace Docker/Podman isolation, cgroups, seccomp/AppArmor profiles, separate worker hosts, token scoping, or broker authorization. It adds a first code-enforced configuration gate so public/default usage cannot silently inherit trusted internal assumptions.

## Operator migration notes

Existing internal OpenClaw/Hermes worker profiles that intentionally use host networking must set:

```bash
A2A_DOCKER_RUNNER_TRUSTED_OPERATOR=1
```

Public examples and new deployments should omit that variable and stay on bridge/none networking with `no-new-privileges` enabled and no added capabilities.

#2256 A1/A2: public safe-default mode used to default to a writable rootfs,
the image's root user, and no dropped capabilities, which was weaker than
trusted-operator mode. It now defaults to the same hardened floor as trusted
mode (`--cap-drop ALL`, `--user 1000:1000`, `--read-only`) and rejects explicit
relaxations. Public setups that set `A2A_DOCKER_RUNNER_USER=root`,
`A2A_DOCKER_RUNNER_READ_ONLY_ROOTFS=0`, or `A2A_DOCKER_RUNNER_CAP_DROP=none`
must remove them or become an explicit trusted-operator lane.
