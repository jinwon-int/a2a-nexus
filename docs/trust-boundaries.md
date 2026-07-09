# Trust boundaries and proof primitives

This document is the public-safe companion to the [architecture map](architecture.md). It describes what A2A Nexus trust primitives prove, what they do not prove, and which actions remain separately approval-gated.

It intentionally avoids private topology, live URLs, node names, provider identifiers, Telegram identifiers, production data, secrets, credential paths, and runtime state.

## Core stance

A2A Nexus is not just an A2A runtime. It is a **referee and evidence plane** for delegated work:

1. The broker controls task lifecycle and class-based policy.
2. Workers produce bounded evidence.
3. Verifiers and finalizers check integrity, independence, and subject binding.
4. Operators decide whether a gated action is allowed.

The architecture is designed so that "the agent said it was fine" is never the final trust anchor.

## Trust primitive catalog

| Primitive | What it proves | What it does not prove | Public contract |
|---|---|---|---|
| Broker policy document | A class-based policy was evaluated at task create/claim time. | That the final answer is correct, or that every future broker is enforcing the same file. | [Broker Policy Document v1](../contracts/a2a/broker-policy.md) |
| Task result provenance | A result was submitted through the signed broker/worker provenance path and is tamper-bound to a result hash. | Human/LLM authorship or analytical correctness. | [Verifiable Analysis Report v1](../contracts/a2a/verifiable-analysis-report.md) |
| Retrieval snapshot | A cited source snapshot has an intact hash, byte length, tuple metadata, and signature. | That a future live fetch is approved. | [Verifiable Analysis Report v1](../contracts/a2a/verifiable-analysis-report.md) |
| Attestation bundle | A redacted task audit packet can be checked without chasing broker internals. | Full raw task history, private node identity, or correctness. | [Attestation bundle format v0](attestation-bundle.md) |
| Finalizer verdict | An independent finalizer or deterministic battery rendered a subject-bound GO/NO-GO verdict. | Analytical correctness; reproducibility for judgment verdicts. | [Finalizer Verdict v1](../contracts/a2a/finalizer-verdict.md) |
| Completion certificate | Declared A2A-evaluable completion conditions were evaluated for a bound subject. | Payment authorization, funds availability, legal settlement, or live rail execution. | [Completion Certificate v0](../contracts/a2a/completion-certificate.md) |
| Product artifact certificate | A named artifact was checked against declared claims and evidence. | Stable release status or production support. | [Product Artifact Certificate](../contracts/a2a/product-artifact-certificate.md) |
| Agent work proof | A task's report product, deterministic battery, completion certificate, artifact manifest, and work-proof verdict are hash-bound and offline-verifiable as one bundle. | Analytical correctness, authorship, payment authorization, legal settlement, release approval, or judgment reproducibility. | [Agent Work Proof Bundle v0](../contracts/a2a/agent-work-proof.md) |

## Separation rules

### Validity is not correctness

A signature, hash, or verifier pass says that an object is well-formed, bound to the right subject, and not tampered with. It does not say the analysis is true. Public messaging should use language like:

- "the evidence packet is offline-verifiable";
- "an independent review occurred";
- "the verdict is subject-bound";
- "the condition evaluation was performed."

Avoid language like:

- "the answer is correct";
- "payment is authorized";
- "this is production ready";
- "the agent authored this from scratch."

### Judge is not player

Finalizer and worker identities are separate roles. A finalizer verdict is valuable because the subject producer and the finalizer are not the same role. Self-certification is a failure mode, not a shortcut.

### Roles, not names

Public evidence should speak in roles (`author`, `reviewer`, `finalizer`, `broker`, `worker class`) and hashes. It should not leak concrete private node names, internal service identifiers, host-local paths, or private endpoint coordinates.

### Missing is not empty

When evidence cannot be collected, the proof object should say `missing` rather than implying there was nothing to collect. This keeps closeout reports honest and prevents absence from looking like success.

## Approval boundaries

| Action | Source-only docs/tests enough? | Requires separate operator approval? |
|---|---:|---:|
| Read existing source and propose a design | Yes | No |
| Run local/offline validators and conformance fixtures | Yes | No |
| Create a documentation or source-only PR | Yes, through normal PR workflow | Usually no beyond the current workstream |
| Enable a new network fetch path or egress proxy | No | Yes |
| Change broker policy enforcement posture | No | Yes |
| Deploy/restart broker, Gateway, worker, or runner | No | Yes |
| ACK/replay/prune/migrate terminal outbox or DB state | No | Yes |
| Move/rotate/disclose credentials or signing keys | No | Yes |
| Publish tags, releases, npm packages, Docker/GHCR images, or homepage metadata | No | Yes |
| Call provider, payment rail, Telegram, notification, or other live external side-effect surfaces | No | Yes |

A source-only approval packet or fixture is evidence for a future decision. It is not execution approval.

## Lane boundary matrix

| Lane mode | Evidence expected | Closeout posture |
|---|---|---|
| Source-only analysis | findings, risks, recommendations, cited source bundle paths | May support design/triage/doc PRs; never authorizes live action. |
| Read-only validation | command output, fixture checks, offline verifier results | May support a source-only merge if checks pass. |
| Patch / PR execution | branch, diff, tests, PR URL, review evidence | May merge through PR workflow; live deploy remains separate. |
| Live mutation | approval reference, bounded scope, rollback, post-action readback | Must be explicitly authorized and reported as live mutation. |

## Feature repo derivation guide

Feature repositories should be split only when their trust boundary is legible outside the monorepo. Candidate extraction surfaces should answer four questions:

1. **Subject:** what exact artifact, task, report, or result is being judged?
2. **Evidence:** which source bundle, verifier output, or proof object supports the claim?
3. **Verifier:** can a third party check it offline or with local fixtures?
4. **Non-goals:** what live actions, correctness claims, or payment/release claims are explicitly excluded?

| Candidate surface | Good first extraction artifact | Boundary to keep explicit |
|---|---|---|
| Policy referee | policy document schema, evaluator fixtures, observation report shape | Enforcement promotion is an operator decision. |
| Agent work proof | agent work proof bundle fixture + offline verifier | Provenance does not prove authorship or correctness. |
| Escrow proof | completion certificate and no-live adapter receipts | A2A does not hold or move funds. |
| Verifiable analysis report | signed result + source snapshot binding | Authentic source grounding does not prove the analysis is true. |
| Certification battery | deterministic fixture manifest and re-run instructions | Battery reproducibility applies only to pinned checks, not judgment verdicts. |

## Public-safe checklist

Before publishing or merging a trust-boundary document, check:

- [ ] It uses conceptual roles rather than private node or host identifiers.
- [ ] It contains no live broker URLs, private ports, provider IDs, Telegram IDs, tokens, credential paths, or runtime dumps.
- [ ] It separates source-only evidence from live execution approval.
- [ ] It separates validity/provenance from correctness.
- [ ] It says when a proof object is offline-verifiable and what verifier checks it.
- [ ] It says what remains out of scope or separately approval-gated.
- [ ] `npm run check:markdown-links` passes.
- [ ] `npm run scan:public-readiness` passes.
