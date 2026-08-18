# piri lane memory injection (#1797 item 3a)

Port of the nunchi/MemPalace memory-injection idea to the A2A piri lane as a
baked, opt-in piri extension.

## Shape

- Extension: `packages/docker-runner/docker/piri-memory-extension/`
  (`index.js` + dependency-free `policy.js`), baked read-only at
  `/opt/a2a-runner/piri-memory-extension` by `piri-runner.Dockerfile`.
- Opt-in: runner env `A2A_DOCKER_RUNNER_PIRI_MEMORY_ENABLED=1`. Default off;
  with the flag off the generated command script is byte-for-byte the plain
  lane (no `-e`, no `PIRI_MEMORY_ARGS`, no snapshot lines).
- Wiring: `buildPiriPatchCommandScript` fails closed
  (`error=piri_memory_extension_missing`, exit 2) when the flag is on but the
  image lacks the baked extension, surfaces the snapshot contract
  (`memory_snapshot=present|absent path=… bytes=…`) to
  `/work/artifacts/summary.txt`, and appends `PIRI_MEMORY_ARGS` to the final
  `piri -p` invocation on **both** the read-only and patch lanes (task memory
  helps analysis too; unlike fanout, which is patch-lane only in Phase 2).

## Snapshot contract (first slice)

- Source file: `A2A_PIRI_MEMORY_FILE`, default `/work/memory.md`.
  Allowlisted roots only: `/work/`, `/run/secrets/piri-memory/`. Notably
  `/run/secrets/piri-dir` is refused — snapshot content enters the model
  prompt, so it must never be the piri config/auth directory.
- Bound: `A2A_PIRI_MEMORY_MAX_BYTES` (default 32768, hard ceiling 131072).
  Reads are bounded (`maxBytes + 1`); oversized, absent, or unreadable
  snapshots are a no-op with a marker at
  `/work/artifacts/piri-memory.json` (`injected:false, reason`), never fatal.
- Injection: `before_agent_start` appends the snapshot to the assembled
  system prompt inside an `<a2a-memory file=… bytes=… sha256=…>` boundary.
  The per-turn override lives until the run settles, so the segment survives
  a mid-run auto-compaction on this lane.
- The extension never writes to stdout (machine-readable event stream) and
  never exits the process.

## Relationship to piri#2

piri#2 (piri#18, `2ee4206`) delivered the RPC-host contract: body-free
`compaction_start`/`compaction_end` identifiers and the
`set_append_system_prompt` runtime command. That serves the ccc bridge
(RPC-host) reinjection path (ccc-node#948's `memory_postcompact_reinject`).
This item 3a is the **CLI/extension lane** equivalent for the A2A docker
runner and does not require the RPC contract; both share the bounded-snapshot
+ provenance-marker conventions.

## Follow-ups (separate, operator-approved)

- Producer wiring: nunchi/MemPalace → bounded `memory.md` materialization on
  the worker host, plus broker/task-packer placement into the task workspace.
- Image re-bake + pin baseline refresh (`/etc/a2a-runner/piri-revision`
  unchanged; the extension is image content, so the image digest changes).
- Pilot enablement per fleet phase gates (shadow → canary → widen), like the
  fanout rollout (#1798).
