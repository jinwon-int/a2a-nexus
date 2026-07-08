#!/usr/bin/env node
/**
 * Independent offline verifier for A2A Completion Certificate v0 (#1393).
 *
 * Contract: contracts/a2a/completion-certificate.md
 *
 * A completion certificate packages task-completion condition results into a
 * signed, offline-verifiable proof object. This verifier answers a fail-closed
 * INTEGRITY question only: is the certificate well-formed, bound to the expected
 * subject when supplied, signed by a configured issuer key, within its validity
 * window, and honest about its assurance/payment boundary?
 *
 * It does NOT authorize payment release, move funds, call rails/providers,
 * mutate broker state, ACK/replay Terminal Brief records, deploy/restart, or
 * move secrets/signing keys.
 *
 * Usage:
 *   node scripts/verify-completion-certificate.mjs <certificate.json> --keyring <keyring.json> \
 *     [--expected-subject <subject.json>] [--now <iso>] [--json]
 * Exit 0 = certificate integrity OK; non-zero = fail-closed.
 */
import fs from 'node:fs';
import { parseArgs } from 'node:util';

import { verifyCompletionCertificate } from './lib/completion-certificate-verifier.mjs';

function readJson(path, label) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(path, 'utf8')) };
  } catch (error) {
    return { ok: false, error: `cannot read ${label}: ${error.message}` };
  }
}

function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      keyring: { type: 'string' },
      'expected-subject': { type: 'string' },
      now: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  });

  const certificatePath = positionals[0];
  if (!certificatePath || !values.keyring) {
    process.stderr.write('usage: verify-completion-certificate.mjs <certificate.json> --keyring <keyring.json> [--expected-subject <subject.json>] [--now <iso>] [--json]\n');
    return 2;
  }

  const certificate = readJson(certificatePath, 'certificate');
  if (!certificate.ok) {
    process.stderr.write(`${certificate.error}\n`);
    return 2;
  }
  const keyring = readJson(values.keyring, 'keyring');
  if (!keyring.ok) {
    process.stderr.write(`${keyring.error}\n`);
    return 2;
  }

  let expectedSubject;
  if (values['expected-subject']) {
    const parsed = readJson(values['expected-subject'], 'expected subject');
    if (!parsed.ok) {
      process.stderr.write(`${parsed.error}\n`);
      return 2;
    }
    expectedSubject = parsed.value;
  }

  const result = verifyCompletionCertificate(certificate.value, keyring.value, {
    expectedSubject,
    now: values.now,
  });

  if (values.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    for (const check of result.checks) {
      process.stdout.write(`${check.ok ? 'PASS' : 'FAIL'}  ${check.id}${check.detail ? ` — ${check.detail}` : ''}\n`);
    }
    process.stdout.write(`\n${result.valid ? `OK — completion certificate integrity verified (decision=${result.decision})` : 'RED — completion certificate verification failed (fail-closed)'}\n`);
  }
  return result.valid ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
