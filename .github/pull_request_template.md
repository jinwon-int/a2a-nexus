## Summary

-

## RED evidence (blocking for contract/gate/fix lanes)

<!-- Contract, gate, or behavior-fix PRs MUST paste the pre-change failing evidence here:
the new test failing on the base tree, or an absence proof for doc gates.
Refactor lanes: replace with the surface-preservation proof (unmodified full suite pass
+ line-count delta). Docs-only: N/A with one-line reason.
A missing RED on a contract lane blocks the finalizer verdict (docs/operators.md,
escalated 2026-07-05 after three consecutive deviations). -->

-

## Spec-first packet

- Size classification: Small / Medium / Large
- Spec:
- Clarify notes, if needed:
- Plan:
- Analyze notes:
- Tasks:
- Checklist:

For Small changes where a full packet is not required, explain why the change is short, reversible, single-repo, and does not cross approval boundaries.

## Verification

- [ ] `npm ci --ignore-scripts --include=dev`
- [ ] `npm run check`
- [ ] `npm run scan:public-readiness`
- [ ] Focused validation listed in the plan was run or is explicitly N/A.

## Evidence / closeout

- [ ] Changed repos/files are summarized.
- [ ] CI/check status is linked or summarized.
- [ ] Risks, rollback/failure handling, and follow-up issues are documented.
- [ ] Wiki/runbook update is linked or explicitly not needed.
- [ ] Exactly one broker/finalizer owns the closeout decision for A2A rounds.
- [ ] A2A rounds list one line of substance (or failure class) per dispatched lane — see docs/a2ad-round-dispatch.md "Per-lane readback in PR bodies"; N/A if no rounds.

## Safety checklist

- [ ] Repository visibility was not changed.
- [ ] No release, tag, npm package, Docker image, or other publication was created.
- [ ] No production deploy, Gateway/broker/worker restart, production DB mutation, terminal-outbox ACK/replay, live provider/Telegram send, secret/credential movement, rotation/disclosure, history rewrite, or force push was performed.
- [ ] Any approval-sensitive action is excluded or has a separate explicit operator approval link.
- [ ] Evidence is redacted and contains no secrets, private endpoints, provider IDs, Telegram IDs, raw session dumps, or production data.
- [ ] Branch/artifacts do not include OpenClaw runtime/bootstrap files: `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, or `.openclaw/**`.

## Related issues

- Parent/issue:
