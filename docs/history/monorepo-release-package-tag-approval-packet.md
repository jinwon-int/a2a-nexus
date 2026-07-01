# A2A Monorepo Release Package Tag Approval Packet

> **Snapshot date:** 2026-06-08
> **Parent:** a2a-plane#511 (a2a-plane#511, internal tracker private)
> **Phase-7 disposition packet:** a2a-plane#546 (a2a-plane PR #546, internal tracker private)
> **Phase-8 release/package/tag packet:** a2a-plane#547 (a2a-plane#547, internal tracker private)
> **Phase-9 final sign-off matrix:** a2a-plane#549 (a2a-plane#549, internal tracker private)
> **Status:** approval packet and dry-run inventory only; release, tag, publish, package ownership, and canonical flip remain `NO_GO / Waiting`.

## Summary

The monorepo now contains tracked-tree package candidates for broker,
docker-runner, and OpenClaw plugin, but none of those package candidates is
approved as a release source. This packet records the package, release, tag,
Docker, and rollback approval fields that must be answered before any
publication or canonical ownership transfer.

Current decision:

```text
releaseTagDecision = NO_GO / Waiting
githubReleaseDecision = NO_GO / Waiting
npmPublishDecision = NO_GO / Waiting
dockerPublishDecision = NO_GO / Waiting
packageOwnershipDecision = NO_GO / Waiting
canonicalFlipDecision = NO_GO / Waiting
```

## Candidate Package And Artifact Inventory

This inventory is source-only. It records package metadata and scripts from
the monorepo candidate tree; it does not create release artifacts or publish.

| Surface | Package name | Version | Private | Candidate publish surface | Dry-run command |
| --- | --- | --- | --- | --- | --- |
| Broker | `a2a-broker` | `0.1.0` | `true` | No npm publish while private; Docker candidate only via separate approval. | `npm --workspace packages/broker run build` |
| Docker runner | `@openclaw/a2a-docker-runner` | `0.1.0` | `false` | npm package with `a2a-docker-runner` bin; no publish approved. | `npm --workspace packages/docker-runner run verify:package` |
| OpenClaw plugin | `plugin-a2a` | `0.1.0` | `true` | Plugin package metadata only; no npm publish approved while private. | `npm --workspace packages/openclaw-plugin-a2a run prepack` |

Docker/GHCR publication remains blocked. The monorepo contains
`packages/broker/Dockerfile` and `packages/broker/docker-compose.yml`; those
are build/run assets, not publication approval.

## Approval Fields

No approval field is granted by this packet.

| Field | Required before execution | Current status |
| --- | --- | --- |
| `tagName` | Exact tag name, tag target, signing policy, and whether historical tags are immutable. | Not assigned. |
| `githubRelease` | Repository, tag, release title/body, prerelease/draft flag, artifacts, and rollback owner. | Not assigned. |
| `npmPublish` | Package name, version, registry, access level, provenance setting, dist-tag, token owner, and rollback owner. | Not assigned. |
| `dockerPublish` | Image name, registry, tags, build context, provenance/SBOM policy, and rollback owner. | Not assigned. |
| `packageOwnershipTransfer` | Canonical owner, split repo disposition, package owner, and conflict policy. | Not assigned. |
| `rollbackOwner` | Owner for tag deletion policy, release yank, npm deprecate/unpublish policy, Docker tag rollback, and split repo hotfix fallback. | Not assigned. |

## Historical Provenance

The historical `source-public-20260511` tag remains provenance only. Do not
move, delete, or reuse it. No new tag or release is created by this packet.

## GO / NO-GO Fields

| Field | Value |
| --- | --- |
| `packageInventoryRecorded` | `true` |
| `approvalFieldsRecorded` | `true` |
| `dryRunCommandsRecorded` | `true` |
| `tagApproved` | `false` |
| `githubReleaseApproved` | `false` |
| `npmPublishApproved` | `false` |
| `dockerPublishApproved` | `false` |
| `packageOwnershipTransferApproved` | `false` |
| `rollbackOwnerAssigned` | `false` |
| `canonicalFlipApproved` | `false` |
| `decision` | `NO_GO / Waiting` |

## Required Follow-up Before Execution

A future execution approval must name the exact package/image/tag/release,
version, registry, artifact provenance, rollback owner, and whether split repos
remain canonical, mirrored, read-only, or archived. The approval must be
separate from this source-only packet.

The next source-only gate is `a2a-plane#549`, which records the final operator
sign-off matrix across branch protection, split repo disposition,
release/package/tag, package ownership transfer, rollback owner, and canonical
flip GO/NO-GO fields. It does not approve release/package/tag execution.

## No-live Boundary

This packet does not authorize release tag creation, tag movement, GitHub
Release creation, npm publication, Docker or GHCR publication, package
ownership transfer, canonical flip, split repo archive/read-only/redirect
changes, branch protection application, ruleset application, permission
changes, CODEOWNERS enforcement changes, repository visibility changes,
production deploys, Gateway/broker/worker restarts, database mutation,
provider or Telegram sends, Terminal ACK/replay, historical replay, credential
movement, destructive cleanup, force-push, history rewrite, or worker-owned
GitHub mutation.
