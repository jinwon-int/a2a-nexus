# Hermes / Android Native A2A Worker Runbook

This runbook covers the source-only native worker path for Gongyung/Daegyo-style
Android Termux nodes. It uses the broker-agnostic HTTP worker contract and does
not require a full OpenClaw Gateway install on the Android device.

## Safety Boundary

- No Gateway install is required on the Android node.
- No provider send, Telegram send, Terminal Brief ACK/replay, DB mutation,
  broker deploy, service restart, release, or secret movement is part of this
  runbook.
- Non-loopback broker URLs require a separately approved live canary packet and
  `A2A_HERMES_REFERENCE_ALLOW_NON_LOOPBACK=1`.
- Store secret values only in a local `0600` env file; never paste them into
  chat, issues, docs, logs, or evidence.

## Files

Recommended Termux layout:

```text
~/.local/share/a2a/hermes-worker/a2a_worker.py
~/.config/a2a/hermes-worker.env
~/.hermes/a2a/artifacts/<task-id>/evidence.json
~/.termux/boot/a2a-hermes-worker
```

The local evidence manifest uses schema
`a2a.hermesWorker.localEvidence.v1`. It records the task id, worker id, status,
redaction statement, timestamp, and safe evidence payload. Raw device ids,
provider tokens, private Termux paths, and raw session dumps must be redacted.

## Environment

Example env file shape:

```sh
export A2A_BROKER_URL=http://127.0.0.1:18787
export A2A_WORKER_ID=gongyung
export A2A_WORKER_DISPLAY_NAME="Gongyung Hermes Worker"
export A2A_WORKER_MODE=mobile
export A2A_HERMES_RUNTIME_FLAVOR=termux-hermes
export A2A_HERMES_ARTIFACT_ROOT="$HOME/.hermes/a2a/artifacts"
export A2A_HTTP_TIMEOUT_SEC=10
```

If an edge secret is required, keep `A2A_EDGE_SECRET` in this env file only and
set `chmod 600 ~/.config/a2a/hermes-worker.env`.

## Boot Persistence

Use Termux:Boot or another Android-approved startup mechanism. The boot script
should acquire a wake lock, load the env file, and run a bounded polling loop.

```sh
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
. "$HOME/.config/a2a/hermes-worker.env"
while true; do
  python3 "$HOME/.local/share/a2a/hermes-worker/a2a_worker.py" --action run-once
  sleep 20
done >> "$HOME/.hermes/a2a/worker.log" 2>&1
```

Keep the loop simple. The worker re-registers and heartbeats on every pass, so a
sleep/network interruption becomes a retry instead of a special recovery path.

## Reconnect And Sleep Handling

The Android worker should assume that TCP connections can drop at any time.

- Each loop calls register, heartbeat, poll, claim/start, and evidence through
  short HTTP requests.
- Local evidence is written before relying on broker-visible evidence.
- If the process is killed after local evidence but before broker submission,
  the operator can inspect `~/.hermes/a2a/artifacts/<task-id>/evidence.json`.
- The worker does not ACK Terminal Brief rows, replay providers, prune state, or
  mutate broker storage.

## Operator Check

Read-only checks after a dry-run:

```sh
find "$HOME/.hermes/a2a/artifacts" -maxdepth 2 -name evidence.json -print
python3 "$HOME/.local/share/a2a/hermes-worker/a2a_worker.py" --action heartbeat
```

Broker-side verification should use normal worker status, task evidence, and
Terminal Brief inbox views. Do not use manual ACK/replay unless there is a
separate operator approval.
