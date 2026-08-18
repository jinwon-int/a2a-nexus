# piri-memory-extension

A2A piri lane memory injection (a2a-nexus#1797 item 3a — nunchi/MemPalace
memory injection porting).

Baked into the `a2a-docker-runner-piri` image at
`/opt/a2a-runner/piri-memory-extension` and loaded by the piri lane command
script via `-e` when the runner opts in with
`A2A_DOCKER_RUNNER_PIRI_MEMORY_ENABLED=1` (default: off).

## Contract

- The task packer / worker host may drop a bounded markdown memory snapshot at
  `/work/memory.md` (override: `A2A_PIRI_MEMORY_FILE`, allowlisted roots:
  `/work/`, `/run/secrets/piri-memory/`).
- The extension appends the snapshot to the assembled system prompt in
  `before_agent_start`, wrapped in an `<a2a-memory file=… bytes=… sha256=…>`
  boundary with a provenance header.
- Bound: `A2A_PIRI_MEMORY_MAX_BYTES` (default 32768, hard ceiling 131072).
  Reads are bounded (`maxBytes + 1`); oversized, absent, or unreadable
  snapshots are a no-op with an artifact marker at
  `/work/artifacts/piri-memory.json` — never fatal to the task.
- The per-turn system prompt override lives until the run settles, so the
  memory segment survives a mid-run auto-compaction on this lane.

## Non-goals (first slice)

- Producing the snapshot. nunchi/MemPalace → `memory.md` materialization on
  the worker host is a separate, operator-approved step.
- RPC-host (ccc bridge) post-compaction reinjection — that path is served by
  piri#2 (`compaction_*` lifecycle identifiers + `set_append_system_prompt`).
