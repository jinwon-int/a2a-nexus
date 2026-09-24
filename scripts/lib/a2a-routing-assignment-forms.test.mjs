/**
 * Regression suite for the #2196 slice-4 assignment forms library
 * (scripts/lib/a2a-routing-assignment-forms.mjs).
 *
 * Coverage: source-level purity (exact import specifiers, no fs/network/
 * child_process/env, no Date.now), pure closed-shape conversion with no
 * input mutation and no secret echo, dotted missing-field names, descriptor
 * validation, projection non-convertibility, untrusted broker/secret key
 * gate ordering, offline posture (zero POST, snapshot blocked/ridethrough,
 * throwing-fetch-guard admission path), journal-first resume (missing /
 * corrupt / no-taskIds), and entrypoint-authoritative kind_lane_mismatch.
 * No live broker is contacted; every network touch fails loudly.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  ROUTING_FORMS_VERSION,
  buildAssignmentRequest,
  prepareRoutingAssignment,
} from './a2a-routing-assignment-forms.mjs';
import {
  STATE_ADMISSION_UNCONFIRMED,
  STATE_BLOCKED,
  STATE_NEEDS_INPUT,
  STATE_PREPARED,
  TaskAssignJournal,
} from './task-assign-entrypoint.mjs';
import { ROUTING_ADVICE_SCHEMA_VERSION } from './a2a-routing-advice.mjs';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const CONTEXT = { brokerUrl: 'http://127.0.0.1:9', requester: { id: 'test-hub', role: 'hub' } };

function analysisDescriptor(overrides = {}) {
  return {
    schemaVersion: ROUTING_ADVICE_SCHEMA_VERSION,
    advisoryOnly: true,
    dispatchAllowed: false,
    projection: 'template_descriptor',
    templateId: 'tmpl-analysis-default',
    requiredHostFields: ['requestId', 'objective', 'requestRef'],
    template: { assignmentKind: 'analysis', mintsNewId: true },
    ...overrides,
  };
}

function patchDescriptor(overrides = {}) {
  return analysisDescriptor({
    templateId: 'tmpl-patch-default',
    requiredHostFields: [
      'requestId', 'objective', 'requestRef',
      'target.repo', 'target.declaredScope.paths', 'target.repoTests',
    ],
    template: { assignmentKind: 'patch', mintsNewId: true },
    ...overrides,
  });
}

function resumeDescriptor(overrides = {}) {
  return analysisDescriptor({
    templateId: 'tmpl-resume-observe',
    requiredHostFields: ['existingTaskReference'],
    template: { mintsNewId: false },
    ...overrides,
  });
}

function analysisHost(overrides = {}) {
  return {
    requestId: 'host-req-0001',
    objective: 'Analyze the routing classifier slice.',
    requestRef: 'https://example.com/ticket/2196',
    ...overrides,
  };
}

function patchHost(overrides = {}) {
  return {
    requestId: 'host-patch-0001',
    objective: 'Fix the widget regression.',
    requestRef: 'https://github.com/example/widgets/issues/1',
    target: {
      repo: 'example/widgets',
      declaredScope: { paths: ['src/widget.ts'] },
      repoTests: ['node --test'],
    },
    ...overrides,
  };
}

function workerRow(overrides = {}) {
  return {
    id: 'worker-alpha',
    status: 'online',
    managementPlane: 'connected',
    substantiveAnalysisReady: true,
    lastSeenAt: new Date().toISOString(),
    capabilities: { environments: ['linux'], workspaceIds: [] },
    metadata: {},
    ...overrides,
  };
}

function tmpJournalDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-forms-journal-'));
}

function noNetworkFetch() {
  return async () => { throw new Error('must not fetch'); };
}

// ─── Source purity ──────────────────────────────────────────────────────────

describe('a2a-routing-assignment-forms source purity', () => {
  const source = fs.readFileSync(
    new URL('./a2a-routing-assignment-forms.mjs', import.meta.url),
    'utf8',
  );

  it('declares the frozen forms version', () => {
    assert.equal(ROUTING_FORMS_VERSION, 'a2a.routing-forms.v1');
  });

  it('imports exactly the two allowed specifiers', () => {
    assert.match(source, /import \{ ROUTING_ADVICE_SCHEMA_VERSION \} from '\.\/a2a-routing-advice\.mjs';/);
    assert.match(source, /import \{ prepareAssignment, resumeAssignment \} from '\.\/task-assign-entrypoint\.mjs';/);
    const importLines = source.split('\n').filter((line) => /^import /.test(line));
    assert.equal(importLines.length, 2, importLines.join('\n'));
  });

  it('contains no fs, network, child_process, env, clock, or require access', () => {
    for (const forbidden of [
      /node:/, /require\(/, /child_process/, /\bfs\./, /process\.env/,
      /Date\.now/, /\bfetch\s*\(/, /http\.request/, /net\.connect/,
    ]) {
      assert.doesNotMatch(source, forbidden, `forbidden token: ${forbidden}`);
    }
  });
});

// ─── buildAssignmentRequest: purity & closed shapes ─────────────────────────

describe('buildAssignmentRequest purity and closed shapes', () => {
  it('is deterministic and never mutates either input', () => {
    const descriptor = analysisDescriptor();
    const host = analysisHost();
    const before = JSON.stringify([descriptor, host]);
    const first = buildAssignmentRequest(descriptor, host);
    const second = buildAssignmentRequest(descriptor, host);
    assert.equal(before, JSON.stringify([descriptor, host]));
    assert.deepEqual(first, second);
    assert.equal(first.ok, true);
  });

  it('returns exactly-closed frozen shapes on success and failure', () => {
    const ok = buildAssignmentRequest(analysisDescriptor(), analysisHost());
    assert.ok(ok.ok);
    assert.deepEqual(Object.keys(ok).sort(), ['ok', 'request']);
    assert.ok(Object.isFrozen(ok));

    const bad = buildAssignmentRequest(null, undefined);
    assert.equal(bad.ok, false);
    assert.deepEqual(Object.keys(bad).sort(), ['invalidFields', 'missingFields', 'ok', 'reasonCodes']);
    assert.ok(Object.isFrozen(bad));
    for (const key of ['reasonCodes', 'missingFields', 'invalidFields']) {
      assert.ok(Object.isFrozen(bad[key]), key);
    }
  });

  it('never echoes host values into failures', () => {
    const secret = 'super-secret-edge-value-9f8e7d6c';
    const brokerUrl = 'http://broker.internal.example:8443';
    const failure = buildAssignmentRequest(
      analysisDescriptor(),
      analysisHost({ apiToken: secret, brokerUrl, requesterWebhook: 'https://host.internal/cb' }),
    );
    assert.equal(failure.ok, false);
    const serialized = JSON.stringify(failure);
    assert.ok(!serialized.includes(secret), 'secret value echoed');
    // Host-substring probe over every string leaf: the bare hostname literal
    // carries no scheme, so it cannot trip CodeQL
    // js/incomplete-url-substring-sanitization (which fires on URL literals
    // used in `.includes` guards — including array membership checks), and it
    // subsumes an exact-URL probe: any echo of the broker URL must contain
    // its host.
    const leafStrings = (function collect(value) {
      if (typeof value === 'string') return [value];
      if (Array.isArray(value)) return value.flatMap(collect);
      if (value && typeof value === 'object') return Object.values(value).flatMap(collect);
      return [];
    })(failure);
    const brokerHost = 'broker.internal.example';
    assert.ok(
      !leafStrings.some((leaf) => leaf.includes(brokerHost)),
      'broker URL echoed',
    );
    assert.ok(!serialized.includes('requesterWebhook'), 'unknown host key propagated');
  });
});

// ─── buildAssignmentRequest: happy paths ────────────────────────────────────

describe('buildAssignmentRequest happy paths', () => {
  it('builds an analysis draft from the template assignmentKind', () => {
    const result = buildAssignmentRequest(analysisDescriptor(), analysisHost());
    assert.equal(result.ok, true);
    assert.deepEqual(result.request, {
      requestId: 'host-req-0001',
      kind: 'analysis',
      objective: 'Analyze the routing classifier slice.',
      requestRef: 'https://example.com/ticket/2196',
    });
    assert.equal(result.request.target, undefined);
  });

  it('builds a patch draft with the patch-only target block', () => {
    const result = buildAssignmentRequest(patchDescriptor(), patchHost());
    assert.equal(result.ok, true);
    assert.equal(result.request.kind, 'patch');
    assert.deepEqual(result.request.target, {
      repo: 'example/widgets',
      declaredScope: { paths: ['src/widget.ts'] },
      repoTests: ['node --test'],
    });
  });

  it('passes non-analysis/patch assignmentKinds through untouched (entrypoint keeps kind authority)', () => {
    for (const kind of ['review', 'observe']) {
      const result = buildAssignmentRequest(
        analysisDescriptor({ template: { assignmentKind: kind, mintsNewId: true } }),
        analysisHost(),
      );
      assert.equal(result.ok, true, kind);
      assert.equal(result.request.kind, kind);
    }
  });

  it('keeps lanes as an unchanged passthrough and drops unknown host keys', () => {
    const lanes = [{ intent: 'analyze', payload: { mode: 'analysis-only' } }];
    const host = analysisHost({ lanes, requesterWebhook: 'https://host.internal/cb' });
    const result = buildAssignmentRequest(analysisDescriptor(), host);
    assert.equal(result.ok, true);
    assert.equal(result.request.lanes, lanes);
    assert.ok(!JSON.stringify(result.request).includes('requesterWebhook'));
  });

  it('resolves the existing-reference requestId from the host reference', () => {
    const host = { existingTaskReference: 'gone-dark-req' };
    const result = buildAssignmentRequest(resumeDescriptor(), host);
    assert.equal(result.ok, true);
    assert.deepEqual(result.request, { requestId: 'gone-dark-req' });
  });
});

// ─── buildAssignmentRequest: fail-closed validation ─────────────────────────

describe('buildAssignmentRequest fail-closed validation', () => {
  it('rejects malformed descriptors with invalid_descriptor', () => {
    const variants = [
      null,
      [],
      analysisDescriptor({ schemaVersion: 'a2a.routing-advice.v0' }),
      analysisDescriptor({ advisoryOnly: false }),
      analysisDescriptor({ dispatchAllowed: true }),
      analysisDescriptor({ projection: '' }),
      analysisDescriptor({ templateId: undefined }),
      analysisDescriptor({ requiredHostFields: [] }),
      analysisDescriptor({ requiredHostFields: ['requestId', '  '] }),
      analysisDescriptor({ template: undefined }),
      analysisDescriptor({ template: { mintsNewId: false }, requiredHostFields: ['requestId'] }),
    ];
    for (const variant of variants) {
      const result = buildAssignmentRequest(variant, analysisHost());
      assert.equal(result.ok, false, JSON.stringify(variant));
      assert.deepEqual(result.reasonCodes, ['invalid_descriptor'], JSON.stringify(variant));
      assert.deepEqual(result.missingFields, []);
      assert.deepEqual(result.invalidFields, []);
    }
  });

  it('maps none/blocked projections to projection_not_convertible without synthesizing a plan', () => {
    for (const projection of ['none', 'blocked']) {
      const result = buildAssignmentRequest(analysisDescriptor({ projection }), analysisHost());
      assert.equal(result.ok, false);
      assert.deepEqual(result.reasonCodes, ['projection_not_convertible']);
      assert.equal(result.request, undefined);
    }
  });

  it('reports exact dotted field names for missing/blank/empty host fields', () => {
    const missing = buildAssignmentRequest(
      patchDescriptor(),
      patchHost({ target: { repo: 'example/widgets', declaredScope: {}, repoTests: ['node --test'] } }),
    );
    assert.equal(missing.ok, false);
    assert.deepEqual(missing.reasonCodes, ['missing_required_fields']);
    assert.deepEqual(missing.missingFields, ['target.declaredScope.paths']);

    const blank = buildAssignmentRequest(analysisDescriptor(), analysisHost({ objective: '   ' }));
    assert.deepEqual(blank.missingFields, ['objective']);

    const emptyArray = buildAssignmentRequest(
      patchDescriptor(),
      patchHost({ target: { repo: 'example/widgets', declaredScope: { paths: ['src/widget.ts'] }, repoTests: [] } }),
    );
    assert.deepEqual(emptyArray.missingFields, ['target.repoTests']);
  });

  it('treats an absent host context as all fields missing', () => {
    const result = buildAssignmentRequest(analysisDescriptor(), undefined);
    assert.equal(result.ok, false);
    assert.deepEqual(result.reasonCodes, ['missing_required_fields']);
    assert.deepEqual(result.missingFields, ['requestId', 'objective', 'requestRef']);
  });

  it('reports existing_reference_missing with the exact reference field name', () => {
    const result = buildAssignmentRequest(resumeDescriptor(), {});
    assert.equal(result.ok, false);
    assert.deepEqual(result.reasonCodes, ['existing_reference_missing']);
    assert.deepEqual(result.missingFields, ['existingTaskReference']);
  });

  it('rejects references violating the requestId pattern via request.requestId', () => {
    for (const bad of ['has spaces', '-leading-dash', 'a'.repeat(129)]) {
      const result = buildAssignmentRequest(resumeDescriptor(), { existingTaskReference: bad });
      assert.equal(result.ok, false, bad);
      assert.deepEqual(result.reasonCodes, ['invalid_existing_reference'], bad);
      assert.deepEqual(result.invalidFields, ['request.requestId']);
    }
    const boundary = buildAssignmentRequest(resumeDescriptor(), { existingTaskReference: 'a'.repeat(128) });
    assert.equal(boundary.ok, true);
  });

  it('gates broker/secret-shaped host keys before any draft is built', () => {
    const broker = buildAssignmentRequest(analysisDescriptor(), analysisHost({ brokerUrl: 'http://x' }));
    assert.equal(broker.ok, false);
    assert.deepEqual(broker.reasonCodes, ['untrusted_broker_or_secret_input']);
    assert.deepEqual(broker.invalidFields, ['request.brokerUrl']);

    const secretKey = buildAssignmentRequest(analysisDescriptor(), analysisHost({ apiToken: 'tok' }));
    assert.deepEqual(secretKey.invalidFields, ['request.apiToken']);

    const multi = buildAssignmentRequest(
      analysisDescriptor(),
      analysisHost({ authorization: 'Bearer x', apiToken: 'tok' }),
    );
    assert.deepEqual(multi.invalidFields.slice().sort(), ['request.apiToken', 'request.authorization']);

    // Gate ordering: secret keys win over missing-required reporting.
    const ordered = buildAssignmentRequest(analysisDescriptor(), {});
    const withSecret = buildAssignmentRequest(
      analysisDescriptor({ requiredHostFields: ['requestId'] }),
      { apiToken: 'tok' },
    );
    assert.deepEqual(withSecret.reasonCodes, ['untrusted_broker_or_secret_input']);
    assert.notDeepEqual(ordered.reasonCodes, ['untrusted_broker_or_secret_input']);
  });
});

// ─── prepareRoutingAssignment: offline posture ──────────────────────────────

describe('prepareRoutingAssignment offline posture', () => {
  it('has no mode parameter and never POSTs; missing snapshot blocks offline', async () => {
    let networkTouched = false;
    const receipt = await prepareRoutingAssignment({
      descriptor: analysisDescriptor(),
      hostContext: analysisHost(),
      context: CONTEXT,
      fetchImpl: async () => { networkTouched = true; throw new Error('must not fetch'); },
    });
    assert.equal(networkTouched, false);
    assert.equal(receipt.state, STATE_BLOCKED);
    assert.equal(receipt.reasonCodes[0], 'offline_snapshot_missing');
  });

  it('rides a host-supplied readiness snapshot through to prepared', async () => {
    const receipt = await prepareRoutingAssignment({
      descriptor: analysisDescriptor(),
      hostContext: analysisHost(),
      context: CONTEXT,
      readiness: { observedAt: new Date().toISOString(), records: [workerRow()] },
      fetchImpl: noNetworkFetch(),
    });
    assert.equal(receipt.state, STATE_PREPARED);
    assert.equal(receipt.requestId, 'host-req-0001');
    assert.ok(receipt.manifest);
  });

  it('throws loudly when the guard replaces an omitted fetchImpl on readback paths', async () => {
    const dir = tmpJournalDir();
    try {
      const journal = new TaskAssignJournal({ dir });
      journal.recordInitial('gone-dark', {
        specDigest: 'sha256:' + '0'.repeat(64),
        kind: 'analysis',
        laneIds: ['assign-gone-dark:1'],
        brokerUrl: CONTEXT.brokerUrl,
        requesterId: 'test-hub',
      });
      journal.update('gone-dark', { taskIds: ['assign-gone-dark:1'] });
      const receipt = await prepareRoutingAssignment({
        descriptor: resumeDescriptor(),
        hostContext: { existingTaskReference: 'gone-dark' },
        context: CONTEXT,
        journal,
        // no fetchImpl: throwing guard must surface as readback_unavailable,
        // never as a silent guess or a fabricated admission.
      });
      assert.equal(receipt.state, STATE_ADMISSION_UNCONFIRMED);
      assert.equal(receipt.nextAction.code, 'verify_admission');
      assert.ok(receipt.lanes[0].reasonCodes.includes('readback_unavailable'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── prepareRoutingAssignment: journal-first resume ─────────────────────────

describe('prepareRoutingAssignment journal-first resume', () => {
  it('fails closed with journal_missing when no journal is supplied', async () => {
    const result = await prepareRoutingAssignment({
      descriptor: resumeDescriptor(),
      hostContext: { existingTaskReference: 'never-seen' },
      context: CONTEXT,
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.reasonCodes, ['journal_missing']);
    assert.deepEqual(result.missingFields, ['journal']);
  });

  it('maps a missing journal record to resume_record_missing with nextAction none', async () => {
    const dir = tmpJournalDir();
    try {
      const receipt = await prepareRoutingAssignment({
        descriptor: resumeDescriptor(),
        hostContext: { existingTaskReference: 'never-seen' },
        context: CONTEXT,
        journal: new TaskAssignJournal({ dir }),
      });
      assert.equal(receipt.state, STATE_BLOCKED);
      assert.equal(receipt.reasonCodes[0], 'resume_record_missing');
      assert.equal(receipt.nextAction.code, 'none');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('maps a torn journal record to journal_record_corrupt', async () => {
    const dir = tmpJournalDir();
    try {
      const journal = new TaskAssignJournal({ dir });
      fs.writeFileSync(path.join(dir, 'torn-resume.json'), '{torn', 'utf8');
      const receipt = await prepareRoutingAssignment({
        descriptor: resumeDescriptor(),
        hostContext: { existingTaskReference: 'torn-resume' },
        context: CONTEXT,
        journal,
      });
      assert.ok(receipt.reasonCodes.includes('journal_record_corrupt'), JSON.stringify(receipt.reasonCodes));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns prepared + no_task_ids_recorded when the record has no taskIds yet', async () => {
    const dir = tmpJournalDir();
    try {
      const journal = new TaskAssignJournal({ dir });
      journal.recordInitial('fresh-prepare', {
        specDigest: 'sha256:' + '0'.repeat(64),
        kind: 'analysis',
        laneIds: [],
        brokerUrl: CONTEXT.brokerUrl,
        requesterId: 'test-hub',
      });
      const receipt = await prepareRoutingAssignment({
        descriptor: resumeDescriptor(),
        hostContext: { existingTaskReference: 'fresh-prepare' },
        context: CONTEXT,
        journal,
      });
      assert.equal(receipt.state, STATE_PREPARED);
      assert.deepEqual(receipt.reasonCodes, ['no_task_ids_recorded']);
      assert.equal(receipt.nextAction.code, 'retry_prepare');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── Entrypoint lane authority ──────────────────────────────────────────────

describe('kind_lane_mismatch stays entrypoint-authoritative', () => {
  it('blocks an analysis draft carrying patch lanes through the wrapper', async () => {
    const receipt = await prepareRoutingAssignment({
      descriptor: analysisDescriptor(),
      hostContext: analysisHost({ lanes: [{ intent: 'propose_patch', payload: { mode: 'github-propose-patch' } }] }),
      context: CONTEXT,
      readiness: { observedAt: new Date().toISOString(), records: [workerRow()] },
      fetchImpl: noNetworkFetch(),
    });
    assert.equal(receipt.state, STATE_NEEDS_INPUT);
    assert.ok(receipt.reasonCodes.includes('kind_lane_mismatch'), JSON.stringify(receipt.reasonCodes));
  });

  it('blocks a patch draft carrying analysis lanes through the wrapper', async () => {
    const receipt = await prepareRoutingAssignment({
      descriptor: patchDescriptor(),
      hostContext: patchHost({ lanes: [{ intent: 'analyze', payload: { mode: 'analysis-only' } }] }),
      context: CONTEXT,
      readiness: { observedAt: new Date().toISOString(), records: [workerRow()] },
      fetchImpl: noNetworkFetch(),
    });
    assert.equal(receipt.state, STATE_NEEDS_INPUT);
    assert.ok(receipt.reasonCodes.includes('kind_lane_mismatch'), JSON.stringify(receipt.reasonCodes));
  });
});
