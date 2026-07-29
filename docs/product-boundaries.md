# Product boundaries and extraction contract

Issue: [#1479](https://github.com/jinwon-int/a2a-nexus/issues/1479). Umbrella: [#1478](https://github.com/jinwon-int/a2a-nexus/issues/1478).

This is a **G0 source-only boundary map** for future product extraction. It fixes the public contract for what stays in `a2a-nexus`, what may become a feature repository later, and what evidence is required before any split. It does not create repositories, move code, publish packages, tag releases, change visibility, deploy, restart brokers/workers, or alter live policy observation.

## Boundary rule

`a2a-nexus` remains the upstream source of truth for shared A2A Nexus primitives. A feature repository may consume a pinned Nexus contract, fixture, or verifier pattern, but Nexus must not depend on a feature repository for core task lifecycle, policy semantics, evidence schema, or release gates.

```text
Allowed:    feature repo -> pinned Nexus contract / fixture / verifier pattern
Forbidden:  Nexus core -> feature repo runtime, generated artifact, or mutable package API
```

A split candidate is ready only when it has a narrow proof/product boundary, a source-only verification command, release-readiness evidence, and an explicit non-goal list that prevents the product from being mistaken for live deployment, payment, policy enforcement, or package publication approval.

## Nexus core vs feature repository boundary

| Surface | Nexus core responsibility | Feature repository candidate | Dependency direction |
|---|---|---|---|
| Broker task lifecycle | Task creation, queueing, claiming, status transitions, terminal evidence, worker registry, persistence, and compatibility gates. | None by default. A future SDK may wrap public APIs, but it must not own lifecycle semantics. | SDK/product -> Nexus API contract; Nexus -> SDK forbidden. |
| Policy evaluation primitive | Broker policy document, create/claim policy checks, approval-required semantics, audit shape, and observation/enforcement transition rules. | The private monorepo `a2a-policy-referee` package now has an offline CLI and public-safe decision fixtures. A separate repository, service mode, or published package remains future work requiring separate approval. | Current broker -> monorepo package; any future extracted product -> pinned `contracts/a2a/broker-policy.md` and policy fixtures. Nexus -> future extracted product runtime remains forbidden. |
| Signed verdict schema | Finalizer verdict subject binding, signer/keyring expectations, and judgment/battery semantics. | Reusable verdict-verifier helper can be packaged only after compatibility and release gates. | Product -> `contracts/a2a/finalizer-verdict.md`; Nexus -> product forbidden. |
| Provenance/evidence schema | Attestation bundle, terminal evidence semantics, source grounding, result hashes, and public-safe evidence policy. | Evidence viewers/report renderers may be productized when they preserve redaction and missing-vs-empty semantics. | Product -> Nexus evidence contracts; Nexus -> product forbidden. |
| Offline verification primitive | Source-only verification commands and conformance fixtures for proof objects. | Proof-specific verifier/SDK packages, such as agent-work-proof or escrow-proof. | Product -> contract + fixture + verifier semantics; Nexus keeps canonical tests. |
| Public-readiness and release gates | Markdown links, public-readiness scan, external-secret scan, release-gate inventory, package contents audit policy, and no-live approval language. | Product repos may copy or vendor gate templates, but must keep their own evidence records. | Product -> Nexus release-gate pattern; Nexus release gate must not require product repo availability. |
| Dogfood / integration tests | Monorepo compatibility tests, local quickstart, Docker runner smoke, broker/plugin/runner CI parity. | Product-specific demos may exist, but they cannot be the only compatibility proof for Nexus core. | Product -> Nexus compatibility fixtures; Nexus -> product demo forbidden. |

## Current package/API/export inventory

This inventory is the G0 baseline before any split. It records what exists today, not a publication approval.

| Workspace | Package name | Current publication state | Public entrypoints today | CLI/bin today | Extraction stance |
|---|---|---|---|---|---|
| root | `@jinwon-int/a2a-nexus-monorepo` | `private: true`; workspace coordinator only. | No `exports`; scripts coordinate checks and release gates. | No package bin. | Must stay as monorepo coordinator until a separate topology decision changes it. |
| `packages/broker/` | `a2a-broker` | `private: true`; canonical broker source. | No package `exports`/`bin`; runtime entrypoints are scripts such as `start`, `start:worker`, and build output under `dist/`. | Operational scripts only; not a published CLI surface. | Core. Do not split or publish without release/package approval and live-policy review. |
| `packages/openclaw-plugin-a2a/` | `plugin-a2a` | `private: true`; reference integration adapter. | `.` / `./api` / `./config` / `./standalone-broker-client` / `./type-mapping` / `./plugin-id`; `./src/*` remains compatibility-risky and should not be expanded as public API. | `a2a-terminal-brief-sidecar`, `a2a-terminal-brief-openclaw-message`, `a2a-terminal-brief-hermes-mobileAlpha`. | Reference adapter. Future adapter products must preserve broker validation and write-set rules. |
| `packages/docker-runner/` | `@openclaw/a2a-docker-runner` | `private: true`; isolated runner source. | No package `exports`; files candidate includes `dist`, `scripts`, README, LICENSE, package metadata. | `a2a-docker-runner`. | Candidate package only after runner package contents audit, disposable install smoke, and runner boundary evidence. |
| `contracts/a2a/` + `fixtures/contract/` | Not a package today. | Contract candidate surface, not npm-published. | Markdown contracts and public-safe JSON fixtures. | Conformance checks under `test/conformance/`; verifier CLIs under `scripts/`. | Canonical upstream for feature products. Products consume pinned contracts; contracts do not consume products. |

## Candidate extraction contract

Every feature repository candidate must satisfy this contract before repository creation, package publication, badge claims, or public promotion:

1. **Pinned upstream source:** cite the exact Nexus commit, contract file, fixture, verifier, and conformance test used as the extraction source.
2. **Dependency direction:** state `product repo -> Nexus contract` and prove Nexus core has no import/runtime dependency on the product.
3. **Package/API inventory:** list package name, CLI names, exported modules, generated artifacts, and files that would be included/excluded.
4. **Verification command:** provide a source-only local command that validates the candidate without networked package publication or live service calls.
5. **Release/public-readiness evidence:** run markdown link checks, public-readiness scan, external-secret scan, package contents audit, license/NOTICE review, and the product-specific verification command.
6. **No-live boundary:** explicitly deny deploy/restart, provider sends, payment rails, policy enforcement flips, DB/outbox/ACK/replay/prune/migration, credential movement, repository visibility changes, tags, releases, npm/Docker/GHCR publication, homepage metadata changes, and broad promotion unless separately approved.
7. **Compatibility note:** describe how future contract changes flow from Nexus to the product, including deprecation/rollback expectations.

## Feature repository candidate matrix

Candidate package names and CLIs below are **target shapes**, except where a
row explicitly identifies an existing private monorepo source slice. No row is
package-publication approval.

| Candidate | Proposed package name | Proposed CLI | Artifact type | Upstream Nexus source | Verification command | Extraction boundary |
|---|---|---|---|---|---|---|
| Policy referee CLI; service remains only a future candidate | Existing private monorepo package `a2a-policy-referee`; no scoped rename or publication is approved | Existing offline `a2a-policy-referee check POLICY.json TASK.json WORKER.json`; no service mode | Versioned closed decision envelope and bounded public-safe golden/negative fixtures; no audit artifact | Pinned source base `487b1d0315e4b891c22d373908de83aabdf95872`; `packages/policy-referee/src/broker-policy.ts`, `contracts/a2a/broker-policy.md`, and package-owned fixtures/tests | `npm run check -w packages/policy-referee && npm run build -w packages/policy-referee && npm test -w packages/policy-referee && npm run fixtures:replay -w packages/policy-referee`; package-CI parity also proves package contents | Offline evaluation only. Must not change live broker policy/config, create/claim call sites, worker-class derivation, audits, runtime enforcement, or broker imports. Separate-repository extraction, service mode, and publication remain unproven and unapproved. |
| Agent work proof verifier/SDK | `@jinwon-int/a2a-agent-work-proof` | `a2a-agent-work-proof-verify` | Work-proof bundle, artifact manifest, signed work-proof verdict. | `contracts/a2a/agent-work-proof.md`, `fixtures/contract/agent-work-proof-bundle.json`, `scripts/verify-agent-work-proof.mjs`, `test/conformance/check-agent-work-proof.mjs`. | `node scripts/verify-agent-work-proof.mjs fixtures/contract/agent-work-proof-bundle.json --keyring fixtures/contract/agent-work-proof-keyring.json` | Proves evidence integrity and composition only; no payment/release authorization or correctness guarantee. |
| Escrow release proof adapter | `@jinwon-int/a2a-escrow-proof` | `a2a-escrow-proof-verify` | Release-condition proof, signed release verdict, no-live adapter transcript. | `contracts/a2a/escrow-release-proof.md`, `fixtures/contract/escrow-release-proof.json`, `scripts/verify-escrow-release-proof.mjs`, `test/conformance/check-escrow-release-proof.mjs`. | `node scripts/verify-escrow-release-proof.mjs fixtures/contract/escrow-release-proof.json --keyring fixtures/contract/escrow-release-proof-keyring.json` | Proof-of-condition only; no custody, funds movement, rail call, or release execution. |
| Agent payment dispute packet | `@jinwon-int/a2a-payment-dispute-packet` | `a2a-payment-dispute-verify` | User-delegation/scope/completion/release evidence packet. | `contracts/a2a/agent-payment-dispute-packet.md`, `fixtures/contract/agent-payment-dispute-packet.json`, `scripts/verify-agent-payment-dispute-packet.mjs`, `test/conformance/check-agent-payment-dispute-packet.mjs`. | `node scripts/verify-agent-payment-dispute-packet.mjs fixtures/contract/agent-payment-dispute-packet.json --keyring fixtures/contract/agent-payment-dispute-packet-keyring.json` | Dispute evidence only; no PCI/card data handling, payment execution, or final chargeback/legal-liability decision. |
| Verifiable analysis report generator/viewer | `@jinwon-int/a2a-verifiable-analysis-report` | `a2a-analysis-report-verify` | Report package, source manifest, signed finalizer verdict. | `contracts/a2a/verifiable-analysis-report.md`, `fixtures/contract/verifiable-analysis-report-product.json`, `scripts/verify-analysis-report.mjs`, `test/conformance/check-verifiable-analysis-report-product.mjs`. | `node scripts/verify-analysis-report.mjs fixtures/contract/verifiable-analysis-report-product.json --keyring fixtures/contract/verifiable-analysis-report-product-keyring.json` for the product fixture, plus `node test/conformance/check-verifiable-analysis-report-product.mjs` as the G0 gate. | Proves report grounding/integrity only; not analytical correctness or publication approval. |
| Certification battery packs | `@jinwon-int/a2a-certification-battery` | `a2a-certification-battery-verify` | Battery pack, result, signed verdict, finite artifact certificate. | `contracts/a2a/certification-battery.md`, `fixtures/contract/certification-battery.json`, `test/conformance/check-certification-battery.mjs`. | `node test/conformance/check-certification-battery.mjs` | Finite deterministic checks only; no registry badge, quality marketing, or package publication claim. |
| Docker runner package | `@openclaw/a2a-docker-runner` or a renamed Nexus package after approval | `a2a-docker-runner` | Runner CLI package and isolated execution evidence. | `packages/docker-runner/`, runner hardening checks, public demo safety audit. | `npm -w packages/docker-runner run verify:package` plus package contents audit in a disposable candidate environment. | Runner packaging only; no production runner deploy, credential movement, or live broker enrollment. |

### Current #1480 policy-referee source slice

On the pinned source base
`487b1d0315e4b891c22d373908de83aabdf95872`, the existing private
`packages/policy-referee` boundary now proves only these additional claims:

- the package exposes a deterministic built CLI with the documented
  `a2a-policy-referee check POLICY.json TASK.json WORKER.json` shape;
- task and worker inputs are versioned, closed, anonymous, and public-safe;
- the CLI calls the package's existing `validateBrokerPolicyDocument` and
  `evaluateTaskPolicy` functions instead of importing or duplicating broker
  runtime semantics;
- stdout is a versioned closed decision envelope, stderr is bounded
  non-reflecting metadata, and process exits distinguish allow,
  require-approval, deny, invalid input, and internal failure;
- package-owned golden and negative fixtures are replayed by pure and
  child-process tests.

This evidence does not prove or authorize issue completion, a separate
repository, publication, service mode, live broker integration, a live policy
change, task creation/claiming, audit emission, deployment, provider traffic,
or any operator approval.

## Split readiness checklist

A future extraction PR should include all of the following before claiming a candidate is ready to leave Nexus:

- [ ] candidate repository name and owner;
- [ ] Nexus upstream commit SHA;
- [ ] source contract(s), fixture(s), verifier(s), and conformance test(s);
- [ ] package name, CLI name(s), exported modules, artifact type, and package contents inventory;
- [ ] dependency-direction statement: product consumes pinned Nexus contract; Nexus does not consume product runtime;
- [ ] local verification output from a disposable checkout;
- [ ] `npm run check:markdown-links`;
- [ ] `npm run scan:public-readiness`;
- [ ] `npm run scan:external-secrets` with only accepted synthetic fixture findings;
- [ ] `npm run check` or a documented reason for a narrower PR gate;
- [ ] release/publication non-authorization language;
- [ ] rollback/deprecation note for contract drift;
- [ ] operator approval reference for any repository creation, visibility change, tag, release, npm/Docker/GHCR publication, homepage metadata, or live deployment.

## Non-goals for G0

This document does not authorize:

- creating or transferring repositories;
- moving source files out of `a2a-nexus`;
- publishing npm packages, Docker images, GHCR images, tags, releases, badges, or homepage metadata;
- deploying/restarting brokers, workers, gateways, runners, or adapters;
- changing live broker policy mode/config, task admission/claim policy evaluation, workerClass derivation, or policy audit schema/action names;
- provider/Telegram sends, terminal-outbox ACK/replay, DB/outbox/prune/migration changes, or credential/signing-key movement;
- payment rail calls, funds movement, escrow custody, PCI/card data handling, or final legal/chargeback decisions.

Those actions need separate explicit approval and their own verification/rollback evidence.
