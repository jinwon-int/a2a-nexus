# Known Limitations

A2A Nexus is an alpha integration candidate, not a production-ready public service.

## Current limits

- Public release remains NO-GO until secret/history scan findings are classified and sanitized.
- The monorepo candidate uses sanitized/squash imports; original private source histories are not public artifacts.
- Worker routing is team-scoped: Team1 is broker-alpha broker, Team2 is broker-beta broker. Cross-team work requires an explicit handoff record.
- Docker runner GitHub auth mounts and network settings are trusted-operator modes, not safe defaults for arbitrary multi-tenant execution.
- Terminal evidence distinguishes provider acceptance from operator-visible receipt; provider-send success is not terminal ACK.
- Terminal Brief OpenClaw routing remains activation-blocked until the [R6 no-bypass gates](./history/r6-terminal-brief-openclaw-routing-synthesis.md) are satisfied after upstream OpenClaw receipt proof.
- Compatibility claims must name exact broker/plugin/runner/OpenClaw baselines.
- The OpenClaw Gateway canary adapter is not containerized by this monorepo; it runs inside the selected OpenClaw Gateway runtime. Docker coverage applies to the broker and Docker runner unless a separate Gateway canary container is explicitly prepared.
- Broker `json-file` persistence is crash-safe for completed snapshot writes, but mutations after the last completed flush can still be lost on process/host crash. SQLite is a single-writer durability option, not a multi-process or HA guarantee. See [`packages/broker/docs/persistence-durability.md`](../packages/broker/docs/persistence-durability.md).
- Broker replay-cache and rate-limit protections are process-local in the alpha profile. Restarts reset them and horizontal scaling requires a conforming shared store. The proposed [shared-state and HA contract](./specs/shared-state-ha-contract/spec.md) defines the exact deployment grades and future adapter semantics; it is documentation only, and no shared/HA backend exists. See also [`packages/broker/docs/process-local-security-limits.md`](../packages/broker/docs/process-local-security-limits.md).
- Multi-process broker serving is unsupported. Operators must keep exactly one serving broker process; current startup/readiness does not yet implement the proposed topology fence. `shared-state-ha` is future work, not a current capability.
- Docker runner trusted-operator lanes still expose more capability than public safe-default lanes; host network, writable rootfs, and root user now require explicit opt-in. See [`packages/docker-runner/docs/trusted-operator-hardening.md`](../packages/docker-runner/docs/trusted-operator-hardening.md).

## Alpha support policy

- Treat the project as experimental until public-readiness gates are closed.
- File issues with redacted logs and exact versions.
- Do not paste secrets, private endpoints, raw transcripts, or host-specific paths into issues.
- Security-sensitive reports should use the private security contact path once `SECURITY.md` is finalized.
