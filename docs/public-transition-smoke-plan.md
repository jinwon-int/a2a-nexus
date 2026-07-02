# Approval-Gated Public Transition Smoke Plan (Historical)

> **Status: transition complete.** `a2a-plane (internal tracker, private)` became public on 2026-05-27. This document records the pre-public checklist that was executed. Sections 3–6 are archived as a rollback reference and future promotion template.
>
> This document does not authorize repository visibility changes, releases, deploys, Gateway/broker/worker restarts, production database mutations, live provider or Telegram sends, terminal-outbox ACKs, secret rotation or disclosure, history rewrites, or force-pushes.

## 0. Approval gate

- [ ] Record the explicit approval from the operator in the operator thread or issue, including timestamp, approver, repository, and approved target visibility.
- [ ] Confirm the approval is for `a2a-plane (internal tracker, private)` only and does not include source repository histories, npm/Docker publishing, releases, deploys, production database work, provider sends, terminal ACKs, secret rotation, history rewrites, or force-pushes.
- [ ] If approval is absent, ambiguous, scoped to a different repository, or bundled with any live action, stop: public visibility remains **NO-GO**.

## 1. Pre-change snapshot

Capture redacted evidence before any visibility change:

- [ ] GitHub repository metadata shows `private: true` for `a2a-plane (internal tracker, private)`.
- [ ] Candidate branch and commit SHA are recorded.
- [ ] `package.json` still declares the monorepo package as private; do not publish packages as part of this checklist.
- [ ] Runtime/bootstrap hygiene is clean for tracked and unignored files: no `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, or `.openclaw/**` paths enter the candidate branch or evidence.
- [ ] Redacted public-readiness evidence is attached; no raw secrets, private host paths, provider IDs, Telegram IDs, or session dumps are included.

## 2. CI, license, and README checks

Run these local checks from the candidate commit and save pass/fail status only:

```sh
npm ci --ignore-scripts --include=dev
npm run check
npm run test:release-gate
node scripts/redacted-readiness-inventory.mjs
```

Also verify:

- [ ] `LICENSE` is present and matches the approved MIT decision.
- [ ] `README.md`, `SECURITY.md`, `.github/ISSUE_TEMPLATE/*`, and `.github/pull_request_template.md` contain public-safe guidance only.
- [ ] `npm run scan:external-secrets` has either passing redacted scanner evidence or a fail-closed Block note that no supported scanner is installed in the operator environment.
- [ ] Any unresolved redacted inventory finding class has explicit operator disposition before visibility changes.

## 3. Human-approved visibility change

Only after Sections 0-2 pass and the operator explicitly approves the exact transition:

- [ ] A human repository administrator changes GitHub visibility for `a2a-plane (internal tracker, private)` from private to public in GitHub settings.
- [ ] The administrator records who performed the change, timestamp, and GitHub metadata evidence showing `private: false` after the change.

Do not use this checklist to publish npm packages, push Docker images, create public releases, deploy services, restart Gateway/broker/worker services, mutate production databases, send provider/Telegram messages, ACK terminal outbox records, rotate/disclose secrets, rewrite history, or force-push.

## 4. Post-change smoke

After visibility changes, run only read-only or local validation:

- [ ] Open the public repository page in a fresh unauthenticated browser session and confirm README, license, security policy, issue templates, and pull request template render correctly.
- [ ] Fetch or clone the public repository into a scratch directory and run the same local checks from Section 2.
- [ ] Confirm no private-only runtime/bootstrap context files are visible in the public tree.
- [ ] Confirm no release artifacts, packages, Docker images, deployments, provider sends, terminal ACKs, or production state changes were created by the transition.
- [ ] Post a redacted smoke summary with repository URL, candidate SHA, check statuses, and any unresolved findings.

## 5. Rollback and incident notes

If unsafe content, wrong visibility scope, or unexpected live side effects are discovered:

- [ ] Immediately set `a2a-plane (internal tracker, private)` back to private using a human administrator account.
- [ ] Preserve redacted evidence: timestamps, candidate SHA, affected file paths or finding classes, and remediation owner. Do not paste secret values or raw private context.
- [ ] Open a private incident note and block further public-transition work until the finding is remediated and re-reviewed.
- [ ] If public exposure included actual credentials or tokens, follow the owner-approved secret rotation process outside this checklist; do not rotate or disclose secrets from this plan.

## 6. Community announcement prep

Prepare, but do not publish, A2A Nexus announcement copy that includes:

- [ ] Public repository link.
- [ ] What is included: sanitized A2A Nexus monorepo candidate, broker/plugin/runner docs, contracts, examples, and local/offline validation path.
- [ ] What is not included: source repository histories, production deploy state, secrets, provider IDs, Telegram IDs, live outbox ACK state, or private runtime/bootstrap context.
- [ ] Security contact and issue-reporting guidance.
- [ ] A note that npm/Docker artifacts and public releases remain separate approval-gated actions.
- [ ] Korean and English short announcement text with alpha/feedback-welcome tone from [`promotion-announcement.md`](./promotion-announcement.md).
