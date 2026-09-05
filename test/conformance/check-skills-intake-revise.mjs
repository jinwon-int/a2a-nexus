#!/usr/bin/env node
// Deterministic, no-network conformance for the skills intake revise round
// (`skills.skill-intake-revise.v1`, jinwon-int/a2a-nexus#2007, R2 of
// jinwon-int/ccc-node#1357).
//
// Source-only: validates the fixture packet and results against the contract
// in docs/skills-intake-revise.md — packet envelope, the reversed
// independence rule (the reviser IS the author node), the exclusive result
// shapes (revised ⇔ skillFiles, drop_recommendation ⇔ dropRecommendation
// with a reason), the skillName/sourceTreeSha256 bindings, and the round cap
// (2 per skill lineage). Findings must carry at least one major/blocker — a
// revise round motivated only by minor/info findings would contradict the
// review gate's severity floor. Daily-cap and one-dispatch-per-head rules are
// publisher-side runtime behaviors, not packet/result contract, so they stay
// out of scope here.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const FIXTURE_PATH = path.join(ROOT, 'fixtures', 'contract', 'skills-intake-revise.json');
const RUNNER_PATH = path.join(ROOT, 'test', 'conformance', 'run-conformance.mjs');
const FIXTURES_MAP_PATH = path.join(ROOT, 'test', 'conformance', 'check-contract-fixtures.mjs');
const THIS_PATH = path.join(ROOT, 'test', 'conformance', 'check-skills-intake-revise.mjs');
const DOC_PATH = path.join(ROOT, 'docs', 'skills-intake-revise.md');

// --- contract constants (docs/skills-intake-revise.md) ----------------------

const PACKET_SCHEMA = 'skills.skill-intake-revise.v1';
const SCOPES = new Set(['fleet-internal', 'public-elevation']);
const OUTCOMES = new Set(['revised', 'drop_recommendation']);
const SEVERITIES = new Set(['info', 'minor', 'major', 'blocker']);
const FINDING_AREAS = new Set(['secrets', 'duplication', 'claims', 'structure', 'utility']);
const MAX_SKILL_FILES = 16;
const MAX_SKILL_FILE_BYTES = 64 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const GIT_HEAD_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const RUBRIC_VERSION = /^\d{4}-\d{2}-\d{2}\.\d+$/;
// docs: "Round cap: 2 revision rounds per skill lineage".
const DOCUMENTED_ROUND_CAP = 2;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// --- validators -------------------------------------------------------------

function validateFileSet(files, label, errors) {
  if (!Array.isArray(files) || files.length === 0) {
    errors.push(`${label} must be a non-empty array of {path, content}`);
    return;
  }
  if (files.length > MAX_SKILL_FILES) {
    errors.push(`${label} exceeds the ${MAX_SKILL_FILES}-file bound`);
  }
  const seen = new Set();
  for (const file of files) {
    if (!isPlainObject(file) || typeof file.path !== 'string' || file.path.length === 0) {
      errors.push(`${label} entries must carry a non-empty path`);
      continue;
    }
    if (typeof file.content !== 'string') {
      errors.push(`${label}['${file.path}'].content must be a string`);
      continue;
    }
    if (Buffer.byteLength(file.content, 'utf8') > MAX_SKILL_FILE_BYTES) {
      errors.push(`${label}['${file.path}'].content exceeds the 64KiB per-file bound`);
    }
    if (seen.has(file.path)) {
      errors.push(`${label} has duplicate path '${file.path}'`);
    }
    seen.add(file.path);
  }
}

export function validatePacket(packet) {
  const errors = [];
  const warnings = [];

  if (!isPlainObject(packet)) {
    errors.push('packet must be a JSON object');
    return { errors, warnings };
  }
  if (packet.schema !== PACKET_SCHEMA) {
    errors.push(`packet.schema must be "${PACKET_SCHEMA}"`);
  }
  if (typeof packet.rubricVersion !== 'string' || !RUBRIC_VERSION.test(packet.rubricVersion)) {
    errors.push('packet.rubricVersion must match YYYY-MM-DD.N');
  }
  if (packet.scope !== undefined) {
    if (!SCOPES.has(packet.scope)) {
      errors.push(`packet.scope must be one of ${[...SCOPES].join('|')}`);
    }
  } else {
    warnings.push('packet.scope absent — defaults to fleet-internal');
  }
  if (typeof packet.skillName !== 'string' || packet.skillName.length === 0) {
    errors.push('packet.skillName must be a non-empty string');
  }

  const prov = packet.provenance;
  if (!isPlainObject(prov)) {
    errors.push('packet.provenance must be an object');
  } else {
    if (typeof prov.author_node !== 'string' || prov.author_node.length === 0) {
      errors.push('packet.provenance.author_node must be a non-empty string');
    }
    if (typeof prov.provider !== 'string' || prov.provider.length === 0) {
      errors.push('packet.provenance.provider must be a non-empty string');
    }
    if (!Number.isInteger(prov.intake_pr) || prov.intake_pr < 1) {
      errors.push('packet.provenance.intake_pr must be a positive integer');
    }
    if (typeof prov.branch !== 'string' || prov.branch.length === 0) {
      errors.push('packet.provenance.branch must be a non-empty string');
    }
    if (typeof prov.head_sha !== 'string' || !GIT_HEAD_SHA.test(prov.head_sha)) {
      errors.push('packet.provenance.head_sha must be a 40-hex git sha');
    }
    if (typeof prov.source_tree_sha256 !== 'string' || !SHA256_HEX.test(prov.source_tree_sha256)) {
      errors.push('packet.provenance.source_tree_sha256 must be 64-hex sha256');
    }
    if (!Number.isInteger(prov.revise_round) || prov.revise_round < 1) {
      errors.push('packet.provenance.revise_round must be a positive integer');
    }
    if (!Number.isInteger(prov.revise_round_limit) || prov.revise_round_limit < 1) {
      errors.push('packet.provenance.revise_round_limit must be a positive integer');
    } else if (prov.revise_round_limit > DOCUMENTED_ROUND_CAP) {
      errors.push(`packet.provenance.revise_round_limit exceeds the documented round cap (${DOCUMENTED_ROUND_CAP})`);
    }
    if (Number.isInteger(prov.revise_round) && Number.isInteger(prov.revise_round_limit) && prov.revise_round > prov.revise_round_limit) {
      errors.push('packet.provenance.revise_round exceeds revise_round_limit');
    }
  }

  const findings = packet.findings;
  if (!Array.isArray(findings) || findings.length === 0) {
    errors.push('packet.findings must be a non-empty array of review findings');
  } else {
    let motivating = false;
    for (const finding of findings) {
      if (!isPlainObject(finding)) {
        errors.push('packet.findings entries must be objects');
        continue;
      }
      if (!SEVERITIES.has(finding.severity)) {
        errors.push(`finding.severity must be one of ${[...SEVERITIES].join('|')}`);
        continue;
      }
      if (!FINDING_AREAS.has(finding.area)) {
        errors.push(`finding.area must be one of ${[...FINDING_AREAS].join('|')}`);
      }
      if (typeof finding.note !== 'string' || finding.note.length === 0) {
        errors.push('finding.note must be a non-empty string');
      }
      if (finding.severity === 'major' || finding.severity === 'blocker') {
        motivating = true;
      }
    }
    // Cross-contract consistency with the review gate: a revise verdict
    // implies at least one major/blocker finding (review severity floor), so
    // a revise round without one is malformed motivation.
    if (!motivating) {
      errors.push('packet.findings must include at least one major or blocker finding (a revise verdict over minor-only findings contradicts the review severity floor)');
    }
  }

  validateFileSet(packet.skillFiles, 'packet.skillFiles', errors);

  if (!isPlainObject(packet.reviseResultSchema)) {
    errors.push('packet.reviseResultSchema must embed the expected result shape');
  }
  if (typeof packet.workerProcedure !== 'string' || packet.workerProcedure.length === 0) {
    errors.push('packet.workerProcedure must reference this document worker-procedure section');
  }

  return { errors, warnings };
}

export function validateResult(result, packet) {
  const errors = [];
  const warnings = [];

  if (!isPlainObject(result)) {
    errors.push('result must be a JSON object');
    return { errors, warnings };
  }
  if (!OUTCOMES.has(result.outcome)) {
    errors.push(`result.outcome must be one of ${[...OUTCOMES].join('|')}`);
  }
  if (typeof result.skillName !== 'string' || result.skillName.length === 0) {
    errors.push('result.skillName must be a non-empty string');
  } else if (isPlainObject(packet) && packet.skillName !== undefined && result.skillName !== packet.skillName) {
    errors.push('result.skillName is not bound to packet.skillName');
  }
  if (typeof result.sourceTreeSha256 !== 'string' || !SHA256_HEX.test(result.sourceTreeSha256 || '')) {
    errors.push('result.sourceTreeSha256 must be 64-hex sha256');
  } else if (isPlainObject(packet) && isPlainObject(packet.provenance) && result.sourceTreeSha256 !== packet.provenance.source_tree_sha256) {
    errors.push('result.sourceTreeSha256 is not bound to packet.provenance.source_tree_sha256');
  }

  if (result.outcome === 'revised') {
    if (result.skillFiles === undefined) {
      errors.push('outcome=revised requires result.skillFiles');
    } else {
      validateFileSet(result.skillFiles, 'result.skillFiles', errors);
    }
    if (result.dropRecommendation !== undefined) {
      errors.push('outcome=revised must not carry dropRecommendation (result shapes are exclusive)');
    }
    if (typeof result.changeSummary !== 'string' || result.changeSummary.length === 0) {
      errors.push('outcome=revised requires a non-empty changeSummary');
    }
  } else if (result.outcome === 'drop_recommendation') {
    const drop = result.dropRecommendation;
    if (!isPlainObject(drop) || typeof drop.reason !== 'string' || drop.reason.length === 0) {
      errors.push('outcome=drop_recommendation requires dropRecommendation.reason');
    }
    if (result.skillFiles !== undefined) {
      errors.push('outcome=drop_recommendation must not carry skillFiles (result shapes are exclusive)');
    }
  }

  if (typeof result.model !== 'string' || result.model.length === 0) {
    errors.push('result.model must be a non-empty string');
  }
  if (typeof result.reviser_node !== 'string' || result.reviser_node.length === 0) {
    errors.push('result.reviser_node must be a non-empty string');
  } else if (isPlainObject(packet) && isPlainObject(packet.provenance) && result.reviser_node !== packet.provenance.author_node) {
    // Reversed independence: the revise round is dispatched to the AUTHOR
    // node, so a result from any other node is a routing violation.
    errors.push('result.reviser_node must be the packet author_node (the revise round runs on the author node)');
  }

  return { errors, warnings };
}

// --- negative matrix (deterministic mutations of the valid fixture) ---------

function packetCase(packet) {
  return { packet };
}

function buildNegativeCases(fixture) {
  const base = fixture.validPacket;
  const bigFile = { path: 'check-pr-cycle/SKILL.md', content: 'x'.repeat(MAX_SKILL_FILE_BYTES + 1) };
  const seventeen = Array.from({ length: MAX_SKILL_FILES + 1 }, (_, i) => ({
    path: `check-pr-cycle/file-${i}.md`,
    content: 'x',
  }));

  const revised = (mutate) => {
    const result = clone(fixture.validResults.revised);
    mutate(result);
    return { result, packet: clone(base) };
  };
  const drop = (mutate) => {
    const result = clone(fixture.validResults.drop_recommendation);
    mutate(result);
    return { result, packet: clone(base) };
  };

  return [
    {
      name: 'packet-schema-const',
      ...packetCase(mutatePacket(base, (p) => { p.schema = 'skills.wrong.v9'; })),
      errorContains: 'packet.schema',
    },
    {
      name: 'packet-skill-name-empty',
      ...packetCase(mutatePacket(base, (p) => { p.skillName = ''; })),
      errorContains: 'packet.skillName',
    },
    {
      name: 'packet-scope-enum',
      ...packetCase(mutatePacket(base, (p) => { p.scope = 'internal'; })),
      errorContains: 'packet.scope',
    },
    {
      name: 'packet-provenance-provider-missing',
      ...packetCase(mutatePacket(base, (p) => { delete p.provenance.provider; })),
      errorContains: 'provider',
    },
    {
      name: 'packet-provenance-revise-round-zero',
      ...packetCase(mutatePacket(base, (p) => { p.provenance.revise_round = 0; })),
      errorContains: 'revise_round',
    },
    {
      name: 'packet-round-cap-exceeded',
      ...packetCase(mutatePacket(base, (p) => { p.provenance.revise_round_limit = 3; })),
      errorContains: 'documented round cap',
    },
    {
      name: 'packet-round-over-limit',
      ...packetCase(mutatePacket(base, (p) => { p.provenance.revise_round = 2; p.provenance.revise_round_limit = 1; })),
      errorContains: 'revise_round exceeds revise_round_limit',
    },
    {
      name: 'packet-findings-empty',
      ...packetCase(mutatePacket(base, (p) => { p.findings = []; })),
      errorContains: 'packet.findings',
    },
    {
      name: 'packet-findings-minor-only',
      ...packetCase(mutatePacket(base, (p) => {
        p.findings = [{ severity: 'minor', area: 'structure', note: 'cosmetic only' }];
      })),
      errorContains: 'at least one major or blocker',
    },
    {
      name: 'packet-findings-severity-enum',
      ...packetCase(mutatePacket(base, (p) => { p.findings[0].severity = 'huge'; })),
      errorContains: 'finding.severity',
    },
    {
      name: 'packet-findings-area-enum',
      ...packetCase(mutatePacket(base, (p) => { p.findings[0].area = 'tone'; })),
      errorContains: 'finding.area',
    },
    {
      name: 'packet-skill-files-bound',
      ...packetCase(mutatePacket(base, (p) => { p.skillFiles = seventeen; })),
      errorContains: '16-file bound',
    },
    {
      name: 'packet-skill-file-bytes',
      ...packetCase(mutatePacket(base, (p) => { p.skillFiles = [bigFile]; })),
      errorContains: '64KiB',
    },
    {
      name: 'packet-skill-files-duplicate-path',
      ...packetCase(mutatePacket(base, (p) => { p.skillFiles = [clone(base.skillFiles[0]), clone(base.skillFiles[0])]; })),
      errorContains: 'duplicate path',
    },
    {
      name: 'packet-revise-result-schema-missing',
      ...packetCase(mutatePacket(base, (p) => { delete p.reviseResultSchema; })),
      errorContains: 'reviseResultSchema',
    },
    {
      name: 'packet-worker-procedure-missing',
      ...packetCase(mutatePacket(base, (p) => { delete p.workerProcedure; })),
      errorContains: 'workerProcedure',
    },
    {
      name: 'result-outcome-enum',
      ...revised((r) => { r.outcome = 'rewritten'; }),
      errorContains: 'result.outcome',
    },
    {
      name: 'result-skill-name-binding',
      ...revised((r) => { r.skillName = 'other-skill'; }),
      errorContains: 'not bound to packet.skillName',
    },
    {
      name: 'result-tree-sha-binding',
      ...revised((r) => { r.sourceTreeSha256 = '0'.repeat(64); }),
      errorContains: 'not bound to packet.provenance.source_tree_sha256',
    },
    {
      name: 'result-revised-without-files',
      ...revised((r) => { delete r.skillFiles; }),
      errorContains: 'outcome=revised requires result.skillFiles',
    },
    {
      name: 'result-revised-without-change-summary',
      ...revised((r) => { r.changeSummary = ''; }),
      errorContains: 'changeSummary',
    },
    {
      name: 'result-exclusive-drop-on-revised',
      ...revised((r) => { r.dropRecommendation = { reason: 'x' }; }),
      errorContains: 'must not carry dropRecommendation',
    },
    {
      name: 'result-drop-without-reason',
      ...drop((r) => { r.dropRecommendation = {}; }),
      errorContains: 'dropRecommendation.reason',
    },
    {
      name: 'result-exclusive-files-on-drop',
      ...drop((r) => { r.skillFiles = clone(base.skillFiles); }),
      errorContains: 'must not carry skillFiles',
    },
    {
      name: 'result-file-bytes-bound',
      ...revised((r) => { r.skillFiles = [bigFile]; }),
      errorContains: '64KiB',
    },
    {
      name: 'result-reviser-not-author',
      ...revised((r) => { r.reviser_node = 'node-beta'; }),
      errorContains: 'must be the packet author_node',
    },
    {
      name: 'result-model-missing',
      ...revised((r) => { r.model = ''; }),
      errorContains: 'result.model',
    },
  ];

  function mutatePacket(packet, mutate) {
    const copy = clone(packet);
    mutate(copy);
    return copy;
  }
}

// --- main -------------------------------------------------------------------

function main() {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

  // Registration integrity: the checker, its fixture and its doc anchor must
  // all be wired in, or the suite silently stops covering the contract.
  assert.ok(readFileSync(RUNNER_PATH, 'utf8').includes('check-skills-intake-revise.mjs'),
    'checker must be registered in run-conformance.mjs CHECKS');
  assert.ok(readFileSync(FIXTURES_MAP_PATH, 'utf8').includes('skills-intake-revise.json'),
    'fixture must be registered in check-contract-fixtures.mjs fixtureFiles');
  assert.ok(readFileSync(DOC_PATH, 'utf8').includes('check-skills-intake-revise.mjs'),
    'docs/skills-intake-revise.md must reference this checker');

  const packetCheck = validatePacket(fixture.validPacket);
  assert.deepEqual(packetCheck.errors, [], `valid packet must validate: ${packetCheck.errors.join('; ')}`);

  for (const [kind, result] of Object.entries(fixture.validResults)) {
    const check = validateResult(result, fixture.validPacket);
    assert.deepEqual(check.errors, [], `valid ${kind} result must validate: ${check.errors.join('; ')}`);
  }

  const negativeCases = buildNegativeCases(fixture);
  for (const { name, packet, result, errorContains } of negativeCases) {
    const outcome = result !== undefined
      ? validateResult(result, packet)
      : validatePacket(packet);
    assert.ok(outcome.errors.length > 0, `${name}: expected a contract error, got none`);
    assert.ok(
      outcome.errors.some((message) => message.includes(errorContains)),
      `${name}: expected an error containing '${errorContains}', got: ${outcome.errors.join(' | ')}`,
    );
  }

  const lines = [
    'packet: 1 valid',
    `valid results: ${Object.keys(fixture.validResults).length}`,
    `negative cases: ${negativeCases.length} (all rejected with the expected message)`,
  ];
  for (const line of lines) console.log(`  ${line}`);
  console.log('skills-intake-revise conformance: OK');
}

if (process.argv[1] && path.resolve(process.argv[1]) === THIS_PATH) {
  main();
}
