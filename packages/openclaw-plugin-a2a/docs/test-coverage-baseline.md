# Plugin test-coverage baseline (#648)

Brings `openclaw-plugin-a2a` to the monorepo test convention used by
`broker` and `docker-runner`: **colocated `src/**/*.test.ts` suites** next to
the modules they exercise, with genuinely integration-shaped suites retained
under `test/` and wired into the package `test` script so it runs everything.

## Test execution model

The broker/docker-runner packages compile their colocated `*.test.ts` with
`tsc` and run `node --test dist/**/*.test.js`. This package's TS suites
(`tests/*.test.ts`, predating this issue, and now the colocated `src/**/*.test.ts`)
run via Node's native TypeScript type-stripping (`node --test path/to/x.test.ts`),
importing the compiled `dist/` build. Two reasons this package uses
type-stripping rather than compiling the tests:

1. The colocated suites migrated here come from legacy **untyped `.mjs`**
   tests. Compiling them under the runtime `tsconfig.json` (`strict: true`)
   surfaced **358 type errors** (string literals not narrowed to unions,
   `boolean` vs `true` receipts, `Expected 1 argument but got 0`, property
   access on unions). Making them compile would require rewriting assertions,
   violating the issue's "preserve every assertion" constraint.
2. Keeping `*.test.ts` excluded from `tsconfig.json` means **no test code is
   emitted into `dist/`** — the shipped npm package (`files: ["dist/", ...]`)
   stays free of test artifacts.

Runtime source type-safety is still fully enforced: `npm run build`
(`tsc -p tsconfig.json`, strict) typechecks all of `src/**/*.ts` and the
top-level modules with **0 errors**.

The package `test` script runs the full set:

```
npm run build &&
node --test src/**/*.test.ts ./*.test.ts test/*.test.mjs tests/*.test.ts
```

- `src/**/*.test.ts` — colocated unit suites (migrated + new)
- `./*.test.ts` — top-level-module colocated suites (`type-mapping`,
  `standalone-broker-client`, `plugin-id`)
- `test/*.test.mjs` — retained integration / artifact suites
- `tests/*.test.ts` — pre-existing TS suites (unchanged)

## Before / after counts

| Metric | Before | After |
| --- | ---: | ---: |
| Total passing tests (`npm test`) | 1657 | 1685 |
| Failing tests | 0 | 0 |
| Legacy `test/*.test.mjs` suites | 20 | 5 (integration, retained) |
| Colocated `src/*.test.ts` suites | 0 | 16 |
| Top-level `*.test.ts` suites | 0 | 3 |
| Pre-existing `tests/*.test.ts` suites | 45 | 45 (unchanged) |
| New gap-coverage tests | — | +28 |

The migration is MOVE+convert (import-path rewrite only): no assertion was
added or removed, so the +28 delta is exactly the new gap-coverage tests.

### Source : test LOC ratio

| | LOC |
| --- | ---: |
| Runtime source (`src/*.ts` + top-level `*.ts`, non-test) | 30,301 |
| All test LOC (`src/*.test.ts` + `*.test.ts` + `tests/*.test.ts` + `test/*.test.mjs`) | 35,218 |
| **Ratio** | **1 : 1.16** |

## Migration map (`test/*.test.mjs` → colocated)

| Legacy `.mjs` | Migrated to | Primary module under test | Cases |
| --- | --- | --- | ---: |
| conformance-smoke-gate | `src/conformance-smoke-gate.test.ts` | conformance-smoke-gate | 17 |
| gateway-config-bridge | `src/gateway-config-bridge.test.ts` | gateway-config-bridge | 41 |
| gateway-handlers | `src/gateway-handlers.test.ts` | gateway-handlers, gateway-validators, plugin-errors | 14 |
| gateway-runtime-bridge | `src/gateway-runtime-bridge.test.ts` | gateway-handlers (runtime bridge) | 5 |
| goal-operator-summary | `src/goal-operator-summary.test.ts` | goal-operator-summary | 8 |
| handoff-visibility-policy | `src/handoff-visibility-policy.test.ts` | handoff-visibility-policy | 6 |
| metadata-roundtrip | `src/metadata-roundtrip.test.ts` | gateway-handlers, standalone-broker-client | 5 |
| operator-notification-preflight | `src/operator-notification-preflight.test.ts` | operator-notification-adapter | 16 |
| orchestration-wake | `src/orchestration-wake.test.ts` | wake-layer (+ type-mapping) | 14 |
| recovery-guard | `src/recovery-guard.test.ts` | recovery-guard | 17 |
| recovery-loop | `src/recovery-loop.test.ts` | wake-layer (+ type-mapping) | 16 |
| remote-node-handoff-adapter | `src/remote-node-handoff-adapter.test.ts` | remote-node-handoff-adapter, remote-node-resolver, sessions-send-hook | 12 |
| sessions-send-hook | `src/sessions-send-hook.test.ts` | sessions-send-hook | 9 |
| wake-layer | `src/wake-layer.test.ts` | wake-layer | 10 |
| type-mapping | `type-mapping.test.ts` (top level) | type-mapping | 6 |

Conversion was purely mechanical: rewrite `../dist/...` import specifiers so
they remain correct from the new file location, and rename `.mjs` → `.ts`. No
test body or assertion changed.

## Retained under `test/` (integration / artifact suites, wired into `test`)

| Retained `.mjs` | Why it stays out of `src/**/*.test.ts` |
| --- | --- |
| `plugin-entry-reload.test.mjs` | Imports the plugin **ESM entry default export** (`../dist/index.js`) and asserts the reload contract. Converting the plugin entry seam to a colocated TS unit is the explicitly-flagged risky case; keeping it wired-in is the conservative call. |
| `operator-event-bridge.test.mjs` | Largest legacy suite (65 cases). Wires together monitoring handlers + event bridge + notification adapter + cross-broker relay using tmpdir fixtures and many dynamic `import()` of `dist/` — an integration suite, not a single-module unit. |
| `agent-card-discovery.test.mjs` | Reads a shipped artifact (`docs/a2a-agent-card.local.json`) via `import.meta.url` relative to package root; colocating + dist-relative resolution would break the path. Validates a shipped doc, not source-unit logic. |
| `docker-runner-dev-e2e-proof.test.mjs` | Reads a shipped proof doc (`docs/docker-runner-dev-e2e-proof.md`) via `import.meta.url`. Artifact assertion, same path-fragility. |
| `openclaw-plugin-config-schema.test.mjs` | Reads `openclaw.plugin.json` (the shipped manifest) via `import.meta.url`. Manifest/artifact assertion. |

(The pre-existing `tests/*.test.ts` `terminal-brief-hermes-gongyung` /
`terminal-brief-openclaw-message` use `spawnSync`, and `sessions-send-hook`
imports the plugin entry — these are genuine integration suites that already
lived in `tests/` and are already wired into the script.)

## Gap map — src module → covering test → gaps

`src/` modules: 46; top-level modules: 9 (counting `*.ts`, excluding tests).
Below highlights coverage status; modules not listed have a name-matched or
direct-import suite.

### Zero-coverage at the start of #648 (now addressed)

| Module | Status before | Action |
| --- | --- | --- |
| `standalone-broker-client.ts` (transport client headers/envelopes) | exercised only indirectly via fixtures; **no test pinned header-less behavior or error-envelope surfacing** | NEW `standalone-broker-client.test.ts` (16 cases) |
| `src/wake-envelope.ts` | **zero** — never imported by any test | NEW `src/wake-envelope.test.ts` (8 cases) |
| `src/runtime-wake-dispatch.ts` | **zero** | NEW `src/runtime-wake-dispatch.test.ts` (4 cases) |
| `plugin-id.ts` | **zero** | NEW `plugin-id.test.ts` (2 cases) |

### Remaining zero / indirect-only coverage (honest gaps, not closed here)

| Module | Coverage |
| --- | --- |
| `gateway-schema.ts` | **Zero direct.** TypeBox schema definitions; only exercised transitively if validators import them. Candidate for a follow-up schema round-trip suite. |
| `api.ts` | No name-matched suite; surfaced indirectly through gateway/regression tests that import the public API barrel. |
| `gateway-validators.ts` | No name-matched suite; covered via `gateway-handlers` + regression suites. |
| `gateway-monitoring-handlers.ts` | No name-matched suite; covered via 6 operator/broker suites. |
| `operator-notification-adapter.ts` | No name-matched suite; covered via 5 notification/no-live suites. |
| `remote-node-resolver.ts` | No name-matched suite; covered via `remote-node-handoff-adapter` suite. |
| `plugin-errors.ts` | No name-matched suite; covered via gateway + regression suites. |

## New high-value gap coverage added (#648)

1. **A2A transport client request/response contract**
   (`standalone-broker-client.test.ts`):
   - Pins that the client sends **no `A2A-Version` / `x-a2a-version` header**
     on POST (`createTask`), GET (`health`, `getTask`), and JSON-RPC
     (`peerStatus`) verbs — the canonical legacy-client behavior the broker's
     spec/legacy split detects.
   - Pins parsing of the **legacy flat task-record envelope** returned by
     `createTask` / `getTask`.
   - **Error envelope surfacing**: broker `{ error: { code, message } }` →
     `A2ABrokerClientError` (code/message/details), status-derived fallback
     message, JSON-string body message, malformed-JSON →
     `A2ABrokerMalformedResponseError`, and JSON-RPC error → client error on
     `peerStatus`.
   - Legacy `x-a2a-edge-secret` / `x-a2a-requester-*` header forwarding and
     `normalizeA2ABrokerBaseUrl` pure-utility behavior.
2. **`src/wake-envelope.ts`**: envelope construction precedence
   (payload → fallback → task fields), last-resort target-key fallback,
   unparseable `createdAt`, non-object payload tolerance, opt-in default-skip,
   scheduled dispatch with run-id surfacing, and best-effort `onResult`
   callback isolation.
3. **`src/runtime-wake-dispatch.ts`**: queued/coalesced/visible-failure
   receipt mapping and wake-message + routing-key forwarding to the adapter.
4. **`plugin-id.ts`**: wire-stable canonical id literal + re-export parity.
