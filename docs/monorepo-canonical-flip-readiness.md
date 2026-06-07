# A2A Monorepo Canonical Flip Readiness Packet

> **Snapshot date:** 2026-06-08
> **Parent:** [a2a-plane#511](https://github.com/jinwon-int/a2a-plane/issues/511)
> **Phase-4 import candidate:** [a2a-plane#538](https://github.com/jinwon-int/a2a-plane/issues/538)
> **Phase-4 PR:** [a2a-plane#540](https://github.com/jinwon-int/a2a-plane/pull/540)
> **Phase-5 readiness gate:** [a2a-plane#541](https://github.com/jinwon-int/a2a-plane/issues/541)
> **Phase-6 branch protection packet:** [a2a-plane#543](https://github.com/jinwon-int/a2a-plane/issues/543)
> **Phase-7 disposition packet:** [a2a-plane#545](https://github.com/jinwon-int/a2a-plane/issues/545)
> **Status:** readiness packet only; canonical flip is still `NO_GO / Waiting`.

## Summary

The phase-4 fresh tracked-tree import candidate is now merged into `main`, but
it is not a canonical ownership transfer. This packet records the evidence a
later operator decision needs before `a2a-plane/packages/*` can become
authoritative implementation source.

Current decision:

```text
canonicalFlipDecision = NO_GO / Waiting
canonicalImplementationSource = split_repos
readinessPacket = recorded
```

## Imported Package Candidate

`a2a-plane#540` merged as
`31273ce05b7e53655e3d8847a8d77ff1cd2f6d05` with head
`a35f379840a768acf5bcb4656c0b1f26a7e05e19`.

| Surface | Source ref | Target path | Import mode | Status |
| --- | --- | --- | --- | --- |
| Broker | `jinwon-int/a2a-broker@f9f4af5a76649a37b8a3d492805b6e5f410683a6` | `packages/broker` | tracked-tree `git archive` import | Package parity CI green; not canonical |
| Docker runner | `jinwon-int/a2a-docker-runner@269a0ef90737158b41f8da26241b9f7f4b14af5e` | `packages/docker-runner` | tracked-tree `git archive` import | Package parity CI green; not canonical |
| OpenClaw plugin | `jinwon-int/openclaw-plugin-a2a@a2e521271483ef0b6a29907c8228f0a442dd2db9` | `packages/openclaw-plugin-a2a` | tracked-tree `git archive` import | Package parity CI green; not canonical |

The import is not history-preserving. Closed issues, closed PRs, tags, and
release provenance remain in the split implementation repositories until a
separate archival/provenance plan is approved.

## CI Evidence

GitHub Actions run `27099159202` on the #540 head passed:

- `paths-filter`
- `setup`
- `contracts`
- `layout`
- `broker`
- `plugin`
- `docker-runner`
- `check`

The `docs` job was skipped by path filter. The `check` job completed root
`npm run check`, `check:quickstart-conformance`,
`check:external-harness-conformance`, and `test:release-gate`.

This is enough to say the imported package candidate is package-CI green. It is
not enough to approve canonical ownership transfer.

## Provenance Policy

Until a future canonical-flip decision says otherwise:

- split repos remain the canonical history and issue/PR provenance store;
- future package changes that depend on pre-#540 history must cite the split
  repo and source ref;
- `a2a-plane` package paths may be used for readiness evidence and PR-gated
  rehearsals, but not as the sole implementation truth;
- closed split-repo issues and PRs are not re-created in `a2a-plane`;
- tags such as `source-public-20260511` are historical provenance and must not
  be moved or reused.

## Rollback Path

If the package candidate regresses before a canonical flip, rollback is a
normal PR revert of the #540 merge commit or a follow-up PR that restores the
last known green package tree. No split repo rollback is needed because split
repos remain canonical.

Before a future canonical flip can be approved, the operator packet must record:

- exact merge commit or package tree being accepted;
- required checks and their most recent green run;
- branch protection and review posture for `a2a-plane/main`;
- split repo disposition: active, archived, read-only, or mirrored;
- release/package/tag policy;
- rollback owner and revert path;
- remaining accepted risks.

## Remaining Gates

The canonical flip gate stays closed until all of these are true or explicitly
accepted as risk in a separate operator approval:

| Gate | Current status |
| --- | --- |
| Package parity on imported tree | Green in #540 CI |
| Root release gate on imported tree | Green in #540 CI |
| Provenance packet | Recorded by #541 |
| Branch protection/ruleset change | Not approved, not performed |
| Release/package/tag policy execution | Not approved, not performed |
| Split repo archival or read-only disposition | Not approved, not performed |
| Operator canonical-flip approval | Missing |

Follow-up `a2a-plane#543` records the branch protection approval packet and
required-checks dry-run. It does not apply branch protection or rulesets; it
keeps the canonical flip at `NO_GO / Waiting`.

Follow-up `a2a-plane#545` records the split-repo disposition and rollback owner
packet. It does not archive, redirect, or make any split repository read-only;
split repos remain canonical while rollback owner and accepted-risk fields are
still undecided.

## GO / NO-GO Fields

| Field | Value |
| --- | --- |
| `packageParityGreen` | `true` |
| `rootGateGreen` | `true` |
| `provenancePolicyRecorded` | `true` |
| `rollbackPathRecorded` | `true` |
| `branchProtectionReady` | `false` |
| `releasePackagePolicyReady` | `false` |
| `splitRepoDispositionApproved` | `false` |
| `operatorCanonicalFlipApproval` | `false` |
| `decision` | `NO_GO / Waiting` |

## No-live Boundary

This packet does not authorize canonical flip, package ownership transfer,
branch protection or ruleset changes, release tags, GitHub Releases, npm or
Docker publication, repository visibility changes, split repo archival,
production deploys, Gateway/broker/worker restarts, database mutation,
provider or Telegram sends, Terminal ACK/replay, historical replay, credential
movement, destructive cleanup, force-push, history rewrite, or worker-owned
GitHub mutation.
