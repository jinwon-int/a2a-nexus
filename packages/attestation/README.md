# a2a-attestation

Agent work attestation toolkit (#1601 P2): "이 산출물을 어떤 에이전트가 어떤
검증으로 만들었는가"의 증명 체인.

- agent-card signing + RFC8785 JCS canonicalization (`agent-card-signing`)
- finalizer verdict signature + keyring (`finalizer-verdict-signature`)
- deterministic evidence assembly (`worker-subagent-evidence-assembly`)
- redaction gate (`worker-subagent-redaction`, `-redaction-gate`)
- spawn-gate decision + orchestration policy + budget counter
- result/retrieval provenance (`provenance`)

Scope note: provenance proves integrity + submission (who signed/submitted
what), NOT authorship or correctness — see `provenance.ts` header.

Extracted from `packages/broker` with contracts unchanged; the broker imports
it through the package boundary (modularize-first, extract-second).
