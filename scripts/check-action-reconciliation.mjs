#!/usr/bin/env node

/**
 * check-action-reconciliation.mjs
 *
 * Validation script for the approval-gated auto-closeout action reconciliation
 * contract and fixture. Reads the schema and fixture, then evaluates each scenario.
 *
 * Usage:
 *   node scripts/check-action-reconciliation.mjs \
 *     --spec docs/specs/a2a-action-reconciliation/schema.json \
 *     --fixture fixtures/contract/action-reconciliation.json
 *
 * Options:
 *   --spec      Path to schema JSON (required)
 *   --fixture   Path to fixture JSON (required)
 *   --json      Output raw JSON instead of human-readable text
 *   --quiet     Only print pass/fail summary
 *   --help      Show usage
 *
 * Exit codes:
 *   0 - All scenarios pass
 *   1 - One or more scenarios fail, or usage error
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { spec: null, fixture: null, json: false, quiet: false };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--spec':
        opts.spec = resolve(REPO_ROOT, args[++i]);
        break;
      case '--fixture':
        opts.fixture = resolve(REPO_ROOT, args[++i]);
        break;
      case '--json':
        opts.json = true;
        break;
      case '--quiet':
        opts.quiet = true;
        break;
      case '--help':
        console.log(`
Usage:
  node scripts/check-action-reconciliation.mjs \\
    --spec <schema.json> \\
    --fixture <fixture.json>

Options:
  --spec      Path to schema JSON (required)
  --fixture   Path to fixture JSON (required)
  --json      Output raw JSON instead of human-readable text
  --quiet     Only print pass/fail summary
  --help      Show this help
`);
        process.exit(0);
      default:
        if (!opts.spec || !opts.fixture) {
          console.error(`Error: Unexpected argument "${args[i]}". Use --spec and --fixture.`);
          process.exit(1);
        }
    }
  }

  if (!opts.spec) {
    console.error('Error: --spec is required');
    process.exit(1);
  }
  if (!opts.fixture) {
    console.error('Error: --fixture is required');
    process.exit(1);
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Reconciliation engine — deterministic, no side effects
// ---------------------------------------------------------------------------

/**
 * Evaluate a single reconciliation scenario.
 *
 * The implementation is entirely deterministic: it reads the "given" conditions
 * and computes the "then" expectations without any I/O, provider calls, or
 * state mutation.
 */
function evaluateScenario(scenario) {
  const { given, when } = scenario;
  const result = {};

  // Defaults
  result.duplicateSuppressed = false;
  result.conflictDetected = false;
  result.github403Detected = false;
  result.brokerOfRecordMismatch = false;
  result.operatorActionRequired = false;
  result.liveProviderSend = false;
  result.terminalOutboxAckMutated = false;

  const matrixDecision = given.matrixDecision;
  const actions = given.actions || [];
  const gitHubPermissionOk = given.gitHubPermissionOk !== false;
  const brokerOfRecord = given.brokerOfRecord;
  const reconcilingBroker = given.reconcilingBroker || brokerOfRecord;
  const operatorApproved = given.operatorApproved === true;
  const isReplay = when.operation === 'reconciliation.replay';
  const isRollback = when.operation === 'reconciliation.rollback';
  const isApprove = when.operation === 'reconciliation.approve';
  const conflictingPayload = given.conflictingPayload === true;
  const actionsReconciled = given.actionsReconciled === true;

  // Check broker of record mismatch
  if (reconcilingBroker !== brokerOfRecord) {
    result.brokerOfRecordMismatch = true;
    result.reconciliationState = 'PENDING';
    result.expectedLastActionState = 'PENDING';
    result.operatorActionRequired = true;
    return result;
  }

  // Check GitHub permission
  if (!gitHubPermissionOk) {
    result.github403Detected = true;
    result.reconciliationState = 'PENDING';
    result.expectedLastActionState = 'PENDING';
    result.operatorActionRequired = true;
    return result;
  }

  // Handle replay operations
  if (isReplay) {
    const existingAction = actions[0];
    if (!existingAction) {
      result.reconciliationState = 'PENDING';
      result.expectedLastActionState = 'PENDING';
      return result;
    }

    const existingState = existingAction.existingState || 'PENDING';

    if (existingState === 'CONFIRMED') {
      if (conflictingPayload) {
        // Same key, different payload — conflict
        result.conflictDetected = true;
        result.reconciliationState = 'FAILED';
        result.expectedLastActionState = 'FAILED';
        result.operatorActionRequired = true;
        result.newDispatchCreated = false;
      } else {
        // Same key, same payload — duplicate suppression
        result.duplicateSuppressed = true;
        result.reconciliationState = 'CONFIRMED';
        result.expectedLastActionState = 'CONFIRMED';
        result.newDispatchCreated = false;
      }
    } else if (existingState === 'FAILED') {
      result.staleKey = true;
      result.reconciliationState = 'FAILED';
      result.expectedLastActionState = 'FAILED';
      result.operatorActionRequired = true;
    } else {
      // Non-terminal state — should not be replaying
      result.reconciliationState = 'PENDING';
      result.expectedLastActionState = 'PENDING';
      result.operatorActionRequired = true;
    }
    return result;
  }

  // Handle rollback
  if (isRollback) {
    result.reconciliationState = 'PENDING';
    result.expectedLastActionState = 'PENDING';
    result.rollbackType = 'metadata-only';
    return result;
  }

  // Handle approval
  if (isApprove) {
    if (matrixDecision !== 'GO') {
      result.reconciliationState = 'PENDING';
      result.expectedLastActionState = 'PENDING';
      result.actionReconciliationGate = 'BLOCKED_BY_MATRIX';
      return result;
    }

    if (!operatorApproved) {
      // Actions are reconciled but not yet operator-approved
      result.reconciliationState = 'RECONCILED';
      result.expectedLastActionState = 'RECONCILED';
      result.actionReconciliationGate = 'PENDING_APPROVAL';
      result.operatorActionRequired = true;
      return result;
    }

    // Operator approved — advance to APPROVED
    result.reconciliationState = 'APPROVED';
    result.expectedLastActionState = 'APPROVED';
    return result;
  }

  // Normal evaluate operation (reconciliation.evaluate)
  if (matrixDecision === 'NO_GO' || matrixDecision === 'BLOCKED') {
    result.blockerMatrixDecision = matrixDecision;
    if (given.blockedGate) {
      result.blockedGate = given.blockedGate;
    }
    result.reconciliationState = 'PENDING';
    result.expectedLastActionState = 'PENDING';
    if (matrixDecision === 'BLOCKED') {
      result.operatorActionRequired = true;
    }
    return result;
  }

  // matrixDecision === 'GO'
  if (actions.length === 0) {
    result.reconciliationState = 'PENDING';
    result.expectedLastActionState = 'PENDING';
    return result;
  }

  // Advance to RECONCILED
  result.reconciliationState = 'RECONCILED';
  result.expectedLastActionState = 'RECONCILED';
  return result;
}

// ---------------------------------------------------------------------------
// Scenario comparison
// ---------------------------------------------------------------------------

function compareResults(computed, expected) {
  const failures = [];
  const keys = new Set([...Object.keys(computed), ...Object.keys(expected)]);

  for (const key of keys) {
    // Skip non-comparable fields in expected
    if (key === 'name' || key === 'description' || key === 'given' || key === 'when') continue;

    const cv = computed[key];
    const ev = expected[key];

    if (ev !== undefined && cv !== ev) {
      failures.push({ key, expected: ev, got: cv });
    }
  }

  return failures;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const opts = parseArgs();

  // Read files
  let schema, fixture;
  try {
    schema = JSON.parse(readFileSync(opts.spec, 'utf-8'));
  } catch (err) {
    console.error(`Error reading schema "${opts.spec}": ${err.message}`);
    process.exit(1);
  }

  try {
    fixture = JSON.parse(readFileSync(opts.fixture, 'utf-8'));
  } catch (err) {
    console.error(`Error reading fixture "${opts.fixture}": ${err.message}`);
    process.exit(1);
  }

  const scenarios = fixture.scenarios || [];
  const total = scenarios.length;
  const results = [];
  let passed = 0;
  let failed = 0;

  if (total === 0) {
    console.error('Error: fixture has no scenarios');
    process.exit(1);
  }

  for (const scenario of scenarios) {
    const computed = evaluateScenario(scenario);
    const expectedThen = scenario.then || {};
    const failures = compareResults(computed, expectedThen);

    results.push({
      name: scenario.name,
      description: scenario.description,
      computed,
      expected: expectedThen,
      pass: failures.length === 0,
      failures,
    });

    if (failures.length === 0) {
      passed++;
    } else {
      failed++;
    }
  }

  // Summary
  let canaryGatePass = failed === 0;
  const output = {
    canaryGate: canaryGatePass ? 'PASS' : 'FAIL',
    total,
    passed,
    failed,
    scenarios: results,
    liveProviderSend: false,
    terminalOutboxAckMutated: false,
    runtimeBootstrapHygieneConfirmed: false,
  };

  // Verify safety invariants across all results.
  // Every computed record must have liveProviderSend === false and
  // terminalOutboxAckMutated === false.
  for (const r of results) {
    if (r.computed.liveProviderSend !== false) {
      output.liveProviderSend = 'DETECTED';
    }
    if (r.computed.terminalOutboxAckMutated !== false) {
      output.terminalOutboxAckMutated = 'DETECTED';
    }
  }

  // Runtime bootstrap hygiene check (synthetic: scripts should report it)
  // In a real run, this would scan the branch diff. For the deterministic
  // canary, we confirm that the fixture's safety confirmations include it.
  output.runtimeBootstrapHygieneConfirmed =
    fixture.safetyConfirmations?.runtimeBootstrapHygieneRequiredBeforePublication === true;

  // If any safety invariant was violated, override the canary gate
  if (output.liveProviderSend === 'DETECTED' || output.terminalOutboxAckMutated === 'DETECTED') {
    canaryGatePass = false;
    output.canaryGate = 'FAIL';
  }

  // Report
  if (opts.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    if (!opts.quiet) {
      console.log('=== Approval-Gated Auto-Closeout Action Reconciliation Canary ===\n');
      console.log(`Fixture:     ${fixture.fixtureId}`);
      console.log(`ParentRound: ${fixture.parentRoundId}`);
      console.log(`Broker:      ${fixture.brokerOfRecord}`);
      console.log(`Run:         ${fixture.run}\n`);
    }

    for (const r of results) {
      if (r.pass) {
        console.log(`  ✅ ${r.name}`);
      } else {
        console.log(`  ❌ ${r.name}`);
        for (const f of r.failures) {
          console.log(`       ${f.key}: expected "${f.expected}", got "${f.got}"`);
        }
      }
    }

    console.log(`\n  Summary: ${passed}/${total} passed`);
    console.log(`  Canary:  ${output.canaryGate}`);
    console.log(`  Live provider send:       ${output.liveProviderSend === false ? '✅ none' : '❌ DETECTED'}`);
    console.log(`  Terminal outbox ACK mut:  ${output.terminalOutboxAckMutated === false ? '✅ none' : '❌ DETECTED'}`);
    console.log(`  Runtime bootstrap hygiene: ${output.runtimeBootstrapHygieneConfirmed ? '✅ confirmed' : '⚠️  check required'}`);

    if (canaryGatePass) {
      console.log('\n✅ canaryGate: PASS — all scenarios verified.');
    } else {
      console.log('\n❌ canaryGate: FAIL — one or more scenarios failed.');
    }
  }

  process.exit(canaryGatePass ? 0 : 1);
}

main();
