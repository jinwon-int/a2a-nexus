# A2A Nexus

[![ci](https://github.com/jinwon-int/a2a-nexus/actions/workflows/ci.yml/badge.svg)](https://github.com/jinwon-int/a2a-nexus/actions/workflows/ci.yml)

A2A Nexus is an operator-gated A2A task and evidence control plane for safe delegated work: a broker/worker runtime plus a finalizer-ready evidence layer that helps maintainers route, inspect, and close out delegated tasks.

It complements the public A2A protocol and SDK ecosystem rather than replacing it. Public A2A protocol and SDK work focuses on interoperable agent-to-agent surfaces; A2A Nexus focuses on the operational layer around that work — broker-managed worker registration, auditable task lifecycle evidence, source-only review bridges, isolated patch execution, and operator closeout reports.

> **Compatibility statement:** A2A Nexus intends to interoperate with public A2A Agent Card / JSON-RPC conventions where practical, but it is not affiliated with or endorsed by a2aproject. Production deployment, package publication, external promotion, homepage metadata changes, and visibility-related actions remain separately operator-gated.

For external readers, start here first:

1. [Five-minute local quickstart](docs/quickstart.md) — disposable loopback broker plus echo worker path.
2. [Public architecture](docs/architecture.md) — conceptual broker/worker/finalizer/evidence map with no private topology.
3. [Trust boundaries and proof primitives](docs/trust-boundaries.md) — what Nexus evidence proves, what it does not prove, and which actions remain approval-gated.
4. [Public contribution entry points](docs/contribution-entry-points.md) — safe first-task candidates for outside contributors.
5. [Release and package readiness](docs/release-readiness.md) — checklist before any release, tag, npm, Docker, or GHCR decision.
6. [Public alpha landing draft](docs/public-alpha-landing.md) — content draft only; no homepage metadata or deployment approval.
7. [Verifiable analysis report sample](docs/verifiable-analysis-report.md) — offline-checkable report product slice with a public-safe fixture.

> **Status:** public alpha — the repository is publicly readable, but public visibility is not a production deployment, stable release, tag, package publish, homepage/docs-site launch, broad promotion, or live-action authorization. See [Current public alpha state](#current-public-alpha-state) for the remaining approval-gated actions.

`a2a-nexus` is now the canonical implementation source for the broker, adapter plugin, Docker runner, contracts, docs, examples, and readiness gates. Former split repositories remain active provenance mirrors; package publication, releases, deployment, and visibility-related actions stay separately approval-gated. See the [topology decision record](docs/topology-decision-record.md), [migration index](docs/history/monorepo-migration-index.md), and [history index](docs/history/README.md) for completed migration records.

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

If you are evaluating A2A Nexus from the public repository, stay on the local-only path first. Use the script-surface entrypoint layer to pick the smallest safe command before the full PR gate:

| Situation | Command path |
|---|---|
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
- OpenClaw is the first/reference integration, not the project name or a required runtime for every future integration.
- The A2A Nexus broker owns task lifecycle, worker registration, status, and terminal evidence.
- Workers execute assigned tasks and report evidence back through the broker.
- The Docker runner provides isolated GitHub patch execution for repository work.

This repository is the canonical A2A Nexus source and coordination workspace for those components, with the implementation surfaces living in `packages/*`. It is not a production deployment target.

## Repository Map

`a2a-nexus` holds the canonical implementation source in `packages/*`. The former split repositories remain active provenance mirrors of their respective surfaces.

| Repository | Public role | Canonical source |
| --- | --- | --- |
| [`a2a-nexus`](https://github.com/jinwon-int/a2a-nexus) | Canonical monorepo: broker, adapter plugin, Docker runner, contracts, docs, examples, readiness/release gates | **Canonical** — `packages/broker`, `packages/openclaw-plugin-a2a`, `packages/docker-runner`, project docs, contracts, compatibility/readiness policy, issue routing |
| [`a2a-broker`](https://github.com/jinwon-int/a2a-broker) | Broker service provenance mirror | Active provenance mirror of `packages/broker` (canonical source is `a2a-nexus`) |
| [`openclaw-plugin-a2a`](https://github.com/jinwon-int/openclaw-plugin-a2a) | Reference OpenClaw integration provenance mirror | Active provenance mirror of `packages/openclaw-plugin-a2a` (canonical source is `a2a-nexus`) |
| [`a2a-docker-runner`](https://github.com/jinwon-int/a2a-docker-runner) | Isolated worker provenance mirror | Active provenance mirror of `packages/docker-runner` (canonical source is `a2a-nexus`) |

The mirror repositories are unchanged, not archived, and retain their own closed issue/PR history. See the [topology decision record](docs/topology-decision-record.md) for the historical split-repo topology that preceded the canonical flip, and the [monorepo migration document index](docs/history/monorepo-migration-index.md) for a single navigational entry point across the staged migration records.

## Package Map

```text
packages/broker/                 # A2A Nexus broker HTTP/JSON-RPC APIs, worker registry, task lifecycle
packages/openclaw-plugin-a2a/    # first/reference OpenClaw integration for broker-backed task request/status/cancel
packages/docker-runner/          # isolated GitHub patch runner for worker tasks
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
- OpenClaw adapter configuration, diagnostics, Gateway plugin behavior, and request/status/cancel mapping map to `packages/openclaw-plugin-a2a` (`source:openclaw-plugin-a2a`).
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

Canonical source now lives in this repository's `packages/*`. The former split implementation repositories remain active provenance mirrors (unchanged, not archived), not canonical sources:

- `jinwon-int/a2a-broker` → mirror of `packages/broker`
- `jinwon-int/openclaw-plugin-a2a` → mirror of `packages/openclaw-plugin-a2a`
- `jinwon-int/a2a-docker-runner` → mirror of `packages/docker-runner`

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
