# Public externalization follow-up closeout evidence

This document records the PR-safe closeout evidence for the public externalization follow-up trackers opened after the A2AD public externalization evaluation.

Related issues:

- [#1172](https://github.com/jinwon-int/a2a-nexus/issues/1172) — contribution intake hardening before broader promotion.
- [#1173](https://github.com/jinwon-int/a2a-nexus/issues/1173) — clone/view traffic anomaly audit before using traffic as promotion evidence.
- [#1174](https://github.com/jinwon-int/a2a-nexus/issues/1174) — homepage/docs-site posture before broader public promotion.

Related A2AD rounds:

- `nexus-open-issues-a2a-process-20260701T084019Z`
  - `issue-1173` was source-backed and substantive.
  - `issue-1172`, `issue-1174`, and `finalizer` were source-projection blocked and were not counted as quorum evidence.
- `nexus-open-issues-a2a-process-r2-20260701T084710Z`
  - `issue-1172` was source-backed and substantive.
  - `issue-1174` and `finalizer` were source-projection blocked and were not counted as quorum evidence.
- `nexus-open-issues-a2a-process-r3-1174-20260701T085251Z`
  - `issue-1174` was source-backed and substantive.

The blocked lanes are recorded as source-projection evidence quality limitations, not as worker consensus.

## Live readback used for this closeout

Checked on 2026-07-01 UTC at repository head `6201b4b6d110bd20d123b21962b05264b1da4b17`:

| Surface | Readback | Decision |
|---|---|---|
| Repository visibility | `PUBLIC` | Public alpha remains valid. |
| GitHub homepage | empty string | Keep blank for now; no metadata mutation in this PR. |
| GitHub latest release | `null` | Stable release remains not claimed. |
| GitHub Discussions | `hasDiscussionsEnabled=false` | Keep disabled for now; enable only with a separate moderation/support decision. |
| GitHub Issue Forms metadata | `issueTemplates=[]`, `isBlankIssuesEnabled=true` | Accepted as a GitHub metadata discrepancy because repo-local Issue Form validation passes. |
| Main branch reviews | one approval required, stale approvals dismissed, `require_code_owner_reviews=false` | Keep CODEOWNERS review optional for now; revisit before broader promotion if stronger review gates are explicitly approved. |
| Main branch checks | `paths-filter`, `setup`, `layout`, `broker`, `docker-runner`, `plugin`, `contracts`, `docs`, `promotion-capstone`, `check` | Existing protection remains the active public-alpha gate. |
| Force push / deletion | disabled | Existing protection remains intact. |

The repository labels referenced by current Issue Forms are present: `bug`, `enhancement`, `a2a-public`, and `promotion-readiness`.

## #1172 contribution intake decision

Decision: **complete the PR-safe part now without GitHub settings mutation**.

- Issue Forms remain repo-local source of truth. The GitHub metadata endpoint still reports `issueTemplates=[]` / `isBlankIssuesEnabled=true`, but repo-local validation shows five template files and four renderable Issue Forms.
- Discussions remain disabled during pre-promotion public alpha. This avoids implying a staffed public support channel before a moderation/support policy is approved.
- CODEOWNERS review remains optional for now. Main already requires one approving review plus strict required checks; making CODEOWNERS review mandatory is a branch-protection settings mutation and should wait for explicit broader-promotion approval.
- PR template safety checks remain the public contribution gate for operator-sensitive actions.

Closeout criterion satisfied by this PR: the decisions above are recorded, the live metadata readback is captured, the repo-local Issue Form/label baseline is verified, and public-readiness gates pass.

## #1173 traffic signal decision

Decision: **classify clone traffic as `uncertain` and exclude it from organic promotion evidence**.

The 14-day GitHub traffic readback showed:

| Metric | Total | Unique |
|---|---:|---:|
| Views | 29 | 17 |
| Clones | 6523 | 643 |

Supporting observations:

- `clones/views = 224.9x` and `clone uniques/view uniques = 37.8x`.
- Popular referrers were only `github.com` with 7 views / 1 unique and `t.co` with 1 view / 1 unique.
- Popular paths were mostly the repository overview.
- External listing PRs were opened on 2026-06-30 and do not explain earlier clone spikes on 2026-06-20 or 2026-06-28.
- GitHub Traffic API does not expose clone IP/user-agent/auth breakdowns, so root cause cannot be proven from repo-visible API data alone.

Policy: future publicization scorecards should prefer conservative traction indicators — views, stars, watchers, public issues/PRs, and external listing outcomes. Clone spikes stay out of promotion claims unless a later approved audit can attribute them to organic external users.

Closeout criterion satisfied by this PR: fresh snapshots and the conservative classification are recorded, and the docs no longer invite use of clone spikes as promotion evidence.

## #1174 homepage/docs-site posture

Decision: **keep the GitHub homepage field blank and continue GitHub README/docs-only public alpha for now**.

Rationale:

- The repo is public alpha, not a stable release.
- No GitHub Release, package publication, Docker/GHCR publication, or stable landing page is approved.
- A blank homepage avoids implying production readiness or a staffed public product surface.
- Setting the GitHub homepage URL is a repository metadata mutation and should happen only after a reviewed public docs/landing page exists and is explicitly approved.

Closeout criterion satisfied by this PR: current homepage state is recorded, the chosen option is documented with rationale, and no repository metadata mutation is performed.

## Boundaries preserved

This closeout does not perform or authorize:

- broad promotion or public launch announcement;
- GitHub Release, tag, npm package, Docker image, or GHCR publication;
- production deploy or Gateway/broker/worker restart;
- provider/Telegram notification or canary send;
- production DB/outbox/ACK/replay mutation;
- secret/credential movement, rotation, or disclosure;
- repository visibility change, history rewrite, or force push;
- GitHub Discussions, homepage, branch-protection, or CODEOWNERS-review settings mutation.

## Remaining open tracker

[#1160](https://github.com/jinwon-int/a2a-nexus/issues/1160) remains open until all three external directory PRs have final outcomes and `docs/external-listings.md` is updated with those outcomes.
