import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const fixturePath = path.join(root, 'fixtures', 'contract', 'a2ad-review-mode.json');

const forbiddenRuntimePaths = [
  'AGENTS.md',
  'SOUL.md',
  'USER.md',
  'TOOLS.md',
  'HEARTBEAT.md',
  'IDENTITY.md',
  '.openclaw/',
];

const secretLikePatterns = [
  /ghp_[A-Za-z0-9_]{20,}/,
  /github_pat_[A-Za-z0-9_]+/,
  /xox[baprs]-[A-Za-z0-9-]+/,
  /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/,
  /\/home\/[A-Za-z0-9._-]+\//,
  /\/Users\/[A-Za-z0-9._-]+\//,
];

function walk(value, visit, trail = []) {
  visit(value, trail);
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visit, [...trail, index]));
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      walk(item, visit, [...trail, key]);
    }
  }
}

// Load fixture
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const fixtureText = fs.readFileSync(fixturePath, 'utf8');

// ---- Fixture structure checks ----
assert.equal(fixture.fixtureId, 'a2a-nexus.contract.a2ad-review-mode.v1');
assert.ok(Array.isArray(fixture.evidence), 'fixture must have evidence array');
assert.ok(fixture.evidence.length >= 2, 'fixture must have at least 2 evidence entries');

// ---- Forbidden content checks ----
for (const forbiddenPath of forbiddenRuntimePaths) {
  assert.ok(
    !fixtureText.includes(forbiddenPath),
    `fixture must not reference OpenClaw runtime/bootstrap path: ${forbiddenPath}`,
  );
}
for (const pattern of secretLikePatterns) {
  assert.ok(
    !pattern.test(fixtureText),
    `fixture matched forbidden secret pattern: ${pattern}`,
  );
}

// ---- Per-evidence validation ----
for (const entry of fixture.evidence) {
  // Required top-level fields
  assert.equal(entry.kind, 'a2ad.review.v1', 'evidence kind must be a2ad.review.v1');
  assert.ok(typeof entry.reviewId === 'string' && entry.reviewId.length > 0, 'reviewId must be a non-empty string');
  assert.ok(typeof entry.title === 'string' && entry.title.length > 0, 'title must be a non-empty string');
  assert.ok(typeof entry.submittedAt === 'string', 'submittedAt must be a string');

  // Roles validation
  assert.ok(entry.roles, 'roles must be present');
  checkAgentRef(entry.roles.reviewer, 'reviewer');
  checkAgentRef(entry.roles.critic, 'critic');
  // defender and finalizer may be null (skipped phases)

  // Phases validation
  assert.ok(entry.phases, 'phases must be present');
  assert.ok(entry.phases.thesis !== undefined, 'thesis phase must be present');
  assert.ok(entry.phases.antithesis !== undefined, 'antithesis phase must be present');
  assert.ok(entry.phases.rebuttal !== undefined, 'rebuttal phase must be present (may be present: false)');
  assert.ok(entry.phases.synthesis !== undefined, 'synthesis phase must be present (may be present: false)');

  // Thesis phase
  if (entry.phases.thesis.present) {
    assert.ok(entry.phases.thesis.data, 'thesis data must be present when thesis.present is true');
    checkThesisData(entry.phases.thesis.data);
  }

  // Antithesis phase
  if (entry.phases.antithesis.present) {
    assert.ok(entry.phases.antithesis.data, 'antithesis data must be present when antithesis.present is true');
    checkAntithesisData(entry.phases.antithesis.data);
  }

  // Rebuttal phase (optional)
  if (entry.phases.rebuttal.present) {
    assert.ok(entry.phases.rebuttal.data, 'rebuttal data must be present when rebuttal.present is true');
    checkRebuttalData(entry.phases.rebuttal.data);
  }

  // Synthesis phase
  if (entry.phases.synthesis.present) {
    assert.ok(entry.phases.synthesis.data, 'synthesis data must be present when synthesis.present is true');
    checkSynthesisData(entry.phases.synthesis.data);
  }

  // Synthesis card
  assert.ok(entry.synthesisCard, 'synthesisCard must be present');
  checkSynthesisCard(entry.synthesisCard);
}

// ---- Phase ordering invariant ----
for (const entry of fixture.evidence) {
  const thesisAt = entry.phases.thesis.data?.submittedAt;
  const antithesisAt = entry.phases.antithesis.data?.submittedAt;
  const rebuttalAt = entry.phases.rebuttal.data?.submittedAt;
  const synthesisAt = entry.phases.synthesis.data?.submittedAt;

  if (thesisAt && antithesisAt) {
    assert.ok(
      new Date(thesisAt) <= new Date(antithesisAt),
      'thesis must be submitted before or at the same time as antithesis',
    );
  }
  if (antithesisAt && rebuttalAt) {
    assert.ok(
      new Date(antithesisAt) <= new Date(rebuttalAt),
      'antithesis must be submitted before or at the same time as rebuttal',
    );
  }
  if (rebuttalAt && synthesisAt) {
    assert.ok(
      new Date(rebuttalAt) <= new Date(synthesisAt),
      'rebuttal must be submitted before or at the same time as synthesis',
    );
  }
  if (antithesisAt && synthesisAt && !rebuttalAt) {
    // Rebuttal skipped — antithesis before synthesis is fine
    assert.ok(
      new Date(antithesisAt) <= new Date(synthesisAt),
      'antithesis must be submitted before synthesis (rebuttal skipped)',
    );
  }
}

// ---- Verification of synthesis fact/assumption/recommendation separation ----
for (const entry of fixture.evidence) {
  if (!entry.phases.synthesis.present || !entry.synthesisCard.verdict) {
    continue; // Skip cancelled/incomplete reviews
  }

  // Synthesis data must have all three separation fields
  const synthesis = entry.phases.synthesis.data;
  assert.ok(
    Array.isArray(synthesis.facts) && synthesis.facts.length > 0,
    'synthesis must have at least one fact',
  );
  assert.ok(
    Array.isArray(synthesis.assumptions) && synthesis.assumptions.length > 0,
    'synthesis must have at least one assumption',
  );
  assert.ok(
    typeof synthesis.recommendation === 'string' && synthesis.recommendation.length > 0,
    'synthesis must have a non-empty recommendation',
  );

  // Facts, assumptions, and recommendation must be non-overlapping in content
  // (This is a stylistic check — factual overlap is allowed when justified)
  assert.ok(
    !synthesis.facts.some((f) => synthesis.assumptions.includes(f)),
    'facts and assumptions must not overlap (same statement cannot be both)',
  );
  assert.ok(
    !synthesis.facts.some((f) => f === synthesis.recommendation),
    'recommendation must not duplicate a fact',
  );

  // Dissenting notes from synthesis
  assert.ok(Array.isArray(synthesis.dissentingNotes), 'synthesis must have dissentingNotes array');
  assert.ok(
    !synthesis.dissentingNotes.some((n) => n.length === 0),
    'dissenting notes must not be empty strings',
  );
}

// ---- Synthesis card consistency with synthesis phase data ----
for (const entry of fixture.evidence) {
  if (!entry.phases.synthesis.present) {
    continue;
  }

  const synthesis = entry.phases.synthesis.data;
  const card = entry.synthesisCard;

  // Verdict must match
  assert.equal(
    synthesis.verdict,
    card.verdict,
    `synthesis.verdict (${synthesis.verdict}) must match synthesisCard.verdict (${card.verdict})`,
  );

  // Recommendation must match — card may be an abbreviated version but should share
  // the same action verb (e.g., 'Increase' or 'Proceed') and subject
  const recWords = new Set(synthesis.recommendation.toLowerCase().split(/\W+/).filter(Boolean));
  const cardWords = new Set(card.recommendation.toLowerCase().split(/\W+/).filter(Boolean));
  const intersection = [...recWords].filter((w) => cardWords.has(w));
  assert.ok(
    intersection.length >= 3 ||
    synthesis.recommendation.startsWith(card.recommendation) ||
    card.recommendation.startsWith(synthesis.recommendation),
    'synthesis.recommendation and synthesisCard.recommendation must have significant overlap\n' +
    `  synthesis: ${synthesis.recommendation}\n` +
    `  card:      ${card.recommendation}`,
  );
}

// ---- Results ----
console.log(JSON.stringify({
  ok: true,
  checkedEvidence: fixture.evidence.length,
  evidenceIds: fixture.evidence.map((e) => e.evidenceId),
  fixture: 'fixtures/contract/a2ad-review-mode.json',
}));

// ----- Helper functions -----

function checkAgentRef(ref, roleName) {
  if (ref === null || ref === undefined) {
    return; // null is allowed (role not assigned)
  }
  assert.ok(typeof ref === 'object', `${roleName} agentRef must be an object`);
  assert.ok(typeof ref.agentId === 'string' && ref.agentId.length > 0, `${roleName} agentId must be a non-empty string`);
  // sessionKey and nodeId are optional
}

function checkStringArray(arr, label) {
  assert.ok(Array.isArray(arr), `${label} must be an array`);
  assert.ok(arr.length > 0, `${label} must not be empty`);
  assert.ok(arr.every((s) => typeof s === 'string' && s.length > 0), `${label} must contain only non-empty strings`);
}

function checkThesisData(data) {
  assert.ok(typeof data.author?.agentId === 'string', 'thesis author.agentId must be a string');
  assert.ok(typeof data.submittedAt === 'string', 'thesis submittedAt must be a string');
  assert.ok(typeof data.title === 'string' && data.title.length > 0, 'thesis title must be a non-empty string');
  assert.ok(typeof data.summary === 'string' && data.summary.length > 0, 'thesis summary must be a non-empty string');
  checkStringArray(data.claims, 'thesis.claims');
  assert.ok(Array.isArray(data.evidenceRefs), 'thesis.evidenceRefs must be an array');
  checkStringArray(data.assumptions, 'thesis.assumptions');
  checkStringArray(data.risksIdentified, 'thesis.risksIdentified');
  assert.ok(typeof data.recommendation === 'string', 'thesis.recommendation must be a string');
  assert.ok(typeof data.confidence === 'number' && data.confidence >= 0 && data.confidence <= 1, 'thesis.confidence must be a number 0-1');
  assert.ok(Array.isArray(data.testCriteria), 'thesis.testCriteria must be an array');
}

function checkAntithesisData(data) {
  assert.ok(typeof data.author?.agentId === 'string', 'antithesis author.agentId must be a string');
  assert.ok(typeof data.submittedAt === 'string', 'antithesis submittedAt must be a string');
  checkStringArray(data.counterClaims, 'antithesis.counterClaims');
  checkStringArray(data.failureModes, 'antithesis.failureModes');
  checkStringArray(data.contradictions, 'antithesis.contradictions');
  checkStringArray(data.assumptionsChallenged, 'antithesis.assumptionsChallenged');
  checkStringArray(data.risksRaised, 'antithesis.risksRaised');
  assert.ok(Array.isArray(data.blockFlags), 'antithesis.blockFlags must be an array');
  assert.ok(Array.isArray(data.evidenceRefs), 'antithesis.evidenceRefs must be an array');
  assert.ok(typeof data.confidence === 'number' && data.confidence >= 0 && data.confidence <= 1, 'antithesis.confidence must be a number 0-1');
}

function checkRebuttalData(data) {
  assert.ok(typeof data.author?.agentId === 'string', 'rebuttal author.agentId must be a string');
  assert.ok(typeof data.submittedAt === 'string', 'rebuttal submittedAt must be a string');
  assert.ok(typeof data.response === 'string' && data.response.length > 0, 'rebuttal.response must be a non-empty string');
  checkStringArray(data.defendedClaims, 'rebuttal.defendedClaims');
  checkStringArray(data.concededPoints, 'rebuttal.concededPoints');
  assert.ok(Array.isArray(data.refinedAssumptions), 'rebuttal.refinedAssumptions must be an array');
  checkStringArray(data.residualRisks, 'rebuttal.residualRisks');
}

function checkSynthesisData(data) {
  assert.ok(typeof data.author?.agentId === 'string', 'synthesis author.agentId must be a string');
  assert.ok(typeof data.submittedAt === 'string', 'synthesis submittedAt must be a string');
  checkStringArray(data.preserved, 'synthesis.preserved');
  checkStringArray(data.rejected, 'synthesis.rejected');
  checkStringArray(data.dissentingNotes, 'synthesis.dissentingNotes');
  checkStringArray(data.facts, 'synthesis.facts');
  checkStringArray(data.assumptions, 'synthesis.assumptions');
  checkStringArray(data.risks, 'synthesis.risks');
  assert.ok(Array.isArray(data.tests), 'synthesis.tests must be an array');
  assert.ok(typeof data.recommendation === 'string' && data.recommendation.length > 0, 'synthesis.recommendation must be a non-empty string');
  assert.ok(typeof data.recommendationBasis === 'string' && data.recommendationBasis.length > 0, 'synthesis.recommendationBasis must be a non-empty string');
  assert.ok(typeof data.verdict === 'string', 'synthesis.verdict must be a string');
  const validVerdicts = ['APPROVE', 'APPROVE_WITH_CHANGES', 'REJECT', 'DEFER', 'ESCALATE'];
  assert.ok(validVerdicts.includes(data.verdict), `synthesis.verdict must be one of ${validVerdicts.join(', ')}`);
}

function checkSynthesisCard(card) {
  assert.ok(card.verdict === null || typeof card.verdict === 'string', 'synthesisCard.verdict must be a string or null');
  assert.ok(Array.isArray(card.facts), 'synthesisCard.facts must be an array');
  assert.ok(Array.isArray(card.assumptions), 'synthesisCard.assumptions must be an array');
  assert.ok(Array.isArray(card.risks), 'synthesisCard.risks must be an array');
  assert.ok(Array.isArray(card.tests), 'synthesisCard.tests must be an array');
  assert.ok(Array.isArray(card.dissentingNotes), 'synthesisCard.dissentingNotes must be an array');
  assert.ok(typeof card.recommendation === 'string', 'synthesisCard.recommendation must be a string');

  if (card.verdict) {
    // For completed reviews, facts should be present
    assert.ok(card.facts.length > 0, 'completed review must have at least one fact in synthesisCard');
    assert.ok(card.assumptions.length > 0, 'completed review must have at least one assumption in synthesisCard');
    assert.ok(card.recommendation.length > 0, 'completed review must have a non-empty recommendation in synthesisCard');
  }
}
