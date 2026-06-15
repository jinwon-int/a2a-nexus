# Termux proot-distro A2A Runner (Development/Testing)

**Status**: Experimental / Testing only  
**Last updated**: 2026-06-15 by gongyung

## Overview

Termux nodes (gongyung, daegyo) can run development/test A2A worker experiments using `proot-distro` Ubuntu container + Hermes. Treat this as a research/test lane, not a Docker-runner or production deployment lane.

This is **not recommended for production** but excellent for development, testing, and rapid prototyping of A2A workers without needing a full VPS.

## Setup (on any Termux node)

```bash
# 1. Install proot-distro (if not already installed)
pkg install proot-distro

# 2. Create Ubuntu container
proot-distro install ubuntu:24.04

# 3. Enter and install Hermes + dev tools
proot-distro login ubuntu
apt update && apt install -y python3 python3-pip python3-venv git curl
python3 -m venv ~/.hermes-venv
source ~/.hermes-venv/bin/activate
pip install hermes-agent
```

## Basic Configuration

Create `~/.hermes/config.yaml`:
```yaml
model:
  provider: xai-oauth
  default: grok-4.20
display:
  reasoning: on
  reasoning_level: high
  busy_input_mode: queue
```

## Usage

```bash
proot-distro login ubuntu
source ~/.hermes-venv/bin/activate
hermes --version
hermes model
```

## A2A Worker Example

Use the native Hermes worker loop for mobile/no-live lanes. For broker-side reference code, see `examples/workers/hermes-reference-worker/` from the repository root.

## Limitations (Important)

- **Nested overhead**: Android → proot → Ubuntu → Docker (performance loss)
- **Stability**: Samsung OneUI battery optimization can kill the container (use wake-lock + unrestricted battery settings)
- **Go binaries**: May trigger SIGSYS on Android
- **Storage**: Limited to Termux partition (~5-6GB visible with `df`)
- **Networking**: Tailscale works but port binding can be restricted

## Recommendation

- **Development/Testing**: Use this proot-distro method on Termux nodes
- **Production A2A Runners**: Use real Linux VPS (yukson, soonwook, gwakga, seoseo)

## See Also
- [A2A Nexus main runbook](./a2a-constitution.md)
- [Hermes on Android](./hermes-android-native-worker-runbook.md)



## Production boundary

For live A2A broker/worker service deployment, use the VPS/systemd path (`a2a-hermes-worker` under `/opt/a2a-broker-worker`) and keep Team1/Team2 broker routing unchanged. This proot-distro path is for local development, reproducibility checks, and no-live A2AD research lanes only.
