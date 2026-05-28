#!/usr/bin/env node
/**
 * Split-repo local demo conformance check.
 *
 * Validates the split-repo-local-demo.md quickstart guide and its evidence
 * fixture for deterministic, no-live, safe structural expectations.
 *
 * Covers three split-repo components:
 *   1. Broker AgentCard/profile (a2a-broker#951)
 *   2. Plugin diagnostics/profile visibility (openclaw-plugin-a2a#454)
 *   3. Docker-runner dry-run evidence (a2a-docker-runner#343)
 *
 * Safety: read-only doc and fixture validation. No deploy, no restart,
 * no live send, no secret exposure.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];

function fail(msg) {
  failures.push(msg);
}

function expect(condition, msg) {
  if (!condition) fail(msg);
}

function readRel(rel) {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8');
  } catch {
    return null;
  }
}

function fileExists(rel) {
  return fs.existsSync(path.join(root, rel));
}

function parseJson(rel) {
  const text = readRel(rel);
  if (text === null) {
    fail(`missing ${rel}`);
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${rel}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

// ---- 1. Split-repo local demo doc ----

const docPath = 'docs/demo/split-repo-local-demo.md';
const doc = readRel(docPath);

expect(doc !== null, `missing ${docPath}`);
if (doc) {
  // Title and scope
  expect(/Split-Repo Local Demo Quickstart/i.test(doc), 'doc: missing title');
  expect(/no-live public local demo/i.test(doc), 'doc: must describe no-live scope');
  expect(/broker AgentCard\/profile/i.test(doc), 'doc: must mention broker AgentCard/profile');
  expect(/plugin diagnostics\/profile visibility/i.test(doc), 'doc: must mention plugin diagnostics');

  // Parent and tracking issue references
  expect(/a2a-plane\/issues\/473/.test(doc), 'doc: must link parent issue #473');
  expect(/a2a-plane\/issues\/480/.test(doc), 'doc: must link tracking issue #480');

  // Completed upstream issue references
  expect(/a2a-broker\/issues\/951/.test(doc), 'doc: must link a2a-broker#951');
  expect(/openclaw-plugin-a2a\/issues\/454/.test(doc), 'doc: must link openclaw-plugin-a2a#454');
  expect(/a2a-docker-runner\/issues\/343/.test(doc), 'doc: must link a2a-docker-runner#343');

  // Safety language
  expect(/loopback URLs/i.test(doc), 'doc: must reference loopback URLs');
  expect(/Do not point it at production/i.test(doc), 'doc: must warn against production use');
  expect(/no production deploy/i.test(doc), 'doc: must mention no production deploy');
  expect(/live provider send/i.test(doc), 'doc: must mention live provider send as prohibited');
  expect(/repository visibility/i.test(doc), 'doc: must mention no repository visibility change');
  expect(/history rewrite/i.test(doc), 'doc: must mention no history rewrite');

  // Broker AgentCard section
  expect(/well-known\/agent-card\.json/.test(doc), 'doc: must reference AgentCard endpoint');
  expect(/workers\/capacity/.test(doc), 'doc: must reference /workers/capacity endpoint');

  // Plugin diagnostics section
  expect(/openclaw\.plugin\.json/.test(doc), 'doc: must reference plugin config schema');
  expect(/configSchema/.test(doc), 'doc: must reference configSchema properties');

  // Docker-runner dry-run section
  expect(/dry-run evidence/i.test(doc), 'doc: must reference dry-run evidence');
  expect(/task\.canonical\.json/.test(doc), 'doc: must reference canonical task fixture');
  expect(/node dist\/cli\.js cleanup --ttl 24h --dry-run/.test(doc), 'doc: must use the built docker-runner CLI dry-run command');
  expect(/--dry-run/.test(doc), 'doc: must reference dry-run flag');

  // Summary table
  expect(/a2a-broker#951/.test(doc), 'doc: summary table must reference a2a-broker#951');
  expect(/openclaw-plugin-a2a#454/.test(doc), 'doc: summary table must reference openclaw-plugin-a2a#454');
  expect(/a2a-docker-runner#343/.test(doc), 'doc: summary table must reference a2a-docker-runner#343');

  // Safety checklist
  expect(/Safety checklist/i.test(doc), 'doc: missing safety checklist');
  expect(/no production broker/i.test(doc), 'doc: safety checklist must mention production broker safety');
  expect(/No Gateway.*restarted/i.test(doc), 'doc: safety checklist must mention gateway restart');
  expect(/excluded from the branch/i.test(doc), 'doc: safety checklist must warn about bootstrap context files');
}

// ---- 2. Evidence fixture ----

const fixturePath = 'fixtures/contract/split-repo-local-demo-evidence.json';
const fixture = parseJson(fixturePath);

if (fixture) {
  expect(fixture.schema === 'a2a.splitRepoLocalDemo.evidence.v1', 'fixture: invalid schema');
  expect(fixture.mode === 'no-live', 'fixture: mode must be no-live');
  expect(fixture.parentIssue === 'https://github.com/jinwon-int/a2a-plane/issues/473', 'fixture: parentIssue must be #473');
  expect(fixture.trackingIssue === 'https://github.com/jinwon-int/a2a-plane/issues/480', 'fixture: trackingIssue must be #480');

  // Completed issue references
  expect(fixture.completedIssues?.brokerAgentCardProfile === 'https://github.com/jinwon-int/a2a-broker/issues/951', 'fixture: brokerAgentCardProfile must reference a2a-broker#951');
  expect(fixture.completedIssues?.pluginDiagnosticsVisibility === 'https://github.com/jinwon-int/openclaw-plugin-a2a/issues/454', 'fixture: pluginDiagnosticsVisibility must reference openclaw-plugin-a2a#454');
  expect(fixture.completedIssues?.dockerRunnerDryRunEvidence === 'https://github.com/jinwon-int/a2a-docker-runner/issues/343', 'fixture: dockerRunnerDryRunEvidence must reference a2a-docker-runner#343');

  // Broker
  expect(fixture.broker?.agentCardUrl === 'http://127.0.0.1:8787/.well-known/agent-card.json', 'fixture: broker agent card URL must be loopback');
  expect(fixture.broker?.healthUrl === 'http://127.0.0.1:8787/health', 'fixture: broker health URL must be loopback');
  expect(fixture.broker?.workersCapacityUrl === 'http://127.0.0.1:8787/workers/capacity', 'fixture: broker /workers/capacity URL must be loopback');
  expect(fixture.broker?.prod === false, 'fixture: broker must not be production');
  expect(fixture.broker?.baseUrl === 'http://127.0.0.1:8787', 'fixture: broker base URL must be loopback');

  // Plugin
  expect(fixture.plugin?.prod === false, 'fixture: plugin must not be production');
  expect(fixture.plugin?.configSchemaUrl === 'packages/openclaw-plugin-a2a/openclaw.plugin.json', 'fixture: plugin config schema URL must be repo-relative');
  if (fixture.plugin?.diagnostics?.expectedCapabilities) {
    const caps = fixture.plugin.diagnostics.expectedCapabilities;
    expect(caps.includes('baseUrl'), 'fixture: plugin capabilities must include baseUrl');
    expect(caps.includes('edgeSecret'), 'fixture: plugin capabilities must include edgeSecret');
    expect(caps.includes('requester'), 'fixture: plugin capabilities must include requester');
    expect(caps.includes('operatorEvents'), 'fixture: plugin capabilities must include operatorEvents');
    expect(caps.includes('wakeOnTask'), 'fixture: plugin capabilities must include wakeOnTask');
  }

  // Docker runner
  expect(fixture.dockerRunner?.prod === false, 'fixture: docker-runner must not be production');
  expect(fixture.dockerRunner?.expectedEvidence?.schema === 'a2a.runner.dryRunState.v1', 'fixture: runner evidence schema must be a2a.runner.dryRunState.v1');
  expect(Array.isArray(fixture.dockerRunner?.expectedEvidence?.requiredArtifacts), 'fixture: requiredArtifacts must be an array');
  expect(fixture.dockerRunner.expectedEvidence.requiredArtifacts.includes('task.json'), 'fixture: required artifacts must include task.json');
  expect(fixture.dockerRunner.expectedEvidence.requiredArtifacts.includes('run.json'), 'fixture: required artifacts must include run.json');
  expect(fixture.dockerRunner.expectedEvidence.requiredArtifacts.includes('manifest.json'), 'fixture: required artifacts must include manifest.json');
  expect(Array.isArray(fixture.dockerRunner?.taskFixtures), 'fixture: taskFixtures must be an array');

  // Terminal evidence
  expect(Array.isArray(fixture.expectedTerminalEvidence), 'fixture: expectedTerminalEvidence must be an array');
  expect(fixture.expectedTerminalEvidence.includes('Done'), 'fixture: expectedTerminalEvidence must include Done');
  expect(fixture.expectedTerminalEvidence.includes('Block'), 'fixture: expectedTerminalEvidence must include Block');

  // Safety
  for (const [key, value] of Object.entries(fixture.safety || {})) {
    expect(value === false, `fixture: safety.${key} must be false`);
  }

  // Replay-safe / no-live
  expect(fixture.replaySafe === true, 'fixture: replaySafe must be true');
  expect(fixture.noLive === true, 'fixture: noLive must be true');
}

// ---- 3. Broker agent-card type exists ----

expect(fileExists('packages/broker/src/a2a/agent-card.ts'), 'missing broker AgentCard type definition');

// ---- 4. Plugin config schema exists ----

expect(fileExists('packages/openclaw-plugin-a2a/openclaw.plugin.json'), 'missing plugin config schema');

// ---- 5. Docker-runner canonical fixture exists ----

expect(fileExists('packages/docker-runner/examples/task.canonical.json'), 'missing docker-runner canonical task fixture');

// ---- Result ----

if (failures.length) {
  console.error(`split-repo local demo conformance failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

console.log('split-repo local demo conformance ok: doc, fixture, and three-package evidence structure validated');
