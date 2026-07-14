# PR finalizer verdicts (#1383 V-d)

A verdict-carrying PR places its signed finalizer verdict(s) here as
`<slug>.json`. The `finalizer-verdict-gate` CI job (required check) verifies
each one fail-closed with `scripts/check-finalizer-verdict.mjs`:

- signed by a key registered in `docs/ops/finalizer-keyring.json` (public keys
  only; the private key never enters the repo). Each entry may be a bare PEM
  (active, no window) or a lifecycle record
  `{ pem, status: "active"|"revoked", notBefore, expiresAt }`; the shared
  verifier (`scripts/verify-finalizer-verdict.mjs`, imported by this gate's
  `scripts/check-finalizer-verdict.mjs` and reused by the merge gate) rejects a
  revoked key and enforces the verdict's `producedAt` validity window — so one
  keyring file serves both the broker and the repo merge gate,
- subject bound to this PR's head SHA (`subject.kind: "pr"`, `prHeadSha`),
- `decision === "go"`,
- independent of the producing worker keys (auto-derived from each
  `<slug>.report.json` sibling's signed provenance when present).

PRs with no files here pass the gate as "no verdict-carrying changes".
Contract: `contracts/a2a/finalizer-verdict.md`.
