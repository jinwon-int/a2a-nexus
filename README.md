# A2A Plane

[![ci](https://github.com/jinwon-int/a2a-plane/actions/workflows/ci.yml/badge.svg)](https://github.com/jinwon-int/a2a-plane/actions/workflows/ci.yml)

A2A Plane is the public "start here" entrypoint for the A2A broker/worker task handoff plane. Use this repository first for project orientation, public quickstarts, repo routing, contracts, examples, and cross-repo coordination.

The current public source layout remains split across four repositories while [#473](https://github.com/jinwon-int/a2a-plane/issues/473) decides whether A2A should stay split, consolidate into a monorepo, or keep split implementation repos behind a stronger public umbrella. Until that decision changes, each implementation repository remains canonical for its own runtime/package boundary.

Start here:

- [Public umbrella quickstart](docs/quickstart/public-umbrella.md) - repository map, issue routing, implementation boundaries, and first local docs path.
- [Five-minute local quickstart](docs/quickstart.md) - disposable loopback broker plus echo worker path.
- [A2A Ecosystem Guide](docs/ecosystem-guide.md) - bilingual component guide and historical consolidation context.

> **Status:** public source entrypoint, not a production deployment or release authorization. Tags, GitHub Releases, npm/Docker publication, production deploys, Gateway/broker/worker restarts, production data mutation, credential movement, and provider/Telegram sends remain separate approval-gated actions.

## What A2A Plane does

A2A Plane lets an operator-facing integration hand a task to a broker, route it to a worker, and collect terminal evidence such as `Done`, `Block`, or a pull request link. The stack is intentionally split so each component has a narrow safety boundary:

- A2A Plane is the independent broker/worker plane and contract set.
- OpenClaw is the first/reference integration, not the project name or a required runtime for every future integration.
- The A2A Plane broker owns task lifecycle, worker registration, status, and terminal evidence.
- Workers execute assigned tasks and report evidence back through the broker.
- The Docker runner provides isolated GitHub patch execution for repository work.

This repository is the public A2A Plane umbrella and coordination workspace for those components. It is not a production deployment target.

## Repository Map

| Repository | Public role | Canonical implementation boundary |
| --- | --- | --- |
| [`a2a-plane`](https://github.com/jinwon-int/a2a-plane) | Start-here umbrella, cross-repo docs, coordination issues, contracts, examples, readiness and release gates | Project-level docs, contracts, compatibility/readiness policy, cross-repo issue routing |
| [`a2a-broker`](https://github.com/jinwon-int/a2a-broker) | Broker service source | Task lifecycle API, worker registry, status/cancel semantics, terminal evidence collection |
| [`openclaw-plugin-a2a`](https://github.com/jinwon-int/openclaw-plugin-a2a) | Reference OpenClaw integration | OpenClaw Gateway adapter for request/status/cancel, diagnostics, event/wake bridge |
| [`a2a-docker-runner`](https://github.com/jinwon-int/a2a-docker-runner) | Isolated worker source | Containerized repository patch execution, PR/Done/Block evidence, artifact capture |

The package paths below mirror those implementation areas in this checkout for integrated validation and docs, but the split repos above remain the public implementation boundaries pending [#473](https://github.com/jinwon-int/a2a-plane/issues/473).

## Package Map

```text
packages/broker/                 # A2A Plane broker HTTP/JSON-RPC APIs, worker registry, task lifecycle
packages/openclaw-plugin-a2a/    # first/reference OpenClaw integration for broker-backed task request/status/cancel
packages/docker-runner/          # isolated GitHub patch runner for worker tasks
contracts/a2a/                   # shared A2A Plane task lifecycle and terminal semantics contracts
contracts/compatibility/         # compatibility matrix and supported baselines
examples/                        # public-safe demos and fixtures only
docs/                            # public-readiness gates, quickstart, release notes, migration notes
.github/workflows/               # integrated CI gates
```

## Alpha and safety boundary

Treat every example as local-only unless a document says otherwise.

**NO-GO without explicit operator approval:**

- changing repository visibility
- production deploys or Gateway/broker/worker restarts
- production database or terminal-outbox mutation
- live provider, Telegram, or notification sends
- secret rotation, secret disclosure, or raw credential evidence
- history rewrite or force push

Use redacted evidence in issues, pull requests, logs, and artifacts.

## Issue Routing

Open project-level or ambiguous issues in `a2a-plane` first. Move or mirror implementation-specific follow-up to the owning repo when the boundary is clear:

- Broker API, worker registry, task state, evidence storage, Agent Card/profile, and broker CI belong in `a2a-broker`.
- OpenClaw adapter configuration, diagnostics, Gateway plugin behavior, and request/status/cancel mapping belong in `openclaw-plugin-a2a`.
- Container worker execution, repository patch workflow, artifact capture, and PR/Done/Block worker evidence belong in `a2a-docker-runner`.
- Cross-repo compatibility, public docs, release/provenance gates, security/readiness policy, and topology decisions belong in `a2a-plane`.

Current public umbrella tracker:

- [#473](https://github.com/jinwon-int/a2a-plane/issues/473) - decide split repo vs monorepo/umbrella topology.
- [#477](https://github.com/jinwon-int/a2a-plane/issues/477) - public repo map and umbrella docs.
- [#478](https://github.com/jinwon-int/a2a-plane/issues/478) - public-source security, secret-history, license, and provenance scan.
- [#479](https://github.com/jinwon-int/a2a-plane/issues/479) - release, version, and provenance checklist.
- [#480](https://github.com/jinwon-int/a2a-plane/issues/480) - local public demo and quickstart scenario.

## Five-minute local quickstart

Start with the local-only quickstart:

- [`docs/quickstart/public-umbrella.md`](docs/quickstart/public-umbrella.md)
- [`docs/quickstart.md`](docs/quickstart.md)

The quickstart is designed as the external-reader path for a disposable local A2A Plane broker and dummy/echo worker. If your checkout does not yet include the runnable broker or worker scripts described there, treat that as a documented blocker rather than substituting production services.

## Promotion and release prep

Draft A2A Plane announcement text and repository metadata recommendations live in [`docs/promotion-announcement.md`](docs/promotion-announcement.md). Keep that copy alpha/feedback-welcome and do not post it until public-readiness gates are closed and an operator explicitly approves repository visibility.

Release decision prep:

- [`docs/release-checklist.md`](docs/release-checklist.md)
- [`docs/promotion-validation.md`](docs/promotion-validation.md)
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

The split implementation repositories remain canonical for their own boundaries pending [#473](https://github.com/jinwon-int/a2a-plane/issues/473):

- `jinwon-int/a2a-broker`
- `jinwon-int/openclaw-plugin-a2a`
- `jinwon-int/a2a-docker-runner`

## Verification

For local validation, use:

```bash
npm ci --ignore-scripts --include=dev
npm run check
```

The check script validates layout, package metadata, and public-readiness scan rules.


## Spec-first A2A changes

A2A Plane uses a lightweight spec-first protocol for medium and large development/operations changes. Start with `docs/a2a-constitution.md`, then use the templates in `docs/spec-templates/` for feature specs, implementation plans, and task/evidence checklists.

This process is documentation-only in its initial adoption phase and does not change runtime behavior or authorize deploy/restart/canary/DB/replay/release actions.
