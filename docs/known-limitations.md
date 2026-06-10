# Known Limitations

A2A Nexus is an alpha integration candidate, not a production-ready public service.

## Current limits

- Public release remains NO-GO until secret/history scan findings are classified and sanitized.
- The monorepo candidate uses sanitized/squash imports; original private source histories are not public artifacts.
- Worker routing is team-scoped: Team1 is Seoseo broker, Team2 is Gwakga broker. Cross-team work requires an explicit handoff record.
- Docker runner GitHub auth mounts and network settings are trusted-operator modes, not safe defaults for arbitrary multi-tenant execution.
- Terminal evidence distinguishes provider acceptance from operator-visible receipt; provider-send success is not terminal ACK.
- Terminal Brief OpenClaw routing remains activation-blocked until the [R6 no-bypass gates](./r6-terminal-brief-openclaw-routing-synthesis.md) are satisfied after upstream OpenClaw receipt proof.
- Compatibility claims must name exact broker/plugin/runner/OpenClaw baselines.
- The OpenClaw Gateway canary adapter is not containerized by this monorepo; it runs inside the selected OpenClaw Gateway runtime. Docker coverage applies to the broker and Docker runner unless a separate Gateway canary container is explicitly prepared.

## Alpha support policy

- Treat the project as experimental until public-readiness gates are closed.
- File issues with redacted logs and exact versions.
- Do not paste secrets, private endpoints, raw transcripts, or host-specific paths into issues.
- Security-sensitive reports should use the private security contact path once `SECURITY.md` is finalized.
