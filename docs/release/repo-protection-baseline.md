# Public A2A Repository Protection Baseline

Issues: [a2a-plane#488](https://github.com/jinwon-int/a2a-plane/issues/488)
Parent: [a2a-plane#473](https://github.com/jinwon-int/a2a-plane/issues/473)
Related: [a2a-plane#486](https://github.com/jinwon-int/a2a-plane/issues/486) (contribution surface and CI hardening)

This document records the current repository protection state across the four public A2A repositories and proposes a minimal baseline for public repository protection. It is a read-only evidence document and does not authorize GitHub settings changes, branch protection changes, ruleset creation, permission changes, or any other GitHub repository administration action.

## Safety boundary

This document is read-only guidance. It does not authorize:

- Creating or modifying branch protection rules or rulesets in any repository
- Changing repository visibility, collaborators, or team permissions
- Creating, moving, or deleting tags or releases
- Publishing npm/Docker packages or changing package visibility
- Production deployments or Gateway/broker/worker restarts
- Production database mutation or terminal-outbox ACK mutation
- Live provider or Telegram sends
- Secret rotation or disclosure
- History rewrite or force push

Every action below requires separate explicit operator approval naming the exact action, repository, and scope.

---

## 1. Evidence collection method

Protection-state evidence was collected on **2026-05-28 KST** via:

- `gh api repos/jinwon-int/<repo>/branches/main/protection` — branch protection API (404 = no protection)
- `gh api repos/jinwon-int/<repo>/rulesets` — rulesets API (empty array = no rulesets)
- `gh api repos/jinwon-int/<repo>/contents` — file-content checks for CODEOWNERS, issue templates, PR templates
- `gh repo view` — visibility and metadata checks
- `git ls-files` — local file presence checks within the a2a-plane checkout

All evidence is redacted to commands, exit statuses, and finding counts only. No matched secret values, provider identifiers, Telegram IDs, raw session dumps, or private endpoints are included.

---

## 2. Current protection-state matrix

### 2.1 Branch protection (main branch)

| Repo | Branch protection | Status checks | PR review requirement | Rulesets |
|---|---|---|---|---|
| `jinwon-int/a2a-plane` | **None** (API returned 404) | N/A | N/A | **None** (empty array) |
| `jinwon-int/a2a-broker` | **Present** | Required `build`, strict/up-to-date enabled | **None** | **None** (empty array) |
| `jinwon-int/a2a-docker-runner` | **Present** | Required `build`, strict/up-to-date enabled | **None** | **None** (empty array) |
| `jinwon-int/openclaw-plugin-a2a` | **Present** | Required `build`, strict/up-to-date enabled | **None** | **None** (empty array) |

**Finding:** `a2a-plane` has no branch protection on the default (`main`) branch. The other three repos have a minimal `build` status-check protection, but still have no required PR review. None of the four repos has rulesets defined. `openclaw-plugin-a2a` additionally has linear-history and conversation-resolution protection enabled; `a2a-broker` and `a2a-docker-runner` do not.

### 2.2 CODEOWNERS presence

| Repo | CODEOWNERS | Content |
|---|---|---|
| `jinwon-int/a2a-plane` | ✅ **Present** at root | `* @jinon86` (interim owner, noted as not a public maintainer roster) |
| `jinwon-int/a2a-broker` | ❌ **Missing** (API returned 404) | N/A |
| `jinwon-int/a2a-docker-runner` | ❌ **Missing** (API returned 404) | N/A |
| `jinwon-int/openclaw-plugin-a2a` | ❌ **Missing** (API returned 404) | N/A |

**Finding:** Only `a2a-plane` has a CODEOWNERS file. The other three repos have no CODEOWNERS, which means no automatic review assignment and no path-based ownership for repository settings.

### 2.3 Issue and pull request templates

| Repo | Issue templates | PR template |
|---|---|---|
| `jinwon-int/a2a-plane` | ✅ Present (`.github/ISSUE_TEMPLATE/` with bug report, spec-first change, readiness task, and config) | ✅ Present (`.github/pull_request_template.md` with safety checklist) |
| `jinwon-int/a2a-broker` | ❌ **Missing**: no `.github/` directory found | ❌ **Missing** |
| `jinwon-int/a2a-docker-runner` | ❌ **Missing**: no `.github/` directory found | ❌ **Missing** |
| `jinwon-int/openclaw-plugin-a2a` | ❌ **Missing**: no `.github/` directory found | ❌ **Missing** |

**Finding:** Only `a2a-plane` has issue and PR templates. The other three repos have no `.github/` directory at all, meaning contributors filing issues or PRs in those repos see no standardized guidance or safety checklists.

### 2.4 CI workflow coverage

| Repo | Workflow files | Coverage notes |
|---|---|---|
| `jinwon-int/a2a-plane` | `ci.yml` (in the a2a-plane checkout; part of this repo) | Includes `npm test` and `npm run test:release-gate` |
| `jinwon-int/a2a-broker` | `ci.yml` | Runs `npm test` |
| `jinwon-int/a2a-docker-runner` | `ci.yml`, `release-gate.yml` | Runs npm checks and release-gate |
| `jinwon-int/openclaw-plugin-a2a` | `ci.yml` | Runs public-readiness scan, conformance smoke, and tests |

**Finding:** All four repos have CI workflows. However, only `a2a-plane` and `openclaw-plugin-a2a` currently integrate public-readiness or release-safety scans into CI. `a2a-broker` does not run public-readiness scans in its normal PR/push CI gate.

### 2.5 Security, contributing, and community files

| Repo | LICENSE | SECURITY.md | CONTRIBUTING.md | CODE_OF_CONDUCT |
|---|---|---|---|---|
| `jinwon-int/a2a-plane` | ✅ MIT | ✅ Present | ✅ Present | ❌ Not found |
| `jinwon-int/a2a-broker` | ❌ Missing (no GitHub-detected license) | Not checked in this audit | Not checked | Not checked |
| `jinwon-int/a2a-docker-runner` | ✅ MIT | Not checked | Not checked | ✅ Present (from issue #486) |
| `jinwon-int/openclaw-plugin-a2a` | ❌ Missing (no GitHub-detected license) | Not checked | Not checked | ❌ Missing (from issue #486) |

> License and community file coverage for broker/runner/plugin is tracked separately in issues [#478](https://github.com/jinwon-int/a2a-plane/issues/478), [#479](https://github.com/jinwon-int/a2a-plane/issues/479), and [#486](https://github.com/jinwon-int/a2a-plane/issues/486).

---

## 3. Proposed minimal public repository protection baseline

This baseline applies to all four public A2A repositories. It is divided into three tiers:

- **Tier 1: File-representable** — protections that can be added via repo-file commits (PRs) without GitHub settings changes
- **Tier 2: Settings-change (requires operator approval)** — GitHub settings that require owner/ admin permissions
- **Tier 3: Aspirational** — recommended for stability but not required for the initial protection baseline

### 3.1 Tier 1: File-representable protections

These can be proposed in PRs and reviewed normally. They require no GitHub admin permissions.

| # | Protection | Where | Priority | Prerequisite/Link |
|---|---|---|---|---|
| 1.1 | CODEOWNERS for each repo | Root `CODEOWNERS` | High | Needs maintainer team decided per repo; track in [#486](https://github.com/jinwon-int/a2a-plane/issues/486) |
| 1.2 | Issue templates | `.github/ISSUE_TEMPLATE/` | High | Broker/runner/plugin are missing all templates; can copy simplified versions from a2a-plane |
| 1.3 | PR template with safety checklist | `.github/pull_request_template.md` | High | Broker/runner/plugin are missing; a2a-plane template can serve as reference |
| 1.4 | SECURITY.md | Root `SECURITY.md` | Medium | Broker/runner/plugin may need their own or can reference a2a-plane |
| 1.5 | CONTRIBUTING.md | Root `CONTRIBUTING.md` | Medium | Broker/runner/plugin may need their own or can reference a2a-plane |
| 1.6 | Public-readiness CI check | `.github/workflows/ci.yml` | Medium | Wire `npm run scan:public-readiness` or equivalent into broker CI (tracked in [#486](https://github.com/jinwon-int/a2a-plane/issues/486)) |
| 1.7 | Repo protection baseline check | Integration into release-gate pipeline | Medium | Added in this PR for a2a-plane; other repos should adopt equivalent check |

### 3.2 Tier 2: Settings-change protections (requires operator approval)

These require GitHub repository settings changes (owner/admin access). They must not be applied without separate explicit operator approval.

| # | Protection | Description | Approval needed |
|---|---|---|---|
| 2.1 | Protected default branch (`main`) | Require status checks to pass before merging | Operator approval naming exact repo and branch |
| 2.2 | Required pull request review | Require at least one approved review before merge | Operator approval naming exact repo and minimum reviewer count |
| 2.3 | Dismiss stale reviews | When new commits are pushed, dismiss approving reviews | Operator approval |
| 2.4 | Require up-to-date branches | Require branch to be up to date with base before merging | Operator approval |
| 2.5 | Include administrators | Apply branch protection to admins too | Operator approval |
| 2.6 | Rulesets for critical paths | Rulesets for paths like `.github/workflows/`, `packages/`, `scripts/` | Operator approval per ruleset |
| 2.7 | `CODEOWNERS` review requirement | Require CODEOWNERS review for matching paths | Implied by CODEOWNERS presence + required reviews (2.2) |
| 2.8 | Linear history | Require squash merging or rebase merging | Operator approval |
| 2.9 | Signed commits | Require commits to be signed | Operator approval |
| 2.10 | Restrict push access | Limit who can push to `main` | Operator approval |

### 3.3 Tier 3: Aspirational protections

| # | Protection | Notes |
|---|---|---|
| 3.1 | Dependency review / Dependabot | Requires Dependabot setup and status-check integration |
| 3.2 | Secret scanning push protection | GitHub Advanced Security feature |
| 3.3 | Automatic deletion of head branches | Available in repo settings |
| 3.4 | Tag protection rules | Requires admin to create tag rulesets |
| 3.5 | Release artifact attestation | For npm/Docker publication readiness (tracked in [#479](https://github.com/jinwon-int/a2a-plane/issues/479)) |

---

## 4. Which protections are file-representable vs. GitHub-settings-only

| Protection | File-representable? | Settings-only? | Notes |
|---|---|---|---|
| CODEOWNERS | ✅ Yes | No | File at `CODEOWNERS`; but requiring CODEOWNERS review requires branch protection set in GitHub settings |
| Issue templates | ✅ Yes | No | `.github/ISSUE_TEMPLATE/` directory |
| PR template | ✅ Yes | No | `.github/pull_request_template.md` |
| SECURITY.md | ✅ Yes | No | Root file |
| CONTRIBUTING.md | ✅ Yes | No | Root file |
| CI workflow content | ✅ Yes | No | `.github/workflows/` files |
| Branch protection | ❌ No | ✅ Yes | Requires admin/owner via GitHub settings UI or API |
| Required status checks | ❌ No | ✅ Yes | Requires admin/owner |
| Required PR reviews | ❌ No | ✅ Yes | Requires admin/owner |
| Rulesets | ❌ No | ✅ Yes | Requires admin/owner |
| Dismiss stale reviews | ❌ No | ✅ Yes | Requires admin/owner |
| Linear history | ❌ No | ✅ Yes | Requires admin/owner |
| Signed commits | ❌ No | ✅ Yes | Requires admin/owner |
| Restrict push access | ❌ No | ✅ Yes | Requires admin/owner |

---

## 5. Settings-change approval checklist

When an operator is ready to approve GitHub settings changes, the following checklist must be completed and linked from the approval comment. Each checkbox requires an explicit approver action, not a generic "looks good."

### Pre-approval preparation

- [ ] The operator has reviewed the Tier 2 protection table in this document (section 3.2).
- [ ] The operator has decided which Tier 2 protections apply to each specific repository.
- [ ] Approval text explicitly lists:
  - Repository name(s)
  - Exact protection(s) to apply (e.g., "require PR review on main branch of a2a-broker")
  - Whether the change applies to admins
  - Separated approval: not bundled with any deploy, publish, visibility change, credential move, or history rewrite

### Approval conditions

- [ ] Approval is a separate comment in the issue or PR — not inferred from green CI, merged docs PRs, or generic "looks good" phrasing.
- [ ] Approval names the exact repository settings that may be changed.
- [ ] Approval confirms no deploy, restart, DB mutation, provider send, terminal ACK, secret change, history rewrite, or force-push is bundled.

### Post-approval execution

If the operator has granted approval in a linked comment, the executing person or automation must:

- [ ] Apply only the protections named in the approval.
- [ ] Record the exact settings change (e.g., via `gh api` command or GitHub UI screenshot(s), redacted if needed).
- [ ] Verify the change took effect (e.g., re-query protection API and show result).
- [ ] Link the evidence back to the approval comment.

---

## 6. Gap tracking

| Gap | Repos affected | Tracked in | Current status |
|---|---|---|---|
| Missing CODEOWNERS | broker, runner, plugin | [#486](https://github.com/jinwon-int/a2a-plane/issues/486) | Open |
| Missing issue/PR templates | broker, runner, plugin | [#486](https://github.com/jinwon-int/a2a-plane/issues/486) | Open |
| Missing broker public-readiness CI check | broker | [#486](https://github.com/jinwon-int/a2a-plane/issues/486) | Open |
| Missing license metadata (package/license fields) | broker, plugin | [#478](https://github.com/jinwon-int/a2a-plane/issues/478), [#479](https://github.com/jinwon-int/a2a-plane/issues/479) | Open |
| No branch protection on main | a2a-plane | This issue (#488) — awaiting operator approval | Open / Waiting for approval |
| No required PR review | all | This issue (#488) — awaiting operator approval | Open / Waiting for approval |
| No rulesets | all | This issue (#488) — awaiting operator approval | Open / Waiting for approval |

---

## 7. Current decision

Decision: **baseline documented; settings changes NO-GO / waiting for approval.**

- Current protection-state evidence is recorded (section 2).
- Proposed baseline is explicit and testable (section 3).
- All four repos are PUBLIC. `a2a-plane` has **no branch protection**; `a2a-broker`, `a2a-docker-runner`, and `openclaw-plugin-a2a` have minimal required-`build` branch protection. All four repos have **no rulesets** and **no required PR review**.
- CODEOWNERS, templates, and CI gaps in broker/runner/plugin are tracked in [#486](https://github.com/jinwon-int/a2a-plane/issues/486).
- Any GitHub settings or permission changes are held until separate explicit operator approval using the checklist in section 5.

This deliverable does not authorize:

- Creating or modifying branch protection rules or rulesets
- Changing repository visibility, collaborators, or team permissions
- Creating, moving, or deleting tags or releases
- Publishing npm/Docker packages
- Deploying, restarting, mutating production data, sending live messages, or rotating secrets
- Rewriting history or force-pushing
