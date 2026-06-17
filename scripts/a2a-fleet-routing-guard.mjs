#!/usr/bin/env node
/**
 * A2A Fleet Routing Guard — pure-offline preflight that enforces fleet worker
 * routing: Team1 → seoseo broker, Team2 → gwakga broker.
 *
 * It validates operator-collected evidence against a declarative routing
 * inventory. Each node's observed broker URL, edge-secret fingerprint, systemd
 * service name, ExecStart root, build revision, and active state must match the
 * expectations for its team. Mismatches fail closed (exit 1) and are enumerated;
 * --force downgrades them to warnings (exit 0) but loudly marks the run.
 *
 * This command never runs live SSH, opens network connections, restarts
 * Gateway/brokers/workers, mutates DB/outbox state, moves secrets, or enables
 * runtime execution. Secrets are never handled raw — only sha256 fingerprints.
 * The `collect` subcommand PRINTS (does not execute) the one-liner an operator
 * runs on each node to produce its observed JSON entry.
 */

import fs from 'node:fs';
import { parseArgs } from 'node:util';

import { hasText, normalizeUrl } from './a2a-routing-shared.mjs';

// ─── Per-node fields that must match the team/fleet expectation ──────────────

const CHECK_COLUMNS = ['team', 'brokerUrl', 'service', 'root', 'revision', 'runnerImage', 'auth', 'active'];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value.trim());
}

// ─── Inventory / observation validation ──────────────────────────────────────

function validateExpectedInventory(expected) {
  const errors = [];
  if (!expected || typeof expected !== 'object') {
    return ['expected inventory must be an object'];
  }
  if (!expected.teams || typeof expected.teams !== 'object') {
    errors.push('expected.teams is required');
  } else {
    for (const [name, team] of Object.entries(expected.teams)) {
      if (!team || typeof team !== 'object') {
        errors.push(`expected.teams.${name} must be an object`);
        continue;
      }
      if (!hasText(team.brokerUrl)) errors.push(`expected.teams.${name}.brokerUrl is required`);
      if (!hasText(team.broker)) errors.push(`expected.teams.${name}.broker is required`);
      if (!isSha256(team.edgeSecretSha256)) errors.push(`expected.teams.${name}.edgeSecretSha256 must be a sha256 hex digest`);
    }
  }
  if (!expected.nodes || typeof expected.nodes !== 'object') {
    errors.push('expected.nodes is required');
  } else {
    for (const [node, cfg] of Object.entries(expected.nodes)) {
      if (!cfg || typeof cfg !== 'object') {
        errors.push(`expected.nodes.${node} must be an object`);
        continue;
      }
      if (!hasText(cfg.team)) {
        errors.push(`expected.nodes.${node}.team is required`);
      } else if (expected.teams && !expected.teams[cfg.team]) {
        errors.push(`expected.nodes.${node}.team '${cfg.team}' is not defined in expected.teams`);
      }
    }
  }
  if (!hasText(expected.expectedService)) errors.push('expected.expectedService is required');
  if (!hasText(expected.expectedRoot)) errors.push('expected.expectedRoot is required');
  if (!hasText(expected.expectedRevision)) errors.push('expected.expectedRevision is required');
  if (expected.expectedRunnerImage != null && !hasText(expected.expectedRunnerImage)) {
    errors.push('expected.expectedRunnerImage must be a non-empty string when provided');
  }
  return errors;
}

function validateObservedList(observed) {
  const errors = [];
  if (!Array.isArray(observed)) {
    return ['observed state must be an array of per-node entries'];
  }
  observed.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      errors.push(`observed[${index}] must be an object`);
      return;
    }
    if (!hasText(entry.node)) errors.push(`observed[${index}].node is required`);
    // An absent or malformed fingerprint is NOT a malformed-input error: a blank
    // secret on a node is real routing evidence that the auth check must flag.
    if (entry.edgeSecretSha256 != null && typeof entry.edgeSecretSha256 !== 'string') {
      errors.push(`observed[${index}].edgeSecretSha256 must be a string when present`);
    }
    if (entry.runnerImage != null && typeof entry.runnerImage !== 'string') {
      errors.push(`observed[${index}].runnerImage must be a string when present`);
    }
  });
  return errors;
}

// ─── Core evaluation ─────────────────────────────────────────────────────────

function evaluateFleet(expected, observed) {
  const inventoryErrors = validateExpectedInventory(expected);
  const observedErrors = validateObservedList(observed);
  if (inventoryErrors.length > 0 || observedErrors.length > 0) {
    return {
      ok: false,
      malformed: true,
      inputErrors: [...inventoryErrors, ...observedErrors],
      rows: [],
      violations: [],
    };
  }

  const observedByNode = new Map();
  for (const entry of observed) observedByNode.set(entry.node, entry);

  const rows = [];
  const violations = [];

  // Iterate the expected inventory so missing observations are caught too.
  for (const [node, nodeCfg] of Object.entries(expected.nodes)) {
    const team = expected.teams[nodeCfg.team];
    const obs = observedByNode.get(node);
    const exemptRoot = nodeCfg.exemptRoot === true;

    if (!obs) {
      violations.push({ node, field: 'observation', reason: `no observed state collected for node '${node}'` });
      rows.push({
        node, team: nodeCfg.team, brokerUrl: 'MISSING', service: 'MISSING',
        root: 'MISSING', revision: 'MISSING', auth: 'MISSING', active: 'MISSING',
        ok: false,
      });
      continue;
    }

    const checks = {};

    checks.brokerUrl = normalizeUrl(obs.brokerUrl) === normalizeUrl(team.brokerUrl);
    if (!checks.brokerUrl) {
      violations.push({ node, field: 'brokerUrl', reason: `broker URL '${obs.brokerUrl}' != team '${nodeCfg.team}' expected '${team.brokerUrl}'` });
    }

    checks.auth = isSha256(obs.edgeSecretSha256) && obs.edgeSecretSha256.toLowerCase() === team.edgeSecretSha256.toLowerCase();
    if (!checks.auth) {
      violations.push({ node, field: 'auth', reason: `edge secret fingerprint mismatch for team '${nodeCfg.team}' (workers with the wrong EDGE_SECRET poll the wrong broker)` });
    }

    checks.service = obs.service === expected.expectedService;
    if (!checks.service) {
      violations.push({ node, field: 'service', reason: `service '${obs.service}' != expected '${expected.expectedService}'` });
    }

    if (exemptRoot) {
      checks.root = true;
    } else {
      checks.root = obs.root === expected.expectedRoot;
      if (!checks.root) {
        violations.push({ node, field: 'root', reason: `ExecStart root '${obs.root}' != expected '${expected.expectedRoot}'` });
      }
    }

    checks.revision = obs.revision === expected.expectedRevision;
    if (!checks.revision) {
      violations.push({ node, field: 'revision', reason: `revision '${obs.revision}' != expected '${expected.expectedRevision}'` });
    }

    const expectedRunnerImage = expected.expectedRunnerImage;
    checks.runnerImage = true;
    if (hasText(expectedRunnerImage)) {
      checks.runnerImage = obs.runnerImage === expectedRunnerImage;
      if (!checks.runnerImage) {
        violations.push({
          node,
          field: 'runnerImage',
          reason: `Docker runner image '${obs.runnerImage || 'MISSING'}' != expected '${expectedRunnerImage}' (sync A2A_DOCKER_RUNNER_IMAGE with the intended runner artifact tag before restart)`,
        });
      }
    }

    checks.active = obs.active === true;
    if (!checks.active) {
      violations.push({ node, field: 'active', reason: `worker is not active (active=${JSON.stringify(obs.active)})` });
    }

    const rowOk = checks.brokerUrl && checks.auth && checks.service && checks.root && checks.revision && checks.runnerImage && checks.active;
    rows.push({
      node,
      team: nodeCfg.team,
      brokerUrl: checks.brokerUrl ? 'ok' : 'MISMATCH',
      service: checks.service ? 'ok' : 'MISMATCH',
      root: exemptRoot ? 'exempt' : (checks.root ? 'ok' : 'MISMATCH'),
      revision: checks.revision ? 'ok' : 'MISMATCH',
      runnerImage: !hasText(expectedRunnerImage) ? 'not-checked' : (checks.runnerImage ? 'ok' : 'MISMATCH'),
      auth: checks.auth ? 'ok' : 'MISMATCH',
      active: checks.active ? 'yes' : 'NO',
      ok: rowOk,
    });
  }

  rows.sort((a, b) => a.node.localeCompare(b.node));
  violations.sort((a, b) => (a.node.localeCompare(b.node)) || a.field.localeCompare(b.field));

  return {
    ok: violations.length === 0,
    malformed: false,
    inputErrors: [],
    rows,
    violations,
  };
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function renderTable(rows) {
  const headers = ['NODE', 'TEAM', 'BROKER', 'SERVICE', 'ROOT', 'REVISION', 'RUNNER_IMAGE', 'AUTH', 'ACTIVE'];
  const data = rows.map((r) => [r.node, r.team, r.brokerUrl, r.service, r.root, r.revision, r.runnerImage, r.auth, r.active]);
  const widths = headers.map((h, i) => Math.max(h.length, ...data.map((d) => String(d[i]).length)));
  const fmt = (cols) => cols.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd();
  const lines = [fmt(headers), widths.map((w) => '-'.repeat(w)).join('  ')];
  for (const d of data) lines.push(fmt(d));
  return lines.join('\n');
}

function renderTextReport(result, { forced }) {
  const lines = [];
  lines.push('A2A Fleet Routing Guard — Team1→seoseo / Team2→gwakga');
  lines.push('');
  if (result.malformed) {
    lines.push('VERDICT: MALFORMED-INPUT');
    lines.push('');
    for (const e of result.inputErrors) lines.push(`  - ${e}`);
    return lines.join('\n') + '\n';
  }

  lines.push(renderTable(result.rows));
  lines.push('');

  if (result.violations.length > 0) {
    lines.push(`Violations (${result.violations.length}):`);
    for (const v of result.violations) lines.push(`  - [${v.node}] ${v.field}: ${v.reason}`);
    lines.push('');
  }

  if (result.ok) {
    lines.push('VERDICT: PASS — all nodes match their team broker, auth, service, root, revision, optional runner image, and are active');
  } else if (forced) {
    lines.push('VERDICT: FORCED-PAST-VIOLATIONS — exiting 0 despite the violations above (--force)');
  } else {
    lines.push('VERDICT: FAIL — fix the violations above (fail-closed)');
  }
  return lines.join('\n') + '\n';
}

// ─── collect one-liner ───────────────────────────────────────────────────────

// The shell an operator runs ON a node to emit one observed[] entry. Printed
// only — never executed by this guard. The secret env var is hashed in place so
// its raw value never leaves the node.
const COLLECT_ONELINER = [
  '# Run on each fleet node. Emits a single observed-state JSON object for that',
  '# node; pipe each node\'s output into a JSON array to form --observed.',
  '# Set EDGE_SECRET in the environment if it is not exposed in the unit.',
  'node - "$(hostname -s)" <<\'NODE\'',
  "const crypto = require('node:crypto');",
  "const { execSync } = require('node:child_process');",
  'const node = process.argv[2];',
  "const sh = (c) => { try { return execSync(c, { encoding: 'utf8' }).trim(); } catch { return ''; } };",
  "const unit = sh('systemctl show -p Names --value a2a-hermes-worker 2>/dev/null') || 'a2a-hermes-worker';",
  "const execStart = sh('systemctl show -p ExecStart --value ' + unit);",
  "const rootMatch = execStart.match(/(\\/[^\\s;]*a2a[^\\s;]*worker)/) || [];",
  "const root = (sh('systemctl show -p WorkingDirectory --value ' + unit) || rootMatch[1] || '').replace(/\\/$/, '');",
  "const env = sh('systemctl show -p Environment --value ' + unit);",
  "const pick = (k) => { const m = env.match(new RegExp(k + '=([^\\\\s]+)')); return m ? m[1] : ''; };",
  "const brokerUrl = pick('BROKER_URL');",
  "const runnerImage = pick('A2A_DOCKER_RUNNER_IMAGE');",
  "const secret = process.env.EDGE_SECRET || pick('EDGE_SECRET');",
  "const edgeSecretSha256 = secret ? crypto.createHash('sha256').update(secret).digest('hex') : '';",
  "let revision = '';",
  "try { revision = (require(root + '/dist/build-info.json').revision) || ''; } catch {}",
  "const active = sh('systemctl is-active ' + unit) === 'active';",
  "process.stdout.write(JSON.stringify({ node, brokerUrl, runnerImage, edgeSecretSha256, service: unit, root, revision, active }) + '\\n');",
  'NODE',
].join('\n');

function printCollect() {
  process.stdout.write(COLLECT_ONELINER + '\n');
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function main(argv = process.argv.slice(2)) {
  const subcommand = argv[0] && !argv[0].startsWith('-') ? argv[0] : null;
  const rest = subcommand ? argv.slice(1) : argv;

  if (subcommand === 'collect') {
    printCollect();
    process.exit(0);
  }

  const { values } = parseArgs({
    args: rest,
    options: {
      expected: { type: 'string', default: '' },
      observed: { type: 'string', default: '' },
      json: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
    },
  });

  if (!values.expected || !values.observed) {
    const msg = { ok: false, error: 'both --expected <file> and --observed <file> are required (or use the `collect` subcommand)' };
    process.stderr.write(JSON.stringify(msg, null, 2) + '\n');
    process.exit(1);
  }

  let expected;
  let observed;
  try {
    expected = readJson(values.expected);
  } catch (error) {
    process.stderr.write(JSON.stringify({ ok: false, malformed: true, error: `cannot read/parse --expected: ${error.message}` }, null, 2) + '\n');
    process.exit(1);
  }
  try {
    observed = readJson(values.observed);
  } catch (error) {
    process.stderr.write(JSON.stringify({ ok: false, malformed: true, error: `cannot read/parse --observed: ${error.message}` }, null, 2) + '\n');
    process.exit(1);
  }

  const result = evaluateFleet(expected, observed);
  const forced = values.force === true && !result.malformed && !result.ok;
  const exitCode = result.ok || forced ? 0 : 1;

  if (values.json) {
    const output = {
      ok: result.ok,
      malformed: result.malformed,
      forced,
      verdict: result.malformed ? 'MALFORMED-INPUT' : (result.ok ? 'PASS' : (forced ? 'FORCED-PAST-VIOLATIONS' : 'FAIL')),
      rows: result.rows,
      violations: result.violations,
      inputErrors: result.inputErrors,
    };
    const sink = exitCode === 0 ? process.stdout : process.stderr;
    sink.write(JSON.stringify(output, null, 2) + '\n');
  } else {
    const report = renderTextReport(result, { forced });
    const sink = exitCode === 0 ? process.stdout : process.stderr;
    sink.write(report);
  }

  process.exit(exitCode);
}

// Direct invocation
if (process.argv[1] && (process.argv[1].endsWith('a2a-fleet-routing-guard.mjs') || process.argv[1].endsWith('a2a-fleet-routing-guard'))) {
  main();
}

export {
  evaluateFleet,
  validateExpectedInventory,
  validateObservedList,
  renderTable,
  renderTextReport,
  CHECK_COLUMNS,
  COLLECT_ONELINER,
};
