# Terminal brief default-on consolidation closeout

Closeout evidence for #1200.

## What changed

The default-on approval chain no longer occupies top-level `core/` as one file per stage. Stage implementation and paired tests now live under one bounded module directory:

```text
packages/broker/src/core/terminal-brief-sidecar-default-on/
```

Public imports flow through:

```text
packages/broker/src/core/terminal-brief-sidecar-default-on/index.ts
```

A small state registry lives at:

```text
packages/broker/src/core/terminal-brief-sidecar-default-on/state-machine.ts
```

## Measured result

- Before: `34` top-level files matching `packages/broker/src/core/terminal-brief-sidecar-default-on-*.ts`.
- After: `0` top-level files matching that pattern.
- Consolidated stage implementation modules: `17`.
- Consolidated paired tests: `17`.
- Guard: `npm run check:layout` fails if top-level default-on modules exceed `5` or the bridge module is missing.

## Import compatibility

`packages/broker/src/terminal-brief-sidecar-routes.ts` now imports default-on symbols from the bridge module. The bridge re-exports the moved stage modules, preserving the existing symbol names while removing the top-level file explosion.

## God-file note

`server.ts` already delegates the terminal-brief sidecar route table to `packages/broker/src/terminal-brief-sidecar-routes.ts`. `store.ts` snapshot durability and operator-facing persistence docs were handled in the preceding runtime hardening PR (#1205). This closeout ratchets the remaining C2 file-explosion regression point into layout CI so the state-machine boundary does not sprawl again.

## Verification

- `npm --prefix packages/broker run build`
- `cd packages/broker && node --test dist/core/terminal-brief-sidecar-default-on/*.test.js dist/server-terminal-brief-sidecar-default-on-gates.test.js` → `103/103` pass
- `npm run check:layout`
- `npm run check:packages`
- `npm run check:markdown-links`
- `npm run check`

## Boundaries

Source-only refactor. No runtime deploy/restart/provider send/DB or outbox mutation/release/tag/visibility/history rewrite/secret movement.
