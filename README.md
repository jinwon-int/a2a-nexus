# A2A Nexus

[![ci](https://github.com/jinwon-int/a2a-nexus/actions/workflows/ci.yml/badge.svg)](https://github.com/jinwon-int/a2a-nexus/actions/workflows/ci.yml)

A2A Nexus is an operator-gated A2A task and evidence control plane for safe delegated work: a broker/worker runtime plus a finalizer-ready evidence layer that helps maintainers route, inspect, and close out delegated tasks.

It complements the public A2A protocol and SDK ecosystem rather than replacing it. Public A2A protocol and SDK work focuses on interoperable agent-to-agent surfaces; A2A Nexus focuses on the operational layer around that work — broker-managed worker registration, auditable task lifecycle evidence, source-only review bridges, isolated patch execution, and operator closeout reports.

> **Compatibility statement:** A2A Nexus intends to interoperate with public A2A Agent Card / JSON-RPC conventions where practical, but it is not affiliated with or endorsed by a2aproject. Production deployment, package publication, external promotion, homepage metadata changes, and visibility-related actions remain separately operator-gated.

For external readers, start here first:

1. [Five-minute local quickstart](docs/quickstart.md) — disposable loopback broker plus echo worker path.
2. [Public architecture](docs/architecture.md) — conceptual broker/worker/finalizer/evidence map with no private topology.
3. [Product boundaries and extraction contract](docs/product-boundaries.md) — G0 core/product map before any feature repository split.
4. [Trust boundaries and proof primitives](docs/trust-boundaries.md) — what Nexus evidence proves, what it does not prove, and which actions remain approval-gated.
5. [Public contribution entry points](docs/contribution-entry-points.md) — safe first-task candidates for outside contributors.
6. [Release and package readiness](docs/release-readiness.md) — checklist before any release, tag, npm, Docker, or GHCR decision.
7. [Public alpha landing draft](docs/public-alpha-landing.md) — content draft only; no homepage metadata or deployment approval.
8. [Verifiable analysis report sample](docs/verifiable-analysis-report.md) — offline-checkable report product slice with a public-safe fixture.
9. [Agent work proof sample](docs/agent-work-proof.md) — source-only work-completion evidence bundle with offline verifier and public-safe fixture.
10. [Escrow release proof sample](docs/escrow-proof.md) — source-only release-condition proof with no payment rail, custody, or funds movement.
11. [Agent payment dispute packet sample](docs/agent-payment-dispute-packet.md) — source-only dispute evidence packet for user delegation, scope, completion, and release-decision proof.

> **Status:** public alpha — the repository is publicly readable, but public visibility is not a production deployment, stable release, tag, package publish, homepage/docs-site launch, broad promotion, or live-action authorization. See [Current public alpha state](#current-public-alpha-state) for the remaining approval-gated actions.

`a2a-nexus` is now the canonical implementation source for the broker, harness adapters, Docker runner, contracts, docs, examples, and readiness gates. The former split repositories are archived and private, kept for provenance only; package publication, releases, deployment, and visibility-related actions stay separately approval-gated. See the [topology decision record](docs/topology-decision-record.md) and the [history index](docs/history/README.md) for completed migration records.

Additional project docs:

- [A2A current state](docs/current-state.md) - current source state, ownership boundaries, and checkout hygiene.
- [A2A operator guide](docs/operators.md) - approval points and finalizer boundaries.
- [A2A developer guide](docs/developers.md) - package surfaces and local validation for rehearsal work.
- [Public umbrella quickstart](docs/quickstart/public-umbrella.md) - repository map, issue routing, and local docs path.
- [A2A Nexus positioning](docs/positioning.md) - landscape comparison, differentiators, and public-safe framing.
- [External publicization roadmap](docs/publicization-roadmap.md) - gated publicization and release-readiness plan.

## Current public alpha state

This repository is now public and remains an alpha project:

- Code, docs, issues, and PRs are readable by the public.
- Feedback and contributions are welcome, but no production readiness, stability guarantees, or security support are implied.
- Tags, GitHub Releases, npm/Docker publication, production deploys, Gateway/broker/worker restarts, production data mutation, credential movement, provider/Telegram sends, terminal-outbox ACK/replay, and any future visibility transfer remain separate approval-gated actions and are **not** authorized by public repository visibility alone.

## What to try first

If you want to see A2A Nexus actually run, start with the **[Five-minute local quickstart](docs/quickstart.md)**: it is the runnable, copy-paste path from a fresh checkout that boots a loopback broker plus echo worker, submits a no-live task, and reaches a terminal `Done` result. Source-only install from this checkout is the only supported install path — all packages are `private`/unpublished, so there is no supported `npm install`, Docker, or GHCR path.

The command block below is the **pre-PR verification gate**, not the runnable broker path. Unlike the quickstart, `scan:external-secrets` additionally requires an external secret/history scanner (`gitleaks` or `trufflehog`) on `PATH` (see [Verification](#verification)); a bare fresh checkout can run the quickstart without it. Use the script-surface entrypoint layer to pick the smallest safe command before the full PR gate:

| Situation | Command path |
|---|---|
| See it run end-to-end | `docs/quickstart.md` (loopback broker + echo worker → terminal `Done`) |
| Local quick check | focused package/doc command for the touched files, for example `npm run check:markdown-links` for docs-only edits |
| PR check | `npm run check` |
| Public candidate check | `npm run scan:public-readiness`, `npm run scan:external-secrets`, and the relevant package/readiness audit |

```bash
npm ci --ignore-scripts --include=dev
npm run check
npm run check:quickstart-conformance
npm run scan:public-readiness
npm run scan:external-secrets
```

The full script-surface operator map lives in [`docs/ops/script-surface-entrypoints.md`](docs/ops/script-surface-entrypoints.md).
Then follow the public docs path in this order:

1. [Public umbrella quickstart](docs/quickstart/public-umbrella.md)
2. [Five-minute local quickstart](docs/quickstart.md)
3. [A2A Nexus positioning](docs/positioning.md)
4. [External publicization roadmap](docs/publicization-roadmap.md)

This path uses safe placeholders only. Do not paste real broker URLs, tokens, private node IDs, provider IDs, Telegram IDs, host-local paths, raw session dumps, or production data into public issues, pull requests, docs, or artifacts.

Historical coordination and completed migration records are summarized in [`docs/history/README.md`](docs/history/README.md), [`docs/history/public-readiness.md`](docs/history/public-readiness.md), and [`docs/current-state.md`](docs/current-state.md).


## What A2A Nexus does

A2A Nexus lets an operator-facing integration hand a task to a broker, route it to a worker, and collect terminal evidence such as `Done`, `Block`, or a pull request link. The stack is intentionally split so each component has a narrow safety boundary:

- A2A Nexus is the independent broker/worker plane and contract set.
- Harnesses are adapters, not the product. A2A Nexus targets any of them — Claude Code, Codex, Hermes, piri, OpenClaw — through the platform-independent [adapter contract](contracts/a2a/platform-adapter-interface.md); the per-harness bridges live under `packages/broker/scripts/`. No single harness is required, and none is the project name.
- The A2A Nexus broker owns task lifecycle, worker registration, status, and terminal evidence.
- Workers execute assigned tasks and report evidence back through the broker.
- The Docker runner provides isolated GitHub patch execution for repository work.

This repository is the canonical A2A Nexus source and coordination workspace for those components, with the implementation surfaces living in `packages/*`. It is not a production deployment target.

## Repository Map

`a2a-nexus` holds the canonical implementation source in `packages/*`. The former split repositories are archived and private; they hold provenance history only.

| Repository | Public role | Canonical source |
| --- | --- | --- |
| [`a2a-nexus`](https://github.com/jinwon-int/a2a-nexus) | Canonical monorepo: broker, harness adapters, Docker runner, contracts, docs, examples, readiness/release gates | **Canonical** — `packages/broker`, `packages/docker-runner`, `packages/policy-referee`, `packages/attestation`, `packages/nclex-evaluation`, project docs, contracts, compatibility/readiness policy, issue routing |
| `jinwon-int/a2a-broker` | Historical provenance mirror | **Archived and private.** Superseded by `packages/broker`; retained for issue/PR/tag provenance only and not reachable to outside readers. |
| `jinwon-int/plugin-a2a` | Historical OpenClaw integration mirror | **Archived and private.** The package it mirrored was removed from `a2a-nexus`; harness integration is now the per-harness bridge surface under `packages/broker/scripts/`. |
| `jinwon-int/a2a-docker-runner` | Historical provenance mirror | **Archived and private.** Superseded by `packages/docker-runner`; retained for issue/PR/tag provenance only and not reachable to outside readers. |

The mirror repositories are archived and private. They retain their own closed issue/PR history for provenance, but an outside reader cannot open them — they are named here as history, not as links to follow. See the [topology decision record](docs/topology-decision-record.md) for the historical split-repo topology that preceded the canonical flip, and the [history index](docs/history/README.md) for the records the migration left behind.

## Package Map

```text
packages/broker/                 # A2A Nexus broker HTTP/JSON-RPC APIs, worker registry, task lifecycle
packages/broker/scripts/*-a2a-analysis-bridge.mjs
                                 # per-harness adapters (claude, codex, hermes, piri) against the
                                 # platform-independent contract in contracts/a2a/
packages/docker-runner/          # isolated GitHub patch runner for worker tasks
packages/policy-referee/         # declarative worker-class policy engine (warn/enforce), consumed by the broker
packages/nclex-evaluation/       # NCLEX content PR evaluation domain (signed receipts, store, merge-ready projection), consumed by the broker (#1601 first slice)
packages/attestation/           # agent work attestation toolkit (verdict signing, evidence assembly, gates, provenance)
contracts/a2a/                   # shared A2A Nexus task lifecycle and terminal semantics contracts
contracts/compatibility/         # compatibility matrix and supported baselines
examples/                        # public-safe demos and fixtures only
docs/                            # public-readiness gates, quickstart, release notes, migration notes
.github/workflows/               # integrated CI gates
```

## Alpha and safety boundary

Treat every example as local-only unless a document says otherwise.

**NO-GO without explicit operator approval:**

- transferring repository ownership/visibility or making another visibility change
- production deploys or Gateway/broker/worker restarts
- production database or terminal-outbox mutation
- live provider, Telegram, or notification sends
- creating or moving tags, GitHub Releases, npm publishes, Docker/image publication, or package publication
- secret/credential movement, rotation, disclosure, or raw credential evidence
- history rewrite or force push

Use redacted evidence in issues, pull requests, logs, and artifacts.

## Issue Routing

Open issues in `a2a-nexus`, the canonical source repository. Use the `source:*` labels (see [`docs/issue-routing.md`](docs/issue-routing.md)) to record which surface an issue belongs to:

- Broker API, worker registry, task state, evidence storage, Agent Card/profile, and broker CI map to `packages/broker` (`source:a2a-broker`).
- Harness adapter behaviour — request/status/cancel mapping and per-harness bridging — maps to `packages/broker/scripts/*-a2a-analysis-bridge.mjs` and the adapter contract in `contracts/a2a/` (`source:a2a-broker`).
- Container worker execution, repository patch workflow, artifact capture, and PR/Done/Block worker evidence map to `packages/docker-runner` (`source:a2a-docker-runner`).
- Cross-repo compatibility, public docs, release/provenance gates, security/readiness policy, and topology decisions are project-level (`source:a2a-plane`).

Historical completed trackers are consolidated in [`docs/history/README.md`](docs/history/README.md) and related migration records.

## Five-minute local quickstart

Start with the local-only quickstart:

- [`docs/quickstart/public-umbrella.md`](docs/quickstart/public-umbrella.md)
- [`docs/quickstart.md`](docs/quickstart.md)

The quickstart is designed as the external-reader path for a disposable local A2A Nexus broker and dummy/echo worker. If your checkout does not yet include the runnable broker or worker scripts described there, treat that as a documented blocker rather than substituting production services.

## Promotion and release prep

Draft A2A Nexus announcement text and repository metadata recommendations live in [`docs/promotion-announcement.md`](docs/promotion-announcement.md). Keep that copy alpha/feedback-welcome and do not post it until public-readiness gates are closed and an operator explicitly approves promotion/announcement; any future ownership or visibility transfer remains separately approval-gated.

Release decision prep:

- [`docs/release-checklist.md`](docs/release-checklist.md)
- [`docs/history/promotion-validation.md`](docs/history/promotion-validation.md)
- [`CHANGELOG.md`](CHANGELOG.md)

## Reference OpenClaw integration example

Use safe placeholders only. Do not paste real broker URLs, tokens, node IDs, Telegram/provider IDs, or host paths into public docs or issue evidence.

```json
{
  "plugins": {
    "entries": {
      "a2a-broker-adapter": {
        "enabled": true,
        "config": {
          "baseUrl": "http://127.0.0.1:8787",
          "edgeSecret": "${A2A_EDGE_SECRET}",
          "requester": {
            "id": "local-openclaw-node",
            "kind": "node",
            "role": "operator"
          },
          "operatorEvents": {
            "enabled": false,
            "notification": {
              "enabled": false
            }
          },
          "wakeOnTask": {
            "enabled": false
          }
        }
      }
    }
  }
}
```

Keep production connection details in private operator configuration, not in repository examples.

## Import policy

Default import mode is **sanitized/squash import**, not full private history preservation.

Canonical source now lives in this repository's `packages/*`. The former split implementation repositories are archived and private, kept for provenance only:

- `jinwon-int/a2a-broker` → superseded by `packages/broker`
- `jinwon-int/plugin-a2a` → the package it mirrored was removed from this repository
- `jinwon-int/a2a-docker-runner` → superseded by `packages/docker-runner`

## Verification

Local validation requires an external secret/history scanner on `PATH`; install either
`gitleaks` or `trufflehog` before running the release gate. CI bootstraps
`gitleaks` with Go before invoking the same scan.

For local validation, use:

```bash
npm ci --ignore-scripts --include=dev
# install or otherwise provide gitleaks/trufflehog on PATH first
npm run check
```

The check script validates layout, package metadata, public-readiness scan rules,
and fails closed when the external scanner prerequisite is missing.


## Spec-first A2A changes

A2A Nexus uses a lightweight spec-first protocol for medium and large development/operations changes. Start with `docs/a2a-constitution.md`, then use the templates in `docs/spec-templates/` for feature specs, implementation plans, and task/evidence checklists.

This process is documentation-only in its initial adoption phase and does not change runtime behavior or authorize deploy/restart/canary/DB/replay/release actions.
