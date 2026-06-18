## Summary

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

## Safety checklist

- [ ] Repository visibility was not changed.
- [ ] No release, tag, npm package, Docker image, or other publication was created.
- [ ] No production deploy, Gateway/broker/worker restart, production DB mutation, terminal-outbox ACK/replay, live provider/Telegram send, secret/credential movement, rotation/disclosure, history rewrite, or force push was performed.
- [ ] Any approval-sensitive action is excluded or has a separate explicit operator approval link.
- [ ] Evidence is redacted and contains no secrets, private endpoints, provider IDs, Telegram IDs, raw session dumps, or production data.
- [ ] Branch/artifacts do not include OpenClaw runtime/bootstrap files: `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, or `.openclaw/**`.

## Related issues

- Parent/issue:
