# a2a-policy-referee

Declarative worker-class policy engine for A2A brokers (#1601 P1; spin-off
candidate #1480). One operator-committed document declares what anonymous
worker CLASSES (`mobile` | `vps` | `source-only` | `unclassified` | `*`) may
do; `warn` mode logs structurally, `enforce` mode denies.

- Contract: `contracts/a2a/broker-policy.md`
- Match axis is the anonymous worker class only — concrete worker names are
  rejected fail-closed by the validator, so a committed policy document can
  never leak fleet identity.
- Evaluation is a pure decision (`evaluateTaskPolicy`); the caller owns mode
  semantics and audit emission.

This package was extracted from `packages/broker/src/core/broker-policy.ts`
with its contract unchanged. The broker imports it through the package
boundary — the same boundary a future standalone-repo extraction would use
(modularize-first, extract-second).
