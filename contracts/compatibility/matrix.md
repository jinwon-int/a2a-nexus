# A2A Plane Compatibility Matrix

This matrix records A2A Plane public split-repo baselines and the older
monorepo/umbrella import baselines. Public-facing compatibility claims must not
exceed the evidence here. OpenClaw entries describe the first/reference
integration only; they are not a claim that A2A Plane is an OpenClaw-only
project.

## Public split-repo promotion snapshot

The public implementation boundary is the split repository set while
[`a2a-plane#473`](https://github.com/jinwon-int/a2a-plane/issues/473) remains
the umbrella/topology tracker. The `source-public-20260511` markers are source
review markers only; they are not semantic version tags, GitHub Releases, npm
publication markers, Docker/image publication markers, or release approvals.

| Repository | Public source role | Current `main` baseline | CI evidence | `source-public-20260511` marker | Promotion status |
|---|---|---|---|---|---|
| [`a2a-plane`](https://github.com/jinwon-int/a2a-plane) | Start-here umbrella, contracts, public readiness and release gates | `5b4f7f1e0616fba2810144e9a4ab7bbab4f1d488` | Main CI run [`26525239513`](https://github.com/jinwon-int/a2a-plane/actions/runs/26525239513) succeeded. | `83bc1519ebc4b45d9c1ddc4be2a9011fb4b210b4` | Source-public docs/provenance updated by #483; product release remains **NO-GO / waiting**. |
| [`a2a-broker`](https://github.com/jinwon-int/a2a-broker) | Broker runtime and AgentCard/profile surface | `2609c8ddab8948512aa688f057f5c5267512ba1e` | Main CI run [`26524535942`](https://github.com/jinwon-int/a2a-broker/actions/runs/26524535942) succeeded. | `929a1a8eeb2d242115589b8d701a4e097ff7598d` | Public source is visible; package/release posture remains **NO-GO / waiting** until #486 and broker#951/#952 evidence is complete. |
| [`openclaw-plugin-a2a`](https://github.com/jinwon-int/openclaw-plugin-a2a) | OpenClaw reference plugin and diagnostics surface | `345a2dda01291865dbce6c1d9b89371dc688bfd6` | Main CI run [`26437367093`](https://github.com/jinwon-int/openclaw-plugin-a2a/actions/runs/26437367093) succeeded. | `b474c63f76abc63986f6e49054b39726cead44e9` | Public source is visible; protocol diagnostics and package-public posture remain **NO-GO / waiting** until plugin#454 and #486 evidence is complete. |
| [`a2a-docker-runner`](https://github.com/jinwon-int/a2a-docker-runner) | Local evidence runner and sample execution harness | `70c8ad078fd9dd4da346189cd4c8cfad480e71cb` | Main CI run [`26481858759`](https://github.com/jinwon-int/a2a-docker-runner/actions/runs/26481858759) succeeded. | `f17072e5c2c40cf5d0ba7fc277ccd76e4d856a31` | Public source is visible; release/tag and package/image publication remain **NO-GO / waiting** until #485 and runner#343 evidence is complete. |

Use the current `main` baselines for public promotion discussion and issue
routing. Use the source-public marker column only when a reviewer needs to
trace the earlier source-public snapshot.

## Monorepo import baselines

These rows identify the sanitized import baselines in this umbrella repository.
They do not supersede the split-repo `main` baselines above.

| Component | Source | Candidate path | Current baseline | Required evidence before public release | Notes |
|---|---|---|---|---|---|
| Broker | `jinwon-int/a2a-broker` | `packages/broker` | `a6096882a781fb13c68ec526fee897a00724f9a0` | package build/test, public-readiness scan, contract docs review | A2A Plane broker service imported by sanitized/squash copy; no private git history preserved. |
| OpenClaw plugin | `jinwon-int/openclaw-plugin-a2a` | `packages/openclaw-plugin-a2a` | `3c12b937f727a874174b172cf34de65d771177f2` | package build/test, OpenClaw plugin compatibility smoke | First/reference integration imported by sanitized/squash copy for R3 #14. Peer range remains private-candidate only until an exact OpenClaw release/commit is named. |
| Docker runner | `jinwon-int/a2a-docker-runner` | `packages/docker-runner` | `d223612cb027bf493b6b74e60a7bc04db1b9b6ae` | package check/test, public demo safety smoke | Sanitized/squash import for R3 #15. Document Docker/Podman execution, GitHub auth mounts, and network modes as trusted-operator modes. |
| Shared contracts | monorepo | `contracts/a2a` | `r2-initial-contracts` | contract review against broker/plugin/runner behavior | A2A Plane terminal Done/Block/PR semantics and ACK boundaries are public contract candidates. |
| OpenClaw core | upstream fixture | `packages/openclaw-plugin-a2a/test/fixtures/openclaw` | `0.0.0-test-peer` | plugin SDK seam fixture evidence plus explicit release/commit update before any stable public claim | Public docs must distinguish fixture-backed private integration experiments from stable OpenClaw core support. |

## Versioning strategy

Each package in the monorepo follows an independent semver release train:

| Package | npm name | Release tag prefix | Current version |
|---|---|---|---|
| Broker | `a2a-broker` | `broker-v` | `0.1.0` (private) |
| Docker runner | `@openclaw/a2a-docker-runner` | `docker-runner-v` | `0.1.0` (public) |
| OpenClaw plugin | `openclaw-plugin-a2a` | `plugin-v` | `0.1.0` (private) |
| Shared contracts | (monorepo root) | `r23`, `r24`, … | Milestone tag |

Breaking changes within `0.x` do not require a major version bump, but the matrix
row must be updated to the new baseline when a known break occurs. Before any
package declares `1.0.0`, the compatible OpenClaw peer release must be resolved
and linked here.

## Release rule

A public release candidate must update this table with exact source commits/tags for every imported package and link the CI run that validated the candidate commit. Release notes and external docs must introduce the project as A2A Plane and keep OpenClaw framed as the reference integration unless broader integrations have their own evidence rows.
