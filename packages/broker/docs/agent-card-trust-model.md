# AgentCard trust model — signed metadata and secure-passport evaluation

This document answers the design questions raised in #952: whether the broker
should sign its public AgentCard, how the A2A secure-passport extension maps
to our auth model, and how we keep private data out of public card output.

**Status: SUPERSEDED in part — opt-in AgentCard signing has since been implemented.**

> **Update.** The "defer signing" decision recorded below (Decision 1) was later
> reversed: JWS AgentCard signing is now **implemented as an opt-in capability**
> (`src/a2a/agent-card-signing.ts`; EdDSA/ES256 over the RFC 8785 canonicalization,
> enabled via `AGENT_CARD_SIGNING_KEY_FILE`). **Unsigned serving remains the
> current default** when no signing key is configured. The single code-backed
> source of the capability is `A2A_COMPATIBILITY_PROFILE.signedAgentCards` in
> `src/fixtures/a2a-protocol-compatibility.ts`, projected into
> `docs/protocol-compatibility.md`. The design reasoning below is retained as
> **historical context** for how the original defer decision was made; the
> secure-passport `CallerContext` portions remain deferred.

## Background

GitHub search on 2026-05-27 surfaced two external A2A trust-related references:

- **a2aproject/a2a-python** `src/a2a/utils/signing.py` — JWS-based AgentCard
  signing and verification helpers.
- **a2aproject/a2a-samples** `extensions/secure-passport/v1/spec.md` — a
  message-level extension (`CallerContext`) that attaches a signed, verifiable
  caller state to A2A message metadata.

Our broker already exposes two card-like surfaces:

1. **Public broker AgentCard** at `/.well-known/agent-card.json` — advertising
   the broker's A2A 1.0-compatible profile.
2. **Worker capability cards** — an internal registry subset that projects
   worker abilities without exposing broker URLs, workspace IDs, secrets, raw
   metadata, or mobile node internals.

Neither surface carries signed metadata today. Trust is enforced through:

- **Edge-secret** authentication at the transport layer (proves the caller can
  reach the broker).
- **Requester identity headers** (`x-a2a-requester-id`) for per-request actor
  attribution.
- **Worker capability card validation** that rejects secret-like fields and
  enforces `visibility` controls (`exposeBrokerUrl`, `exposeWorkspaceIds`,
  `exposesSecrets`, `safeForDiscovery`).

## Decision 1 (historical): Should the broker sign its public AgentCard now?

**Originally deferred; later reversed — signing is now implemented opt-in (see the
Status update at the top). The original reasoning is retained below as history.**

Reasoning:

1. **No key infrastructure exists.** JWS-based card signing requires key
   generation, secure storage, rotation, and trust anchor distribution. The
   broker has none of these, and building them is a significant cross-cutting
   change — well beyond a small docs/tests patch.

2. **The current trust model works.** Edge-secret + requester-id headers
   provide transport-level trust. The public AgentCard is a discovery
   document, not an authorization credential — clients already authenticate
   through edge-secret before making JSON-RPC calls.

3. **No consumer requires signed cards today.** Our only known A2A consumers
   (Team1 broker, Team2 broker, mobile workers) all authenticate through
   edge-secret. Adding signed cards without a consumer creates unused
   complexity.

4. **The secure-passport extension is a different layer.** Secure-passport
   defines `CallerContext` (clientId + state + signature) at the *message
   metadata* level, not the card level. See Decision 3 below.

**What changes when we revisit:**
- Add JWS signing via a broker-managed key pair.
- Expose a `/.well-known/agent-card.jws` endpoint alongside the existing JSON
  card (preserving backward compatibility).
- Add the `signature` field to the `AgentCard` type in the same PR that
  implements signing. The current public TypeScript shape intentionally omits
  `signature`/`signedExtensions` placeholders while signing is deferred.
- Add key rotation and revocation infrastructure.

## Decision 2: Can worker capability cards carry a public-safe signature envelope?

**Architecturally yes, also deferred.**

The existing `WorkerCapabilityCard` already has a robust `visibility` system
that controls exactly what reaches public output:

| Visibility flag         | Default  | Effect when `false`                         |
|-------------------------|----------|---------------------------------------------|
| `exposeBrokerUrl`       | `false`  | Broker URL omitted from public card output  |
| `exposeWorkspaceIds`    | `false`  | `workspaceIds` projected as `[]`            |
| `exposesSecrets`        | `false`  | Must stay `false`; validation rejects `true`|
| `safeForDiscovery`      | `false`  | Card stays broker-local unless explicitly set|

Validation additionally scans for secret-like key names (`edgeSecret`,
`githubToken`, etc.) and secret-like value patterns (GitHub tokens, private
key headers, `sk-` prefixes) and rejects cards that contain them.

A signature envelope (JWS header + payload + signature) would cover the
*already-sanitized* `agentCard` subset — the same content currently served
through the public discovery endpoint. No private data would leak, because:

- The signature covers only the `agentCard` block, which is already stripped
  of broker URLs, workspace IDs, and secrets by the visibility system.
- The signature itself is a cryptographic artifact; it doesn't contain the
  private key.
- The JWS header would carry a `kid` (key id) and `alg` (algorithm), not a
  raw key.

This is deferred for the same reason as Decision 1: no key infrastructure
exists to sign or verify these envelopes.

## Decision 3: How does secure-passport map to our auth model?

**Orthogonal, complementary layers.**

| Layer              | What it protects           | Our implementation                |
|--------------------|----------------------------|-----------------------------------|
| Transport auth     | Who can reach the broker   | Edge-secret + `x-a2a-requester-id`|
| Message trust      | Caller state integrity     | Not yet implemented               |

The A2A secure-passport extension defines a `CallerContext` object placed in
A2A message `metadata`:

```json
{
  "clientId": "a2a://orchestrator.example.com",
  "signature": "MOCK-SIG...",
  "state": {
    "user_preferred_currency": "GBP",
    "loyalty_tier": "Gold"
  }
}
```

This is an *application-level* trust payload. Edge-secret proves the caller
can reach the broker; `CallerContext` proves the caller's application state
hasn't been tampered with.

**How they coexist:**

- Edge-secret is **mandatory** for all broker JSON-RPC calls. Without it, the
  broker rejects the request at the transport layer.
- `CallerContext` would be **optional** — callers attach it when they want the
  broker to trust structured state without re-requesting it.
- The broker could extract and optionally validate `CallerContext` from
  `SendMessage` metadata in a future iteration, without changing card signing
  or transport auth.

**Current posture:** The broker neither attaches nor validates
`CallerContext`. Messages flow through with metadata intact, but the broker
does not interpret the secure-passport extension key. This is a safe default
— we don't *trust* untrusted metadata, but we don't *reject* it either.

## Decision 4: Operator visibility of card trust states

When card trust is eventually implemented, operators should see these states:

| State                  | Meaning                                      | Broker behavior                          |
|------------------------|----------------------------------------------|------------------------------------------|
| **unsigned**           | Card carries no `signature` field            | Current default. Treated as trusted within authenticated transport. |
| **signed + trusted**   | Signature verified against a known public key| Accepted. Card content is cryptographically bound to the issuer. |
| **signed + untrusted** | Signature present but key unknown            | Log a warning. Treat as unsigned for dispatch decisions. |
| **expired**            | `iat`/`exp` claims outside validity window   | Reject or warn depending on strictness config. |
| **key-rotated**        | `kid` references a revoked/rotated key       | Reject until card is re-signed with the current key. |

These states would be exposed through:

- The `PeerStatus` extension (`a2a.peer.status`) for peer broker cards.
- Worker capability card validation results for worker cards.
- Broker operator dashboard for at-a-glance trust status.

By default (no `AGENT_CARD_SIGNING_KEY_FILE` configured), all cards are served
**unsigned** and safe; opt-in signing binds the card to the issuer when a key is
configured. The operator visibility states above describe the target model for
surfacing signed/trusted/expired states as adoption proceeds.

## Secret exposure guard

The current codebase already prevents secret exposure in public card output
through multiple independent guards:

1. **Type system:** `WorkerVisibilityFlags.exposesSecrets` is typed as
   `false` — a literal type that the compiler enforces.
2. **Validation:** `validateWorkerCapabilityCard` rejects any card where
   `visibility.exposesSecrets !== false`.
3. **Secret scanning:** The validation function scans all card fields for
   secret-like key names (`SECRET_KEY_RE`) and value patterns
   (`SECRET_VALUE_RE`).
4. **Privacy defaults:** `exposeBrokerUrl`, `exposeWorkspaceIds`, and
   `safeForDiscovery` all default to `false` for worker cards.
5. **Public card gate:** Public-scoped cards (`scope: "public"`) are
   additionally validated to ensure `exposeBrokerUrl` and
   `exposeWorkspaceIds` are both `false`.

The compatibility test suite in `src/a2a/protocol-compatibility.test.ts`
includes a dedicated test (`"AgentCard.capabilities and WorkerCapabilities are
disjoint public-seam shapes"`) that verifies the two capability types cannot
accidentally converge.

## External references

- A2A Python signing utilities:
  `a2aproject/a2a-python` — `src/a2a/utils/signing.py`
- Secure Passport extension spec:
  `a2aproject/a2a-samples` — `extensions/secure-passport/v1/spec.md`

## Change log

| Date       | Change                                                        |
|------------|---------------------------------------------------------------|
| 2026-05-27 | Initial design note. Signing deferred; trust model documented.|

## Related docs

- `docs/protocol-compatibility.md` — public A2A compatibility matrix
- `docs/a2a-protocol.md` — canonical broker protocol reference
- `docs/worker-capability-registry.md` — worker capability registry design
- `src/a2a/agent-card.ts` — AgentCard type and factory
- `src/core/worker-capability-card.ts` — worker capability card types and validation
- `src/fixtures/a2a-protocol-compatibility.ts` — golden compatibility constants
