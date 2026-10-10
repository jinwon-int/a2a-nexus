#!/usr/bin/env node
/**
 * Offline verifier for source-only A2A Agent Payment Dispute Packets (#1488).
 *
 * This verifier checks user-delegation/scope/completion/release evidence
 * integrity. It does NOT call payment rails, authorize payment, move funds,
 * custody escrow, decide chargeback liability, deploy webhooks, contact
 * providers, mutate broker state, or use secrets.
 */
import { verifyAgentPaymentDisputePacket } from './lib/agent-payment-dispute-packet-verifier.mjs';
import { runVerifierCli } from './lib/a2a-offline-verify.mjs';

function main(argv) {
  return runVerifierCli(argv, {
    usage: 'usage: verify-agent-payment-dispute-packet.mjs <packet.json> --keyring <keyring.json> [--now ISO] [--json]',
    inputLabel: 'packet',
    verify: verifyAgentPaymentDisputePacket,
    summary: (result) => (result.releaseAllowed ? 'GREEN — dispute packet supports source-only release authorization evidence' : 'RED/PENDING — release is not authorized by this packet (fail-closed)'),
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
