# R3 Secret / History Scan Disposition

Status: **historical public-visibility gate record**. Repository visibility is now public as of 2026-05-27; the residual actions below are promotion/stable-release hygiene, not active visibility blockers.

This document records redacted metadata only. Do not add secret values, private keys, session cookies, provider IDs, raw transcripts, or full private endpoint values here.

## Source and scope

- Parent issue: `a2a-plane#12 (internal tracker, private)`
- Team1 safety lane: `a2a-plane#13 (internal tracker, private)`
- Current monorepo checks after PRs `#20`, `#21`, and `#22`:
  - `npm ci --ignore-scripts --include=dev`
  - `npm run check`
  - root public-readiness scan: ok / no secret-shaped findings

Repos considered for R3 public-readiness:

| Repo | Intended public exposure model | Disposition |
|---|---|---|
| `a2a-plane (internal tracker, private)` | Public alpha repository | Current tree can be sanitized incrementally; future promotion/stable-release still requires redacted scanner evidence. |
| `jinwon-int/a2a-broker` | Source reference only | Original private history must not be made public as-is. Use sanitized/squash import content only. |
| `jinwon-int/openclaw-plugin-a2a` | Source reference only | Original private history must not be made public as-is. Use sanitized/squash import content only. |
| `jinwon-int/a2a-docker-runner` | Source reference only | Original private history must not be made public as-is. Use sanitized/squash import content only. |

## Current monorepo disposition

The root scanner currently blocks obvious runtime/bootstrap files and token-shaped values. After the merged Team1 recovery PRs, it reports no findings.

A broader redacted inventory still finds public-readiness review classes in imported docs/tests/examples:

| Class | Current-tree disposition | Required action before promotion/stable-release |
|---|---|---|
| Secret assignment / token shape | No current root scanner findings after #21 sanitization | Keep root gate enabled; re-run with an external secret scanner before promotion/stable-release review. |
| Private endpoint / topology terms | Present in imported historical docs, tests, examples, and package metadata | Replace public docs/examples with neutral placeholders or explicitly mark files as private/internal-only and exclude them from public package/readme claims. |
| Absolute private paths | Present in runner/plugin/broker tests and fixture strings | Replace with placeholder paths where tests permit; document test-only fixtures if behavior requires POSIX path shapes. |
| Original source histories | Not part of the intended public artifact | Keep source repos private; publish only sanitized/squash monorepo history. |

## Redacted findings already recorded

The initial Team1 scan on `#13` recorded only metadata categories and paths. It did not print secret values.

Representative source-history blocker classes:

- token-shaped fixture strings in source repo tests and script tests,
- private endpoint/topology strings in broker request/security tests and docs,
- absolute private paths in task/event tests, runner config tests, and examples,
- runtime/bootstrap context files confirmed excluded from branch artifacts.

## Closeout checklist for `#13`

- [x] `a2a-plane (internal tracker, private)` is public as of 2026-05-27; future promotion or publication still needs explicit approval.
- [ ] Confirm source repos are **not** made public as-is.
- [ ] Replace or disposition private topology strings in public-facing docs and examples.
- [ ] Replace or disposition absolute private path fixtures.
- [ ] Run an external secret scanner when available (`gitleaks`, `trufflehog`, or equivalent) against the final candidate tree.
- [ ] Re-run root `npm run check` and the redacted readiness inventory.
- [ ] Add final PR/issue evidence with only redacted metadata.
- [ ] Obtain explicit operator approval before any future repository visibility transfer, promotion, publication, or release action.

## Safety boundary

This disposition does not authorize repository visibility transfers, promotion, release, production deploys, Gateway restarts, production database mutations, live provider/Telegram sends, terminal-outbox ACK mutation, secret rotation, secret disclosure, history rewrite, or force push.
