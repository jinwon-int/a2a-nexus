#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    spec: { type: 'string', default: 'docs/readiness/fail-closed-gates.json' },
    input: { type: 'string' },
  },
});

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read JSON ${file}: ${error.message}`);
  }
}

function hasEvidence(value) {
  return Array.isArray(value?.evidence) && value.evidence.some((entry) => typeof entry === 'string' && entry.trim());
}

const unredactedEvidenceRules = [
  {
    kind: 'secret-assignment',
    re: /\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY)[A-Z0-9_]*\s*=\s*['"]?(?!<|\$\{|YOUR_|redacted|REDACTED)[^'"\s#]{12,}/i,
  },
  { kind: 'github-token-shape', re: /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/ },
  { kind: 'aws-access-key-shape', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: 'absolute-private-path', re: /\/(?:home|Users)\/[^\s'")`]+|\/root\/private\/[^\s'")`]+/ },
  { kind: 'raw-session-dump', re: /(?:^|\n)\s*(?:system|developer|assistant|user|tool)\s*<\|/i },
];

function evidenceEntries(gateStatuses) {
  return Object.entries(gateStatuses).flatMap(([gateId, gate]) => {
    if (!Array.isArray(gate?.evidence)) return [];
    return gate.evidence
      .filter((entry) => typeof entry === 'string' && entry.trim())
      .map((entry) => ({ gateId, entry }));
  });
}

const mandatoryGoGates = [
  'publicPrivateBoundary',
  'terminalEvidence',
  'replaySafety',
  'externalScannerEvidence',
  'runtimeBootstrapHygiene',
  'goNoGoMatrix',
  'redactedEvidencePolicy',
  'operatorApproval',
];

function validateSpec(spec) {
  const failures = [];
  if (spec.failClosed !== true) failures.push('spec.failClosed must be true');
  if (spec.defaultDecision !== 'NO-GO') failures.push('spec.defaultDecision must be NO-GO');
  if (!Array.isArray(spec.goDecisionRequires) || spec.goDecisionRequires.length === 0) {
    failures.push('spec.goDecisionRequires must list required GO gates');
  }
  if (!Array.isArray(spec.gates) || spec.gates.length === 0) failures.push('spec.gates must be non-empty');

  const goDecisionRequires = new Set(spec.goDecisionRequires || []);
  for (const id of mandatoryGoGates) {
    if (!goDecisionRequires.has(id)) failures.push(`spec.goDecisionRequires missing mandatory gate: ${id}`);
  }

  const gates = new Map((spec.gates || []).map((gate) => [gate.id, gate]));
  for (const id of spec.goDecisionRequires || []) {
    const gate = gates.get(id);
    if (!gate) {
      failures.push(`required gate missing from spec.gates: ${id}`);
      continue;
    }
    if (gate.failClosed !== true) failures.push(`${id}: failClosed must be true`);
    if (gate.requiredForGo !== true) failures.push(`${id}: requiredForGo must be true`);
    if (!gate.blockedWhenMissing) failures.push(`${id}: blockedWhenMissing is required`);
    if (!hasEvidence(gate)) failures.push(`${id}: gate evidence requirements must be documented`);
  }

  const hygiene = gates.get('runtimeBootstrapHygiene');
  if (hygiene) {
    const denyPaths = new Set(hygiene.denyPaths || []);
    for (const requiredPath of ['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'HEARTBEAT.md', 'IDENTITY.md', '.openclaw/**']) {
      if (!denyPaths.has(requiredPath)) failures.push(`runtimeBootstrapHygiene.denyPaths missing ${requiredPath}`);
    }
  }

  return failures;
}

function evaluateInput(spec, input) {
  const blockers = [];
  const gateStatuses = input.gates && typeof input.gates === 'object' ? input.gates : {};
  const decision = String(input.decision || spec.defaultDecision || 'NO-GO').trim().toUpperCase();

  if (decision !== 'GO' && decision !== 'NO-GO') {
    // Fail closed on malformed decisions: every evidence check below is keyed
    // on an exact 'GO' match, so an unrecognized value must never sail through.
    return {
      ok: false,
      decision,
      blockers: [`decision: unrecognized value ${JSON.stringify(input.decision)} (expected GO or NO-GO)`],
    };
  }

  for (const id of spec.goDecisionRequires || []) {
    const gate = gateStatuses[id];
    const status = String(gate?.status || 'MISSING').toUpperCase();
    if (status !== 'GO') blockers.push(`${id}: status is ${status}`);
    if (!hasEvidence(gate)) blockers.push(`${id}: redacted evidence link is missing`);
  }

  if (decision === 'GO') {
    for (const { gateId, entry } of evidenceEntries(gateStatuses)) {
      for (const rule of unredactedEvidenceRules) {
        if (rule.re.test(entry)) blockers.push(`${gateId}: evidence is not redacted (${rule.kind})`);
      }
    }

    const operatorEvidence = new Set(
      (gateStatuses.operatorApproval?.evidence || [])
        .filter((entry) => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter(Boolean),
    );
    if (operatorEvidence.size === 0) {
      blockers.push('operatorApproval: separate operator approval evidence is required');
    } else {
      for (const { gateId, entry } of evidenceEntries(gateStatuses)) {
        if (gateId !== 'operatorApproval' && operatorEvidence.has(entry.trim())) {
          blockers.push(`operatorApproval: approval evidence must be separate from ${gateId}`);
        }
      }
    }
  }

  if (decision === 'GO' && blockers.length) {
    return { ok: false, decision, blockers };
  }
  return { ok: true, decision, blockers };
}

try {
  const specPath = path.resolve(values.spec);
  const spec = readJson(specPath);
  const specFailures = validateSpec(spec);
  if (specFailures.length) {
    console.error(JSON.stringify({ ok: false, phase: 'spec', failures: specFailures }, null, 2));
    process.exit(1);
  }

  if (!values.input) {
    console.log(JSON.stringify({ ok: true, phase: 'spec', decision: spec.defaultDecision, requiredGates: spec.goDecisionRequires }, null, 2));
    process.exit(0);
  }

  const input = readJson(path.resolve(values.input));
  const result = evaluateInput(spec, input);
  const output = { ok: result.ok, phase: 'input', decision: result.decision, blockers: result.blockers };
  if (!result.ok) {
    console.error(JSON.stringify(output, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(output, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
}
