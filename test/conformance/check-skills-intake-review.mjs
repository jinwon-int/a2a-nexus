#!/usr/bin/env node
// Deterministic, no-network conformance for the skills intake review gate
// (`skills.skill-intake-review.v1`, jinwon-int/a2a-nexus#2007).
//
// Source-only: validates the fixture packet and verdicts against the contract
// in docs/skills-intake-review.md — packet envelope bounds, verdict schema,
// severity floors, the evidence mandate for major/blocker findings, author
// disqualification, and head-sha binding. It does NOT re-implement the review
// rubric: rubric quality is the reviewer's judgment call, this checker only
// enforces the machine-checkable contract so bad verdicts fail before the
// receipt workflow ever sees them.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const FIXTURE_PATH = path.join(ROOT, 'fixtures', 'contract', 'skills-intake-review.json');
const RUNNER_PATH = path.join(ROOT, 'test', 'conformance', 'run-conformance.mjs');
const FIXTURES_MAP_PATH = path.join(ROOT, 'test', 'conformance', 'check-contract-fixtures.mjs');
const THIS_PATH = path.join(ROOT, 'test', 'conformance', 'check-skills-intake-review.mjs');
const DOC_PATH = path.join(ROOT, 'docs', 'skills-intake-review.md');

// --- contract constants (docs/skills-intake-review.md) ----------------------

const PACKET_SCHEMA = 'skills.skill-intake-review.v1';
const SCOPES = new Set(['fleet-internal', 'public-elevation']);
const VERDICT_VALUES = new Set(['approve', 'revise', 'reject']);
const SEVERITIES = new Set(['info', 'minor', 'major', 'blocker']);
const FINDING_AREAS = new Set(['secrets', 'duplication', 'claims', 'structure', 'utility']);
const EVIDENCE_KINDS = new Set(['grep', 'url']);
const MAX_SKILL_FILES = 16;
const MAX_SKILL_FILE_BYTES = 64 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;
// git commit sha (40) or a padded sha-sized id (64) for future head schemes.
const GIT_HEAD_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const RUBRIC_VERSION = /^\d{4}-\d{2}-\d{2}\.\d+$/;

// Lowest verdict each finding severity still permits. A stricter verdict is
// always allowed ("any blocker forces reject", "any major forces at least
// revise" — docs/skills-intake-review.md, worker procedure step 4).
const SEVERITY_FLOOR = {
  blocker: 2,
  major: 1,
  minor: 0,
  info: 0,
};
const VERDICT_STRICTNESS = { approve: 0, revise: 1, reject: 2 };

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// --- validators -------------------------------------------------------------

export function validatePacket(packet) {
  const errors = [];
  const warnings = [];
  const fail = (message) => errors.push(message);

  if (!isPlainObject(packet)) {
    fail('packet must be a JSON object');
    return { errors, warnings };
  }
  if (packet.schema !== PACKET_SCHEMA) {
    fail(`packet.schema must be "${PACKET_SCHEMA}"`);
  }
  if (typeof packet.rubricVersion !== 'string' || !RUBRIC_VERSION.test(packet.rubricVersion)) {
    fail('packet.rubricVersion must match YYYY-MM-DD.N');
  }
  if (packet.scope !== undefined) {
    if (!SCOPES.has(packet.scope)) {
      fail(`packet.scope must be one of ${[...SCOPES].join('|')}`);
    }
  } else {
    warnings.push('packet.scope absent — defaults to fleet-internal');
  }

  const prov = packet.provenance;
  if (!isPlainObject(prov)) {
    fail('packet.provenance must be an object');
  } else {
    if (typeof prov.author_node !== 'string' || prov.author_node.length === 0) {
      fail('packet.provenance.author_node must be a non-empty string');
    }
    if (!Number.isInteger(prov.intake_pr) || prov.intake_pr < 1) {
      fail('packet.provenance.intake_pr must be a positive integer');
    }
    if (typeof prov.branch !== 'string' || prov.branch.length === 0) {
      fail('packet.provenance.branch must be a non-empty string');
    }
    if (typeof prov.head_sha !== 'string' || !GIT_HEAD_SHA.test(prov.head_sha)) {
      fail('packet.provenance.head_sha must be a 40-hex git sha');
    }
    if (typeof prov.source_tree_sha256 !== 'string' || !SHA256_HEX.test(prov.source_tree_sha256)) {
      fail('packet.provenance.source_tree_sha256 must be 64-hex sha256');
    }
  }

  if (!isPlainObject(packet.machineGate)) {
    fail('packet.machineGate must be an object of node-side gate results');
  }

  const files = packet.skillFiles;
  if (!Array.isArray(files) || files.length === 0) {
    fail('packet.skillFiles must be a non-empty array of {path, content}');
  } else {
    if (files.length > MAX_SKILL_FILES) {
      fail(`packet.skillFiles exceeds the ${MAX_SKILL_FILES}-file bound`);
    }
    const seen = new Set();
    for (const file of files) {
      if (!isPlainObject(file) || typeof file.path !== 'string' || file.path.length === 0) {
        fail('packet.skillFiles entries must carry a non-empty path');
        continue;
      }
      if (typeof file.content !== 'string') {
        fail(`packet.skillFiles['${file.path}'].content must be a string`);
        continue;
      }
      if (Buffer.byteLength(file.content, 'utf8') > MAX_SKILL_FILE_BYTES) {
        fail(`packet.skillFiles['${file.path}'].content exceeds the 64KiB per-file bound`);
      }
      if (seen.has(file.path)) {
        fail(`packet.skillFiles has duplicate path '${file.path}'`);
      }
      seen.add(file.path);
    }
  }

  const inventory = packet.inventorySnapshot;
  if (!Array.isArray(inventory)) {
    fail('packet.inventorySnapshot must be an array of {name, audience, description}');
  } else {
    const names = new Set();
    for (const row of inventory) {
      if (
        !isPlainObject(row) ||
        typeof row.name !== 'string' || row.name.length === 0 ||
        typeof row.audience !== 'string' || row.audience.length === 0 ||
        typeof row.description !== 'string' || row.description.length === 0
      ) {
        fail('packet.inventorySnapshot rows must carry non-empty name, audience and description');
        continue;
      }
      if (names.has(row.name)) warnings.push(`inventorySnapshot lists '${row.name}' twice`);
      names.add(row.name);
    }
  }

  if (!isPlainObject(packet.verdictSchema)) {
    fail('packet.verdictSchema must embed the expected verdict shape');
  }

  return { errors, warnings };
}

export function validateVerdict(verdict, packet) {
  const errors = [];
  const warnings = [];
  const fail = (message) => errors.push(message);

  if (!isPlainObject(verdict)) {
    fail('verdict must be a JSON object');
    return { errors, warnings };
  }
  if (!VERDICT_VALUES.has(verdict.verdict)) {
    fail(`verdict.verdict must be one of ${[...VERDICT_VALUES].join('|')}`);
  }

  const findings = verdict.findings;
  if (!Array.isArray(findings)) {
    fail('verdict.findings must be an array');
    return { errors, warnings };
  }
  let needsEvidence = false;
  let floor = 0;
  for (const finding of findings) {
    if (!isPlainObject(finding)) {
      fail('verdict.findings entries must be objects');
      continue;
    }
    if (!SEVERITIES.has(finding.severity)) {
      fail(`finding.severity must be one of ${[...SEVERITIES].join('|')}`);
      continue;
    }
    if (!FINDING_AREAS.has(finding.area)) {
      fail(`finding.area must be one of ${[...FINDING_AREAS].join('|')}`);
    }
    if (typeof finding.note !== 'string' || finding.note.length === 0) {
      fail('finding.note must be a non-empty string');
    }
    if (SEVERITIES.has(finding.severity) && (finding.severity === 'major' || finding.severity === 'blocker')) {
      needsEvidence = true;
    }
    if (SEVERITIES.has(finding.severity)) {
      floor = Math.max(floor, SEVERITY_FLOOR[finding.severity]);
    }
  }
  // Severity floor: the emitted verdict must be at least as strict as the
  // strictest finding. (docs/skills-intake-review.md, worker procedure step 4.)
  if (typeof verdict.verdict === 'string' && VERDICT_VALUES.has(verdict.verdict)) {
    if (VERDICT_STRICTNESS[verdict.verdict] < floor) {
      const floorName = Object.keys(SEVERITY_FLOOR).find((k) => SEVERITY_FLOOR[k] === floor);
      fail(`severity floor violated: a ${floorName} finding forces at least "${floorName === 'blocker' ? 'reject' : 'revise'}", got "${verdict.verdict}"`);
    }
  }

  if (needsEvidence) {
    const evidence = verdict.evidence;
    if (!Array.isArray(evidence) || evidence.length === 0) {
      // docs: "A verdict without `evidence` for any major/blocker finding is
      // malformed and treated as a handler failure, not a verdict."
      fail('verdict.evidence must be a non-empty array when any finding is major or blocker');
    } else {
      for (const item of evidence) {
        if (!isPlainObject(item) || !EVIDENCE_KINDS.has(item.kind)) {
          fail(`verdict.evidence kinds must be one of ${[...EVIDENCE_KINDS].join('|')}`);
        }
        if (!isPlainObject(item) || typeof item.detail !== 'string' || item.detail.length === 0) {
          fail('verdict.evidence entries must carry a non-empty detail');
        }
      }
    }
  } else if (verdict.evidence !== undefined && !Array.isArray(verdict.evidence)) {
    fail('verdict.evidence must be an array when present');
  }

  if (typeof verdict.model !== 'string' || verdict.model.length === 0) {
    fail('verdict.model must be a non-empty string');
  }
  if (typeof verdict.reviewer_node !== 'string' || verdict.reviewer_node.length === 0) {
    fail('verdict.reviewer_node must be a non-empty string');
  } else if (isPlainObject(packet) && isPlainObject(packet.provenance) && packet.provenance.author_node === verdict.reviewer_node) {
    fail('author disqualification violated: verdict.reviewer_node equals the packet author_node');
  }
  if (typeof verdict.head_sha !== 'string' || !GIT_HEAD_SHA.test(verdict.head_sha)) {
    fail('verdict.head_sha must be a 40-hex git sha');
  } else if (isPlainObject(packet) && isPlainObject(packet.provenance) && packet.provenance.head_sha !== verdict.head_sha) {
    fail('verdict.head_sha is not bound to packet.provenance.head_sha (exact-head discipline)');
  }
  if (typeof verdict.rubric_version !== 'string' || !RUBRIC_VERSION.test(verdict.rubric_version)) {
    fail('verdict.rubric_version must match YYYY-MM-DD.N');
  } else if (isPlainObject(packet) && packet.rubricVersion !== undefined && packet.rubricVersion !== verdict.rubric_version) {
    warnings.push('verdict.rubric_version differs from packet.rubricVersion — confirm the reviewer ran the packet rubric');
  }

  // #2027 provenance fields are first-class but a missing field is a warning,
  // never a gate failure (pre-provenance verdicts stay valid).
  if (typeof verdict.review_agent !== 'string' || verdict.review_agent.length === 0) {
    warnings.push('verdict.review_agent absent — provenance warning, not a gate failure');
  }
  if (typeof verdict.review_model !== 'string' || verdict.review_model.length === 0) {
    warnings.push('verdict.review_model absent — provenance warning, not a gate failure');
  }

  return { errors, warnings };
}

// --- negative matrix (deterministic mutations of the valid fixture) ---------

function mutatePacket(base, mutate) {
  const packet = clone(base);
  mutate(packet);
  return packet;
}

function mutateVerdict(validPacket, verdicts, kind, mutate) {
  const verdict = clone(verdicts[kind]);
  mutate(verdict);
  return { verdict, packet: clone(validPacket) };
}

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
  const otherHead = '0123456789abcdef0123456789abcdef01234567';

  return [
    {
      name: 'packet-schema-const',
      ...packetCase(mutatePacket(base, (p) => { p.schema = 'skills.wrong.v9'; })),
      errorContains: 'packet.schema',
    },
    {
      name: 'packet-scope-enum',
      ...packetCase(mutatePacket(base, (p) => { p.scope = 'public'; })),
      errorContains: 'packet.scope',
    },
    {
      name: 'packet-provenance-tree-sha',
      ...packetCase(mutatePacket(base, (p) => { p.provenance.source_tree_sha256 = 'zz'; })),
      errorContains: 'source_tree_sha256',
    },
    {
      name: 'packet-provenance-head-format',
      ...packetCase(mutatePacket(base, (p) => { p.provenance.head_sha = '3f2a1b9c'; })),
      errorContains: 'head_sha',
    },
    {
      name: 'packet-provenance-intake-pr',
      ...packetCase(mutatePacket(base, (p) => { p.provenance.intake_pr = 0; })),
      errorContains: 'intake_pr',
    },
    {
      name: 'packet-machine-gate-shape',
      ...packetCase(mutatePacket(base, (p) => { p.machineGate = []; })),
      errorContains: 'machineGate',
    },
    {
      name: 'packet-skill-files-empty',
      ...packetCase(mutatePacket(base, (p) => { p.skillFiles = []; })),
      errorContains: 'skillFiles',
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
      name: 'packet-inventory-row-shape',
      ...packetCase(mutatePacket(base, (p) => { p.inventorySnapshot = [{ name: 'x', audience: 'shared' }]; })),
      errorContains: 'inventorySnapshot',
    },
    {
      name: 'packet-verdict-schema-embedded',
      ...packetCase(mutatePacket(base, (p) => { delete p.verdictSchema; })),
      errorContains: 'verdictSchema',
    },
    {
      name: 'verdict-enum',
      ...mutateVerdict(base, fixture.validVerdicts, 'approve', (v) => { v.verdict = 'maybe'; }),
      errorContains: 'verdict.verdict',
    },
    {
      name: 'severity-enum',
      ...mutateVerdict(base, fixture.validVerdicts, 'approve', (v) => { v.findings[0].severity = 'critical'; }),
      errorContains: 'finding.severity',
    },
    {
      name: 'area-enum',
      ...mutateVerdict(base, fixture.validVerdicts, 'approve', (v) => { v.findings[0].area = 'style'; }),
      errorContains: 'finding.area',
    },
    {
      name: 'severity-floor-blocker-forces-reject',
      ...mutateVerdict(base, fixture.validVerdicts, 'approve', (v) => {
        v.verdict = 'approve';
        v.findings = [{ severity: 'blocker', area: 'secrets', note: 'x' }];
      }),
      errorContains: 'severity floor',
    },
    {
      name: 'severity-floor-major-forces-revise',
      ...mutateVerdict(base, fixture.validVerdicts, 'approve', (v) => {
        v.verdict = 'approve';
        v.findings = [{ severity: 'major', area: 'claims', note: 'x' }];
        v.evidence = [{ kind: 'grep', detail: 'match count 1' }];
      }),
      errorContains: 'severity floor',
    },
    {
      name: 'evidence-mandate-major',
      ...mutateVerdict(base, fixture.validVerdicts, 'revise', (v) => { v.evidence = []; }),
      errorContains: 'verdict.evidence',
    },
    {
      name: 'evidence-mandate-blocker',
      ...mutateVerdict(base, fixture.validVerdicts, 'reject', (v) => { v.evidence = []; }),
      errorContains: 'verdict.evidence',
    },
    {
      name: 'evidence-kind-enum',
      ...mutateVerdict(base, fixture.validVerdicts, 'reject', (v) => { v.evidence[0].kind = 'vibes'; }),
      errorContains: 'verdict.evidence kinds',
    },
    {
      name: 'author-disqualification',
      ...mutateVerdict(base, fixture.validVerdicts, 'approve', (v) => { v.reviewer_node = base.provenance.author_node; }),
      errorContains: 'author disqualification',
    },
    {
      name: 'head-sha-binding',
      ...mutateVerdict(base, fixture.validVerdicts, 'approve', (v) => { v.head_sha = otherHead; }),
      errorContains: 'not bound to packet.provenance.head_sha',
    },
    {
      name: 'rubric-version-format',
      ...mutateVerdict(base, fixture.validVerdicts, 'approve', (v) => { v.rubric_version = 'latest'; }),
      errorContains: 'rubric_version',
    },
  ];
}

// --- main -------------------------------------------------------------------

function main() {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

  // Registration integrity: the checker, its fixture and its doc anchor must
  // all be wired in, or the suite silently stops covering the contract.
  assert.ok(readFileSync(RUNNER_PATH, 'utf8').includes('check-skills-intake-review.mjs'),
    'checker must be registered in run-conformance.mjs CHECKS');
  assert.ok(readFileSync(FIXTURES_MAP_PATH, 'utf8').includes('skills-intake-review.json'),
    'fixture must be registered in check-contract-fixtures.mjs fixtureFiles');
  assert.ok(readFileSync(DOC_PATH, 'utf8').includes('check-skills-intake-review.mjs'),
    'docs/skills-intake-review.md must reference this checker');

  // Valid packet + all three verdict verdicts pass; the provenance-optional
  // shape (#2027 backward compatibility) stays valid with warnings.
  const packetCheck = validatePacket(fixture.validPacket);
  assert.deepEqual(packetCheck.errors, [], `valid packet must validate: ${packetCheck.errors.join('; ')}`);
  let warningCount = 0;
  for (const [kind, verdict] of Object.entries(fixture.validVerdicts)) {
    const check = validateVerdict(verdict, fixture.validPacket);
    assert.deepEqual(check.errors, [], `valid ${kind} verdict must validate: ${check.errors.join('; ')}`);
    warningCount += check.warnings.length;
  }

  // Backward compatibility: dropping the #2027 provenance fields yields
  // warnings, not errors.
  const compat = clone(fixture.validVerdicts.approve);
  delete compat.review_agent;
  delete compat.review_model;
  const compatCheck = validateVerdict(compat, fixture.validPacket);
  assert.deepEqual(compatCheck.errors, [], 'pre-provenance verdict must stay valid (#2027 backward compat)');
  assert.ok(compatCheck.warnings.some((w) => w.includes('review_agent')), 'missing review_agent must warn');
  assert.ok(compatCheck.warnings.some((w) => w.includes('review_model')), 'missing review_model must warn');

  // Rubric mismatch warns, never gates.
  const rubricMismatch = clone(fixture.validVerdicts.approve);
  rubricMismatch.rubric_version = '2026-01-01.1';
  const rubricCheck = validateVerdict(rubricMismatch, fixture.validPacket);
  assert.deepEqual(rubricCheck.errors, [], 'rubric mismatch must stay a warning');
  assert.ok(rubricCheck.warnings.some((w) => w.includes('rubric_version differs')), 'rubric mismatch must warn');

  // Negative matrix: every mutation fails with exactly the expected message.
  const negativeCases = buildNegativeCases(fixture);
  for (const { name, packet, verdict, errorContains } of negativeCases) {
    const result = verdict !== undefined
      ? validateVerdict(verdict, packet)
      : validatePacket(packet);
    assert.ok(result.errors.length > 0, `${name}: expected a contract error, got none`);
    assert.ok(
      result.errors.some((message) => message.includes(errorContains)),
      `${name}: expected an error containing '${errorContains}', got: ${result.errors.join(' | ')}`,
    );
  }

  const lines = [
    `packet: 1 valid (${warningCount} backward-compat warnings counted)`,
    `valid verdicts: ${Object.keys(fixture.validVerdicts).length}`,
    `negative cases: ${negativeCases.length} (all rejected with the expected message)`,
  ];
  for (const line of lines) console.log(`  ${line}`);
  console.log('skills-intake-review conformance: OK');
}

if (process.argv[1] && path.resolve(process.argv[1]) === THIS_PATH) {
  main();
}
