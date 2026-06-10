# Standalone HTTP worker reference card

This directory is a public-safe reference worker lane for A2A Nexus that is not tied to OpenClaw. It is intentionally a fixture, not a production worker and not a live registration script.

Use it to review the minimum worker-facing contract:

- stable public-safe worker identity;
- coarse capability labels;
- explicit safety policy version;
- local-only broker endpoint placeholders;
- terminal evidence limited to `done`, `pr`, or `blocked` results.

For the current broker-agnostic HTTP contract, see:

```bash
cat docs/specs/hermes-worker-integration/spec.md
cat fixtures/contract/hermes-worker-registration.json
```

## Why this proves a second lane

The worker card has no OpenClaw runtime fields, Gateway settings, provider IDs, Telegram identifiers, host paths, or secrets. A compatible standalone worker can be written in any runtime that can speak the broker worker API and preserve the terminal evidence boundaries in `contracts/a2a/terminal-semantics.md`.

## Review-only usage

Inspect the card:

```bash
cat examples/workers/standalone-http-worker/worker-card.json
```

Review the terminal evidence mapping for this second worker shape:

```bash
cat docs/validation/standalone-worker-terminal-evidence.md
```

Validate the repository safety checks from the repository root:

```bash
npm run check
```

Do not point this fixture at a production broker, restart worker services, send provider messages, or mutate terminal-outbox ACK records.
