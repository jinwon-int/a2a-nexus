# contracts/compatibility (v0 Freeze)

> **v0 Freeze (2026-05-09):** Compatibility contracts and fixtures in this directory are frozen
> at Contract v0. The accepted-send non-ACK boundary and ACK-safe receipt types are locked.

## TCK and v0→v1 compatibility plan

- [A2A TCK and v0→v1 compatibility plan](./a2a-tck-and-v0-to-v1-compatibility-plan.md) is the
  smallest PR-first slice of the Nexus A2A TCK lane (#916 / wave #922). It maps every frozen
  v0 contract to a TCK category, defines the v0→v1 rules (additive / deprecation / schema
  versioning / worker capability evolution / terminal evidence semantics), classifies which
  existing checks are fixture validators versus promoted TCK gates, references the existing
  no-live external harness fixture, and documents a non-blocking contract section citation
  convention for task packets.
- Fixture: `fixtures/compatibility/a2a-tck-and-v0-to-v1-compatibility-plan.json`
- Gate: `node test/conformance/check-a2a-tck-plan.mjs`

## Terminal evidence ACK boundary

- [Terminal evidence ACK boundary](./terminal-evidence-ack-boundary.md) defines accepted-send/provider message-id evidence as non-ACK and requires manual or current-session-visible receipt proof before terminal ACK eligibility.
- Fixture: `fixtures/terminal-evidence/accepted-send-non-ack.json`
- Check: `node test/conformance/check-terminal-evidence-ack-boundary.mjs`
