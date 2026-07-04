#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const DEFAULT_PATTERNS = [
  'task readiness spec_underspecified',
  'task readiness source_projection_empty',
  'source_projection_blocked',
  'openclaw_analysis_failed',
  'acceptance_malformed',
];

function sanitizeLine(line) {
  return String(line)
    .replace(/([A-Z0-9_]*SECRET[A-Z0-9_]*=)[^\s]+/gi, '$1[REDACTED]')
    .replace(/(token=)[^\s]+/gi, '$1[REDACTED]')
    .slice(0, 500);
}

export function aggregateWarnLogs(inputs, options = {}) {
  const patterns = options.patterns ?? DEFAULT_PATTERNS;
  const sampleLimit = Math.max(0, Number(options.sampleLimit ?? 10));
  const result = {};
  for (const input of inputs) {
    const name = input.name ?? input.path ?? '<stdin>';
    const text = String(input.text ?? '');
    const entry = { lines: text.length ? text.split(/\r?\n/).filter((line) => line.length > 0).length : 0 };
    for (const pattern of patterns) entry[pattern] = text.split(pattern).length - 1;
    const samples = [];
    for (const line of text.split(/\r?\n/)) {
      if (line.includes('[a2a-broker] task readiness') || line.includes('source_projection_blocked')) {
        samples.push(sanitizeLine(line));
        if (samples.length >= sampleLimit) break;
      }
    }
    entry.samples = samples;
    result[name] = entry;
  }
  return result;
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'sample-limit': { type: 'string', default: '10' },
    },
  });
  const files = positionals.length ? positionals : ['-'];
  const inputs = files.map((path) => ({
    path,
    text: path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8'),
  }));
  process.stdout.write(`${JSON.stringify(aggregateWarnLogs(inputs, { sampleLimit: values['sample-limit'] }), null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
