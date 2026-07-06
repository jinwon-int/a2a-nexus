# Contract: Verifiable Analysis Report v0

Status: v0 (contract-first). Umbrella: #1378. Composes G2 (#1356) provenance,
K2 (#1374) source-capture, M3 (#1301) attestation validations.

This contract defines a **self-contained report bundle** that ships alongside a
round result and can be verified **offline, by a third party, without the
broker**. It is the smallest concrete atom of the "verified evidence data
layer" thesis (M-track #1298): it moves a round output from *"I verified it"* to
*"anyone can verify it."*

The bundle is the **integration target** for the emit side. G2/K2 workers MUST
produce bundles conforming to this shape and to the signing-payload definitions
below; the reference verifier (`scripts/verify-analysis-report.mjs`) is the
authority on acceptance.

## 1. What this proves — and what it does NOT

This is the load-bearing boundary of the whole design (V0-d invariant).

- **Proves**: process provenance (*who* produced it, on *what* sources), and
  integrity (the signed content was *not tampered* after production).
- **Does NOT prove**: that the analysis is **correct**, or that any judgment in
  it is **right**. Provenance is cryptographic; correctness is not. A signed
  wrong analysis is a wrong analysis with good provenance.

A conforming bundle MUST carry an `assurance` block that declares this
explicitly, and the verifier MUST refuse to return GREEN for a bundle that
omits it (so no report can present itself as certifying correctness).

## 2. Canonicalization

All hashes and signatures are computed over **canonical JSON**: recursively
sorted object keys, `undefined`-valued keys dropped, arrays in document order.
This mirrors `stableJsonStringify` (packages/docker-runner `execution-proof.ts`)
and the established JWS convention (`execution-proof-signing.ts`). The
independent verifier re-implements canonicalization standalone — it MUST NOT
depend on broker internals (offline third-party verification is the point).

`sha256:<hex>` denotes lowercase-hex SHA-256 over the canonical UTF-8 bytes.

## 3. Bundle shape

```jsonc
{
  "reportVersion": "verifiable-analysis-report/v0",
  "taskId": "…",
  "producedAt": "ISO-8601",
  "worker": {
    "keyId": "…",                     // public key id only — never a private key, never a worker's real name
    "class": "source-only"            // anonymized class: source-only | mobile | vps | unclassified
  },
  "analysis": {
    "summary": "…",                   // the analysis payload (or a bounded subset)
    "bodyHash": "sha256:…"            // sha256(canonical(analysis.summary))
  },
  "sources": {                        // K2 source-capture manifest
    "retrievalClass": "source-capture",
    "items": [
      { "sourceId": "s1", "contentHash": "sha256:…", "fetchedAt": "ISO-8601" }
    ],
    "sourcesRoot": "sha256:…"         // sha256(canonical(sorted item contentHashes))
  },
  "evidence": {                       // M3 attestation validations
    "validations": [ { "kind": "…", "verdict": "…" } ]
  },
  "assurance": {                      // V0-d correctness-separation invariant (REQUIRED)
    "proves": ["source-grounding", "integrity", "process-provenance"],
    "doesNotProve": ["analytical-correctness", "normative-judgment"],
    "disclaimer": "This report proves how the analysis was produced and that it was not tampered with. It does NOT certify that the analysis is correct."
  },
  "provenance": {                     // G2 signature chain
    "alg": "EdDSA",                   // EdDSA (ed25519) or ES256 (P-256), per signing key
    "workerKeyId": "…",
    "resultHash": "sha256:…",         // sha256(canonical(bundle WITHOUT provenance))
    "workerSig": "base64url",         // sign(canonical({ resultHash, taskId, producedAt }))
    "brokerCountersig": {
      "brokerKeyId": "…",
      "sig": "base64url",             // sign(canonical({ workerSig, taskId, verifiedAt }))
      "verifiedAt": "ISO-8601"
    }
  }
}
```

### Signing payloads (frozen)

- `provenance.resultHash` = `sha256:` + sha256(canonical(bundle sans `provenance`)).
  Because `sources`, `analysis`, `evidence`, and `assurance` all live inside the
  signed bundle, any one-byte change to any of them breaks `resultHash`.
- **workerSig** covers `canonical({ resultHash, taskId, producedAt })`. Binding
  `taskId` + `producedAt` prevents replay/transplant of a signature onto a
  different task.
- **brokerCountersig.sig** covers `canonical({ workerSig, taskId, verifiedAt })`.

## 4. Verification (all checks fail-closed; GREEN requires every check to pass)

1. **Shape + assurance invariant** — required fields present; `reportVersion`
   matches; `assurance.doesNotProve` includes `analytical-correctness` and
   `normative-judgment`; `assurance.disclaimer` is a non-empty string.
2. **Body-hash binding** — recompute `sha256(canonical(analysis.summary))` and
   assert it equals `analysis.bodyHash`.
3. **Sources-root binding** — recompute
   `sha256(canonical(sorted item contentHashes))` and assert it equals
   `sources.sourcesRoot`.
4. **Result-hash binding** — recompute `sha256(canonical(bundle sans provenance))`
   and assert it equals `provenance.resultHash`. (Master tamper check.)
5. **Worker signature** — resolve `provenance.workerKeyId` in the supplied
   keyring; verify `workerSig`. **Fail-closed if the key is absent** from the
   keyring.
6. **Broker countersignature** — resolve `brokerKeyId`; verify
   `brokerCountersig.sig`.

The consumer supplies known public keys via a keyring file
(`{ "keys": { "<keyId>": "<PEM public key>" } }`). No private key material ever
appears in a bundle, keyring, log, or issue.

### Extension points (strengthen once emit side lands)

- **Per-snapshot signatures** — K2 signs each fetched snapshot; v0 verifies the
  manifest root, per-item `snapshotSig` verification is additive/future.
- **K3 source-only signal** — v0 checks `sources.retrievalClass` and
  `worker.class` consistency; binding the K3 (#1372) finalizer-purity
  tool-policy signal into the signed body is a future check.

## 5. Safety boundaries

- Public key ids only; private keys never emitted anywhere.
- Attested subject is an **anonymized class / key id** — never a worker's real
  name (public-readiness precedent).
- Provenance verification failure is **fail-closed** — no partial-trust state.
- Backward compatible: a result without a bundle behaves exactly as today.
- Reuse existing deployed signing keys; do not invent a new key-distribution
  scheme (G2 boundary, inherited). Key rotation/revocation is operator-only.
