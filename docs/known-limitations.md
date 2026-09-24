# Known Limitations

> **Snapshot date:** 2026-09-24. This list describes runtime and support limits of the current public alpha. Repository visibility, release, package, and deployment gates are tracked in [`docs/release-readiness.md`](release-readiness.md) and [`docs/trust-boundaries.md`](trust-boundaries.md), not here.

A2A Nexus is a public alpha reference implementation, not a production-ready public service. Public visibility does not imply stable release support, package publication, production deployment, or security support.

## Current limits

- Source-only install from this checkout is the only supported install path. Every workspace package is `private: true` and unpublished; there is no supported `npm install`, Docker image, or GHCR pull path.
- The monorepo was assembled from sanitized/squash imports; the original split-repository histories are archived, private provenance mirrors and are not public artifacts.
- Worker routing is broker-scoped. A worker registers with exactly one broker, and cross-broker work requires an explicit handoff record; there is no automatic cross-broker task migration.
- Docker runner GitHub auth mounts and bridge networking are trusted-operator modes, not safe defaults for arbitrary multi-tenant execution.
- Terminal evidence distinguishes provider acceptance from operator-visible receipt; provider-send success is not terminal ACK.
- Terminal Brief OpenClaw routing remains activation-blocked until the [R6 no-bypass gates](./history/r6-terminal-brief-openclaw-routing-synthesis.md) are satisfied after upstream OpenClaw receipt proof.
- Compatibility claims must name exact broker, runner, and harness-bridge baselines from [`contracts/compatibility/matrix.md`](../contracts/compatibility/matrix.md); no harness is privileged and no harness ships as a package of this repository.
- Harness bridges (`packages/broker/scripts/*-a2a-*-bridge.mjs`) run inside the selected harness runtime, not in a container built by this monorepo. Docker coverage applies to the broker and the Docker runner only.
- Broker `json-file` persistence is crash-safe for completed snapshot writes, but mutations after the last completed flush can still be lost on process/host crash. SQLite is a single-writer durability option, not a multi-process or HA guarantee. See [`packages/broker/docs/persistence-durability.md`](../packages/broker/docs/persistence-durability.md).
- Broker replay-cache and rate-limit protections are process-local in the alpha profile. Restarts reset them and horizontal scaling requires a conforming shared store. The proposed [shared-state and HA contract](./specs/shared-state-ha-contract/spec.md) defines the exact deployment grades and future adapter semantics; it is documentation only, and no shared/HA backend exists. See also [`packages/broker/docs/process-local-security-limits.md`](../packages/broker/docs/process-local-security-limits.md).
- Multi-process broker serving is unsupported. Operators must keep exactly one serving broker process; current startup/readiness does not yet implement the proposed topology fence. `shared-state-ha` is future work, not a current capability.
- Docker runner trusted-operator lanes still expose more capability than public safe-default lanes; host network, writable rootfs, and root user now require explicit opt-in. See [`packages/docker-runner/docs/trusted-operator-hardening.md`](../packages/docker-runner/docs/trusted-operator-hardening.md).

## Alpha support policy

- Treat the project as experimental. No stability, backward-compatibility, or security-response guarantees are implied.
- File issues with redacted logs and exact versions.
- Do not paste secrets, private endpoints, raw transcripts, or host-specific paths into issues.
- Report security-sensitive findings through the path described in [`SECURITY.md`](../SECURITY.md), not in public issues.
