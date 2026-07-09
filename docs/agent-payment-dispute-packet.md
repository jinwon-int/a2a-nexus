# Agent payment dispute packet

**Do not ask a PSP or operator to trust a story about an agentic payment. Give them a local packet that binds user delegation, agent identity, task scope, completion proof, and release decision — and make clear what it does not prove.**

The `a2a-agent-payment-dispute-packet` sample is a source-only proof slice for [#1488](https://github.com/jinwon-int/a2a-nexus/issues/1488). It builds on the [escrow release proof](escrow-proof.md) slice and remains outside live payment rails.

## What it verifies

The sample verifier checks that a dispute packet:

1. carries a user-delegation mandate as a machine-verifiable hash-bound object;
2. binds the mandate to the agent identity that performed the task;
3. recomputes the task scope decision from intent, amount, merchant/product, deadline, fresh-approval state, payment reference, and completion proof;
4. embeds a valid source-only escrow release proof;
5. binds the release decision to a signed finalizer verdict;
6. contains required `doesNotProve` disclaimers; and
7. remains public-safe and no-live.

## Try it locally

```bash
node scripts/verify-agent-payment-dispute-packet.mjs \
  fixtures/contract/agent-payment-dispute-packet.json \
  --keyring fixtures/contract/agent-payment-dispute-packet-keyring.json \
  --json
```

Expected high-level output:

```json
{
  "green": true,
  "decision": "release_authorized",
  "expectedDecision": "release_authorized",
  "releaseAllowed": true
}
```

`green=true` means the packet is internally consistent and offline-verifiable. `releaseAllowed=true` means only that this source-only packet supports a release-authorization evidence claim. It does **not** execute payment.

## Fail-closed examples

The conformance check mutates the fixture and confirms that these cases fail closed:

- no mandate;
- invalid mandate verification;
- agent identity not bound to the mandate;
- raw/non-hash payment reference;
- amount above the mandate cap;
- merchant/product outside scope;
- expired mandate;
- fresh approval required but missing;
- payment reference not bound to task/release proof;
- tampered escrow release proof;
- completion proof mismatch;
- release decision not recomputable from evidence;
- signed packet verdict subject mismatch;
- missing `doesNotProve` boundaries;
- private path / token / provider ID / Telegram ID / raw card shaped data markers;
- product extraction or PSP adapter enablement before fresh approval.

Run:

```bash
node test/conformance/check-agent-payment-dispute-packet.mjs
```

## What it does not prove

Every valid packet must explicitly state that it does not prove:

- card-network authorization;
- funds availability;
- legal identity of the human;
- tax or regulatory compliance;
- final chargeback liability;
- payment rail execution;
- PCI card-data handling.

## Boundary

This layer is useful to payment companies because it does **not** compete with payment rails. Rails keep authorization, tokenization, settlement, fraud, and formal disputes. Nexus adds offline-verifiable evidence for agent delegation, scope, completion, and release-condition evaluation.

Still out of scope without separate fresh approval:

- live PSP/rail calls;
- payment authorization;
- capture, payout, refund, release execution;
- escrow custody;
- production webhook deployment;
- provider credentials or signing-key movement;
- package/repo extraction, registry/badge publication, or public release claim.
