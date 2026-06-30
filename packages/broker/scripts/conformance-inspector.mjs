#!/usr/bin/env node
/**
 * a2a-inspector bridge preflight.
 *
 * This does not shell out to a mutable online inspector by default. It produces
 * a stable CI artifact for local Agent Card inputs and records whether a pinned
 * external inspector command was provided by the operator.
 */
import { readFileSync, writeFileSync } from 'node:fs';

function option(name) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function validateAgentCard(card) {
  const errors = [];
  for (const key of ['name', 'description', 'url', 'version', 'protocolVersion']) {
    if (typeof card?.[key] !== 'string' || !card[key].trim()) errors.push(`missing ${key}`);
  }
  if (!card?.capabilities || typeof card.capabilities.streaming !== 'boolean') errors.push('missing capabilities.streaming');
  if (!Array.isArray(card?.supportedInterfaces) || !card.supportedInterfaces.some((x) => x.protocolBinding === 'JSONRPC' && typeof x.url === 'string')) {
    errors.push('missing JSONRPC supportedInterfaces entry');
  }
  if (!Array.isArray(card?.skills) || card.skills.length === 0) errors.push('missing skills');
  return errors;
}

function main() {
  const agentCardPath = option('--agent-card');
  if (!agentCardPath) throw new Error('missing --agent-card');
  const card = JSON.parse(readFileSync(agentCardPath, 'utf8'));
  const errors = validateAgentCard(card);
  const externalCommand = option('--external-command') ?? '';
  const report = {
    schemaVersion: 'a2a-inspector-bridge.v1',
    ok: errors.length === 0,
    harness: 'a2aproject/a2a-inspector',
    mode: externalCommand ? 'operator-provided-command' : 'local-agent-card-preflight',
    externalCommandProvided: Boolean(externalCommand),
    headlessCaveat: externalCommand ? null : 'No pinned a2a-inspector headless command was provided; CI performs local Agent Card preflight and stores an artifact.',
    checks: [{ name: 'agent-card-required-fields', status: errors.length === 0 ? 'pass' : 'fail', errors }],
    safety: { sourceOnly: true, noLive: true, productionBrokerRequired: false, secretRequired: false },
  };
  const out = option('--out');
  if (out) writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}
try { main(); } catch (error) { console.error(`conformance-inspector: ${error.message}`); process.exit(1); }
