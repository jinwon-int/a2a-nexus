#!/usr/bin/env node
/**
 * Offline verifier for source-only A2A Agent Payment Dispute Packets (#1488).
 *
 * This verifier checks user-delegation/scope/completion/release evidence
 * integrity. It does NOT call payment rails, authorize payment, move funds,
 * custody escrow, decide chargeback liability, deploy webhooks, contact
 * providers, mutate broker state, or use secrets.
 */
import fs from 'node:fs';
import { parseArgs } from 'node:util';

import { verifyAgentPaymentDisputePacket } from './lib/agent-payment-dispute-packet-verifier.mjs';

function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      keyring: { type: 'string' },
      json: { type: 'boolean', default: false },
      now: { type: 'string' },
    },
  });
  const packetPath = positionals[0];
  if (!packetPath || !values.keyring) {
    process.stderr.write('usage: verify-agent-payment-dispute-packet.mjs <packet.json> --keyring <keyring.json> [--now ISO] [--json]\n');
    return 2;
  }
  let packet;
  let keyring;
  try {
    packet = JSON.parse(fs.readFileSync(packetPath, 'utf8'));
  } catch (err) {
    process.stderr.write(`cannot read packet: ${err.message}\n`);
    return 2;
  }
  try {
    keyring = JSON.parse(fs.readFileSync(values.keyring, 'utf8'));
  } catch (err) {
    process.stderr.write(`cannot read keyring: ${err.message}\n`);
    return 2;
  }
  const result = verifyAgentPaymentDisputePacket(packet, keyring, { now: values.now });
  if (values.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    for (const check of result.checks) {
      process.stdout.write(`${check.ok ? 'PASS' : 'FAIL'}  ${check.id}${check.detail ? ` — ${check.detail}` : ''}\n`);
    }
    process.stdout.write(`\n${result.releaseAllowed ? 'GREEN — dispute packet supports source-only release authorization evidence' : 'RED/PENDING — release is not authorized by this packet (fail-closed)'}\n`);
  }
  return result.green ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
