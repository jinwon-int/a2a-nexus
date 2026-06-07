# OpenClaw CLI Provisioning

A2A patch workers use the `openclaw` CLI to execute `github-propose-patch` / `propose_patch` tasks. This document describes the supported provisioning paths for making the CLI available inside runner containers.

## Overview

The runner's `checkGitHubPatchReadiness` doctor check (`src/ops.ts`) probes the configured base image for CLI availability before task dispatch. If the probe fails and the npm install fallback is disabled, the doctor reports `openclaw_cli_unavailable` so the broker can avoid fanned-out Block failures.

Three provisioning paths exist:

| Path | Reliability | Recommended? |
|---|---|---|
| Pre-baked image | Highest | ✅ Preferred |
| Read-only CLI/config mount | High | ✅ Trusted worker |
| npm install fallback | Medium (network-dependent) | ⚠️ Escape hatch only |

---

## Path 1: Pre-baked runner image (preferred)

The most reliable approach: build a custom runner image with `openclaw` pre-installed globally.

### Dockerfile

```dockerfile
FROM node:22-bookworm-slim AS runner

# Install runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates curl gnupg \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && printf 'deb [arch=%s signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main\n' \
       "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Install OpenClaw CLI globally
RUN npm install -g openclaw

# Verify
RUN openclaw --version
```

### Configuration

Set the custom image via `A2A_DOCKER_RUNNER_IMAGE`:

```bash
A2A_DOCKER_RUNNER_IMAGE=ghcr.io/my-org/a2a-runner:latest
A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=openclaw
A2A_DOCKER_RUNNER_OPENCLAW_CONFIG_DIR=/root/.openclaw
```

### Benefits

- No runtime installs or network dependency
- Pinned version in the image prevents drift
- Cold-start is the same as the stock `node:22-bookworm-slim` image
- Doctor probe validates CLI before dispatch

### Caveats

- Operator must build, tag, and push the image
- Rollout requires image registry access on every runner node

---

## Path 2: Read-only mount (trusted worker)

Mount a host directory containing the OpenClaw CLI global installation AND config into the runner container. The CLI binary itself must be resolvable on PATH inside the container — either pre-installed in the base image, or made available via a node_modules mount.

### Requirements

- Host has `openclaw` installed globally (`npm install -g openclaw`)
- Host has a minimal OpenClaw config directory (see below)
- Both are mounted read-only into the container

### Config directory structure

```
~/.openclaw/
├── openclaw.json          # Required: agent/model/auth config
├── node.json              # Optional: node identity
├── credentials/           # Required: OAuth/API key credentials
│   └── ...
└── agents/
    └── main/
        └── agent/
            ├── auth-profiles.json  # Optional
            ├── auth-state.json     # Optional
            └── models.json         # Optional
```

### Configuration

```bash
A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=openclaw

# Mount the OpenClaw config directory (read-only)
A2A_DOCKER_RUNNER_OPENCLAW_CONFIG_DIR=/home/runner/.openclaw

# Mount the global node_modules to provide the CLI binary
A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON='[
  {"source": "/usr/lib/node_modules/openclaw", "target": "/usr/lib/node_modules/openclaw", "readOnly": true},
  {"source": "/usr/lib/node_modules", "target": "/usr/lib/node_modules", "readOnly": true}
]'
```

### Benefits

- No per-base-image build step
- Version is pinned by the host's npm global install
- Config and CLI are on separate lifecycles

### Caveats

- The node_modules mount can be brittle across distros
- Requires careful PATH management inside the container
- Prefer Path 1 (pre-baked image) for production

---

## Path 3: npm install fallback (escape hatch)

When the CLI is not pre-installed and mounts are not practical, the runner can install `openclaw` via `npm install -g` inside the container at task start.

### Configuration

```bash
A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=openclaw
A2A_DOCKER_RUNNER_OPENCLAW_CONFIG_DIR=/root/.openclaw

# Enable the npm install fallback
A2A_OPENCLAW_ALLOW_NPM_INSTALL_FALLBACK=1
```

### Reliability considerations

- ⚠️ Requires network access from the container
- ⚠️ npm registry availability is not guaranteed
- ⚠️ Install time (30-60s) delays task start
- ⚠️ Version depends on npm registry, not pinned
- ⚠️ Network throttling or rate limits may cause failures

The doctor check reports "warn" (not "fail") when fallback is enabled — the runner can proceed but network-dependent tasks may still fail.

### When to use

- Development / early integration stages
- Ephemeral environments where pre-baked images are not practical
- Temporary compatibility during migration to Path 1 or Path 2

---

## Doctor check behavior

The `doctor` command (`a2a-docker-runner doctor`) probes these provisioning paths:

1. **CLI resolution**: `command -v openclaw` inside the configured base image
2. **CLI version**: `openclaw --version` produces output
3. **Profile mount presence**: Config mount directory exists at expected path
4. **Compaction provider readiness**: if the mounted `openclaw.json`
   explicitly selects `agents.defaults.compaction.model=<provider>/<model>`,
   the same mounted profile must contain `models.providers.<provider>`.

### Outcome table

| CLI present? | Mount present? | Compaction provider ready? | Fallback enabled? | Doctor status | Failure category |
|---|---|---|---|---|---|
| Yes | Yes | Yes | N/A | `ok` | `ok` |
| Yes | Yes | No | N/A | `fail` | `openclaw_compaction_provider_unavailable` |
| Yes | No | N/A | N/A | `fail` | `openclaw_profile_unavailable` |
| No | Yes | N/A | No | `fail` | `openclaw_cli_unavailable` |
| No | Yes | N/A | Yes | `warn` | `openclaw_cli_unavailable` |
| No | No | N/A | No | `fail` | `openclaw_cli_unavailable` |

The `openclaw_cli_unavailable` failure is propagated to `RunnerEvidenceHints.failureCategory` and can be used by the broker to block task fan-out before dispatching child workers.

---

## Related

- [Design](./design.md) — Task lifecycle and runner architecture
- [Integration](./integration.md) — Handler integration flow
- [Release rollout checklist](./release-rollout-checklist.md) — Pre-deployment verification
- `src/config.ts` — `buildOpenClawPatchCommandScript` generates the container-side provisioning script
- `src/ops.ts` — `checkOpenClawProfilePatchReadiness` and `probeOpenClawProfileInContainer` implement the doctor probe
- `src/openclaw-profile-readiness.ts` — Pure validation module for probe results
- `examples/openclaw-profile-readiness-fixture.json` — Reference readiness fixture
