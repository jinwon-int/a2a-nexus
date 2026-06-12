# Signed execution proofs

The runner already emits a tamper-evident `ExecutionProof` that chains
`inputDigest → expandedDigest → outputDigest → chainDigest`. With a signing
key configured, the proof is additionally **JWS-signed**, so a downstream
consumer can verify *which node instance produced this proof for this input*,
not just that its digests are internally consistent.

## Enabling

```bash
A2A_DOCKER_RUNNER_PROOF_SIGNING_KEY_FILE=/etc/a2a/proof-key.pem   # Ed25519 or EC P-256 PKCS#8 PEM
A2A_DOCKER_RUNNER_PROOF_SIGNING_KID=node-bangtong-1               # optional JWS kid
```

When set, every `ExecutionProof` gains a `signature` block:

```json
{
  "chainDigest": "…",
  "signature": {
    "protected": "base64url({ alg: 'EdDSA', typ: 'JOSE', kid: 'node-…' })",
    "signature": "base64url(sig over protected + '.' + base64url(canonical proof sans signature))"
  }
}
```

The signature covers the canonicalized proof **excluding the signature field
itself** (same `stable-json-recursive-v2` canonicalization as the digests),
so any mutation of any signed field invalidates it.

## Verifying

`verifyExecutionProof(proof, task, expanded, stdout, stderr, { publicKeyPem })`
checks the digest chain and, when `publicKeyPem` is supplied, **requires** a
signature that verifies against it — an unsigned proof fails closed under a
key requirement. Without `publicKeyPem`, only the digest chain is checked
(unchanged behavior).

## Safety

Off by default: no key means unsigned proofs, byte-for-byte as before.
Supported keys are Ed25519 (`EdDSA`) and EC P-256 (`ES256`); other key types
fail loudly at signing time.
