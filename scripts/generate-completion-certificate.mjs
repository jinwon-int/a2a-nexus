#!/usr/bin/env node
/**
 * Report-only completion certificate generator (#1393 slice 3).
 *
 * Converts a public-safe, no-live completion report JSON into a signed
 * `a2a.completion.certificate.v0` object that can be checked offline with
 * `scripts/verify-completion-certificate.mjs`.
 *
 * This does NOT authorize payment release, call payment rails/providers, move
 * funds, mutate broker/DB/outbox state, ACK/replay Terminal Brief records,
 * deploy/restart, release packages, or move signing keys/secrets.
 *
 * Usage:
 *   node scripts/generate-completion-certificate.mjs <report.json> \
 *     --signing-key <ed25519-private.pem> --issuer-key-id <kid> \
 *     --issuer-broker-id <broker> [--issued-at <iso>] [--expires-at <iso>] \
 *     [--out <certificate.json>]
 */
import fs from 'node:fs';
import { parseArgs } from 'node:util';

import { generateCompletionCertificate } from './lib/completion-certificate-generator.mjs';

function readJson(path, label) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(path, 'utf8')) };
  } catch (error) {
    return { ok: false, error: `cannot read ${label}: ${error.message}` };
  }
}

function readText(path, label) {
  try {
    return { ok: true, value: fs.readFileSync(path, 'utf8') };
  } catch (error) {
    return { ok: false, error: `cannot read ${label}: ${error.message}` };
  }
}

function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'signing-key': { type: 'string' },
      'issuer-key-id': { type: 'string' },
      'issuer-broker-id': { type: 'string' },
      'issued-at': { type: 'string' },
      'expires-at': { type: 'string' },
      out: { type: 'string' },
    },
  });

  const reportPath = positionals[0];
  if (!reportPath || !values['signing-key']) {
    process.stderr.write('usage: generate-completion-certificate.mjs <report.json> --signing-key <ed25519-private.pem> [--issuer-key-id <kid>] [--issuer-broker-id <broker>] [--issued-at <iso>] [--expires-at <iso>] [--out <certificate.json>]\n');
    return 2;
  }
  const report = readJson(reportPath, 'completion report');
  if (!report.ok) {
    process.stderr.write(`${report.error}\n`);
    return 2;
  }
  const key = readText(values['signing-key'], 'signing key');
  if (!key.ok) {
    process.stderr.write(`${key.error}\n`);
    return 2;
  }

  let certificate;
  try {
    certificate = generateCompletionCertificate(report.value, {
      signingKeyPem: key.value,
      issuerKeyId: values['issuer-key-id'],
      issuerBrokerId: values['issuer-broker-id'],
      issuedAt: values['issued-at'],
      expiresAt: values['expires-at'],
    });
  } catch (error) {
    process.stderr.write(`completion certificate generation failed: ${error.message}\n`);
    return 1;
  }

  const rendered = `${JSON.stringify(certificate, null, 2)}\n`;
  if (values.out) {
    fs.writeFileSync(values.out, rendered, { mode: 0o600 });
  } else {
    process.stdout.write(rendered);
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
