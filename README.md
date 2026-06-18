# A2A Nexus

[![ci](https://github.com/jinwon-int/a2a-nexus/actions/workflows/ci.yml/badge.svg)](https://github.com/jinwon-int/a2a-nexus/actions/workflows/ci.yml)

A2A Nexus is the public "start here" entrypoint for the A2A broker/worker task handoff plane. Use this repository first for project orientation, public quickstarts, repo routing, contracts, examples, and cross-repo coordination.

`a2a-nexus` is now the canonical implementation source. An operator-approved, source-state-only canonical flip (recorded in [`fixtures/current-state/monorepo-actual-canonical-flip-execution-result.json`](fixtures/current-state/monorepo-actual-canonical-flip-execution-result.json)) made `packages/broker`, `packages/openclaw-plugin-a2a`, and `packages/docker-runner` the canonical A2A source of truth in this repository. The former split repositories (`a2a-broker`, `openclaw-plugin-a2a`/`plugin-a2a`, `a2a-docker-runner`) remain **active provenance mirrors only** — unchanged, not archived, not redirected, with package ownership not transferred. Package publication, releases, and repository-visibility changes stay separately approval-gated and are not implied by this source-state flip. For historical context, see the [topology decision record](docs/topology-decision-record.md) and the monorepo re-entry decision in [`docs/monorepo-reentry-decision.md`](docs/monorepo-reentry-decision.md) (originally tracked as historical provenance in [a2a-plane#511](https://github.com/jinwon-int/a2a-plane/issues/511)).

Start here:

- [A2A current state](docs/current-state.md) - active #536 monorepo phase-3 package CI parity jobs, completed #506/#511/#513/#514/#515/#517/#528/#530/#534 groundwork, ownership boundaries, and checkout hygiene.
- [A2A monorepo re-entry decision](docs/monorepo-reentry-decision.md) - #511 staged umbrella workspace decision, target layout, gates, and no-live boundaries.
- [A2A monorepo migration guide](docs/migration.md) - phase 0 migration states, no-live boundaries, provenance, and backlink policy.
- [A2A operator guide](docs/operators.md) - operator approval points and finalizer boundaries.
- [A2A developer guide](docs/developers.md) - package surfaces and local validation for rehearsal work.
- [A2A issue routing policy](docs/issue-routing.md) - source labels, split repo provenance, and future cutover backlinks.
- [Public umbrella quickstart](docs/quickstart/public-umbrella.md) - repository map, issue routing, implementation boundaries, and first local docs path.
- [Five-minute local quickstart](docs/quickstart.md) - disposable loopback broker plus echo worker path.
- [A2A Ecosystem Guide](docs/ecosystem-guide.md) - bilingual component guide and historical consolidation context.

> **Status:** public-readiness candidate — alpha project, not a repository visibility change, production deployment, release, tag, publish, or live-action authorization. See [Current visibility-readiness state](#current-visibility-readiness-state) for what remains blocked before any future visibility change or broader promotion.

## Current visibility-readiness state

This repository remains private unless a separate operator-approved GitHub visibility change is executed and evidenced. If public GitHub visibility is later approved, it would mean:

- Code, docs, issues, and PRs are readable by anyone with a GitHub account.
- The project is **alpha** — feedback and contributions are welcome, but no production readiness, stability guarantees, or security support are implied.
- Tags, GitHub Releases, npm/Docker publication, production deploys, Gateway/broker/worker restarts, production data mutation, credential movement, provider/Telegram sends, and terminal-outbox ACK/replay remain separate approval-gated actions and are **not** authorized by this repository's readiness docs or any future public visibility alone.

Historical coordination (pre-flip provenance, now superseded by the canonical `a2a-nexus` source state):

- [a2a-plane#536](https://github.com/jinwon-int/a2a-plane/issues/536) — monorepo phase-3 package CI parity job implementation that preceded the source-state canonical flip.

Completed groundwork:

- [a2a-plane#506](https://github.com/jinwon-int/a2a-plane/issues/506) — current-state integration and A2A effectiveness wave.
- [a2a-plane#507](https://github.com/jinwon-int/a2a-plane/issues/507) — current-state docs and checkout hygiene.
- [a2a-plane#508](https://github.com/jinwon-int/a2a-plane/issues/508) — no-live cross-repo integration smoke spec.
- [a2a-plane#511](https://github.com/jinwon-int/a2a-plane/issues/511) — monorepo re-entry decision after the #506 wave.
- [a2a-plane#513](https://github.com/jinwon-int/a2a-plane/issues/513) — monorepo import rehearsal and mirror freshness checks.
- [a2a-plane#514](https://github.com/jinwon-int/a2a-plane/issues/514) — monorepo CI parity and package boundary matrix.
- [a2a-plane#515](https://github.com/jinwon-int/a2a-plane/issues/515) — monorepo docs, CODEOWNERS, and issue-routing policy.
- [a2a-plane#517](https://github.com/jinwon-int/a2a-plane/issues/517) — branch protection and release/package policy.
- [a2a-plane#528](https://github.com/jinwon-int/a2a-plane/issues/528) — phase-1 import rehearsal gate refresh after the all-repo audit.
- [a2a-plane#530](https://github.com/jinwon-int/a2a-plane/issues/530) — phase-2 fresh prefix import rehearsal and equal-or-stricter package CI parity gate evidence.
- [a2a-plane#534](https://github.com/jinwon-int/a2a-plane/issues/534) — phase-3 package CI gate before package mirror refresh.
- [a2a-plane#473](https://github.com/jinwon-int/a2a-plane/issues/473) — adopted split-repo topology decision.
- [a2a-plane#478](https://github.com/jinwon-int/a2a-plane/issues/478) — public-source security, secret-history, license, and provenance scan groundwork.
- [a2a-plane#479](https://github.com/jinwon-int/a2a-plane/issues/479) — release, version, and provenance checklist groundwork.
- [a2a-plane#480](https://github.com/jinwon-int/a2a-plane/issues/480) — local public demo and quickstart scenario.

See [`docs/public-readiness.md`](docs/public-readiness.md) for the full readiness gate record.
See [`docs/current-state.md`](docs/current-state.md) for the live issue index and completed #506/#511/#513/#514/#515 groundwork.

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

The mirror repositories are unchanged, not archived, and retain their own closed issue/PR history. See the [topology decision record](docs/topology-decision-record.md) for the historical split-repo topology that preceded the canonical flip.

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

- changing repository visibility
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

Historical completed trackers:

- [#506](https://github.com/jinwon-int/a2a-plane/issues/506) — current-state integration and A2A effectiveness wave.
- [#507](https://github.com/jinwon-int/a2a-plane/issues/507) — current-state docs and checkout hygiene.
- [#508](https://github.com/jinwon-int/a2a-plane/issues/508) — no-live cross-repo integration smoke spec.
- [#511](https://github.com/jinwon-int/a2a-plane/issues/511) — monorepo re-entry decision. Decision recorded in [`docs/monorepo-reentry-decision.md`](docs/monorepo-reentry-decision.md).
- [#513](https://github.com/jinwon-int/a2a-plane/issues/513) — monorepo import rehearsal and mirror freshness checks. Plan recorded in [`docs/monorepo-import-rehearsal.md`](docs/monorepo-import-rehearsal.md).
- [#514](https://github.com/jinwon-int/a2a-plane/issues/514) — monorepo CI parity and package boundary matrix. Matrix recorded in [`docs/monorepo-ci-parity-matrix.md`](docs/monorepo-ci-parity-matrix.md).
- [#515](https://github.com/jinwon-int/a2a-plane/issues/515) — monorepo docs, CODEOWNERS, and issue-routing policy. Drafts recorded in [`docs/migration.md`](docs/migration.md), [`docs/operators.md`](docs/operators.md), [`docs/developers.md`](docs/developers.md), [`docs/issue-routing.md`](docs/issue-routing.md), and [`.github/CODEOWNERS`](.github/CODEOWNERS).
- [#534](https://github.com/jinwon-int/a2a-plane/issues/534) — monorepo phase-3 package CI gate before package mirror refresh. Gate recorded in [`fixtures/current-state/monorepo-phase3-package-ci-gate.json`](fixtures/current-state/monorepo-phase3-package-ci-gate.json).
- [#473](https://github.com/jinwon-int/a2a-plane/issues/473) — adopted topology decision. Decision recorded in [`docs/topology-decision-record.md`](docs/topology-decision-record.md).
- [#477](https://github.com/jinwon-int/a2a-plane/issues/477) — public repo map and umbrella docs. Merged via #484.
- [#478](https://github.com/jinwon-int/a2a-plane/issues/478) — public-source security, secret-history, license, and provenance scan groundwork.
- [#479](https://github.com/jinwon-int/a2a-plane/issues/479) — release, version, and provenance checklist groundwork.
- [#480](https://github.com/jinwon-int/a2a-plane/issues/480) — local public demo and quickstart scenario.

## Five-minute local quickstart

Start with the local-only quickstart:

- [`docs/quickstart/public-umbrella.md`](docs/quickstart/public-umbrella.md)
- [`docs/quickstart.md`](docs/quickstart.md)

The quickstart is designed as the external-reader path for a disposable local A2A Nexus broker and dummy/echo worker. If your checkout does not yet include the runnable broker or worker scripts described there, treat that as a documented blocker rather than substituting production services.

## Promotion and release prep

Draft A2A Nexus announcement text and repository metadata recommendations live in [`docs/promotion-announcement.md`](docs/promotion-announcement.md). Keep that copy alpha/feedback-welcome and do not post it until public-readiness gates are closed and an operator explicitly approves promotion/announcement; any future visibility transfer or visibility change remains separately approval-gated.

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

Canonical source now lives in this repository's `packages/*`. The former split implementation repositories remain active provenance mirrors (unchanged, not archived), not canonical sources:

- `jinwon-int/a2a-broker` → mirror of `packages/broker`
- `jinwon-int/openclaw-plugin-a2a` → mirror of `packages/openclaw-plugin-a2a`
- `jinwon-int/a2a-docker-runner` → mirror of `packages/docker-runner`

## Verification

For local validation, use:

```bash
npm ci --ignore-scripts --include=dev
npm run check
```

The check script validates layout, package metadata, and public-readiness scan rules.


## Spec-first A2A changes

A2A Nexus uses a lightweight spec-first protocol for medium and large development/operations changes. Start with `docs/a2a-constitution.md`, then use the templates in `docs/spec-templates/` for feature specs, implementation plans, and task/evidence checklists.

This process is documentation-only in its initial adoption phase and does not change runtime behavior or authorize deploy/restart/canary/DB/replay/release actions.
