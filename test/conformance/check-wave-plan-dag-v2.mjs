#!/usr/bin/env node
// Deterministic, no-network conformance for the source-only WavePlanDagV2
// proposal and pure read-only dry-run contract.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const FIXTURE_PATH = path.join(ROOT, 'fixtures', 'contract', 'wave-plan-dag-v2.json');
const THIS_PATH = path.join(ROOT, 'test', 'conformance', 'check-wave-plan-dag-v2.mjs');

const FRAME_HEADER = Buffer.from('A2A-WAVE-PLAN-DAG-V2\0', 'ascii');
const MANIFEST_DOMAIN = 'a2a.wave-plan-dag-v2.manifest.v2';
const RECEIPT_DOMAIN = 'a2a.wave-plan-dag-v2.dry-run-receipt.v2';
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const PLAN_ALIAS_PATTERN = /^wpm_[0-9a-f]{16}$/;
const STAGE_ID_PATTERN = /^stg_[0-9a-f]{8}$/;
const STAGE_MANIFEST_ALIAS_PATTERN = /^mft_[0-9a-f]{16}$/;

const LIMITS = Object.freeze({
  maxStages: 32,
  maxEdges: 64,
  maxDepth: 8,
  maxFanIn: 8,
  maxFanOut: 8,
});

const AUTHORITY_FIELDS = Object.freeze([
  'claimAuthority',
  'executionAuthority',
  'finalizerAuthority',
  'liveAuthority',
  'retryAuthority',
  'successAuthority',
]);

const MANIFEST_FIELDS = Object.freeze([
  'autoDispatch',
  'claimAuthority',
  'dryRunRequired',
  'edges',
  'executionAuthority',
  'finalizerAuthority',
  'kind',
  'limits',
  'liveAuthority',
  'manifestAlias',
  'manifestDigest',
  'manifestDigestDomain',
  'operatorAdvanceRequired',
  'proposalSource',
  'retryAuthority',
  'stages',
  'successAuthority',
  'version',
]);

const RECEIPT_FIELDS = Object.freeze([
  'autoDispatch',
  'claimAuthority',
  'dryRunRequired',
  'executionAuthority',
  'finalizerAuthority',
  'kind',
  'liveAuthority',
  'manifestAlias',
  'manifestDigest',
  'mode',
  'operatorAdvanceRequired',
  'receiptDigest',
  'receiptDigestDomain',
  'retryAuthority',
  'stages',
  'successAuthority',
  'topologicalOrder',
  'version',
]);

const EXPECTED_TOPOLOGY = Object.freeze([
  'stg_00000000',
  'stg_00000010',
  'stg_00000020',
  'stg_00000030',
  'stg_00000035',
  'stg_00000040',
  'stg_00000050',
  'stg_00000060',
]);

const PINNED_MANIFEST_DIGEST =
  'sha256:6ba74c6885d4b47edf4aaa57b3b1525903508583e47ed61333704c82de5b3999';
const PINNED_RECEIPT_DIGESTS = Object.freeze([
  'sha256:b275a5bcf57038965171be8708d004773b8b94e997666a83f4818352a79e20c9',
  'sha256:85102e14f419825fef7d755549b59dc4f9a4a695cc7d6e1e5b9804cd3e3ff71b',
]);

class ContractError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'ContractError';
    this.reason = reason;
  }
}

function reject(reason, message) {
  throw new ContractError(reason, message);
}

function clone(value) {
  return structuredClone(value);
}

function sortedKeys(value) {
  return Object.keys(value).sort();
}

function assertClosed(value, expectedFields, label, reason = 'manifest_malformed') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    reject(reason, `${label} must be an object`);
  }
  const actual = sortedKeys(value);
  const expected = [...expectedFields].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    reject(reason, `${label} fields differ: ${JSON.stringify(actual)}`);
  }
}

function assertAscii(value, label, reason = 'manifest_malformed') {
  if (typeof value !== 'string' || !/^[\x20-\x7e]+$/.test(value)) {
    reject(reason, `${label} must be non-empty printable ASCII`);
  }
}

function assertPattern(value, pattern, label, reason = 'manifest_malformed') {
  assertAscii(value, label, reason);
  if (!pattern.test(value)) reject(reason, `${label} has invalid form`);
}

function canonicalize(value) {
  if (typeof value === 'string') {
    assertAscii(value, 'canonical string');
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) reject('manifest_malformed', 'canonical number must be a safe integer');
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${sortedKeys(value)
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(',')}}`;
  }
  reject('manifest_malformed', 'null and unsupported canonical values are forbidden');
}

function u32be(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    reject('manifest_malformed', 'digest frame length exceeds uint32');
  }
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function framedDigest(domain, payload) {
  assertAscii(domain, 'digest domain');
  const domainBytes = Buffer.from(domain, 'ascii');
  const payloadBytes = Buffer.from(canonicalize(payload), 'utf8');
  return `sha256:${createHash('sha256')
    .update(Buffer.concat([
      FRAME_HEADER,
      u32be(domainBytes.length),
      domainBytes,
      u32be(payloadBytes.length),
      payloadBytes,
    ]))
    .digest('hex')}`;
}

function edgeTuple(edge) {
  return `${edge.fromStageId}\0${edge.toStageId}\0${edge.when}`;
}

function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function manifestDigestPayload(manifest) {
  const { manifestDigest: _excluded, ...payload } = manifest;
  return {
    ...payload,
    stages: [...manifest.stages].sort((left, right) => compareAscii(left.stageId, right.stageId)),
    edges: [...manifest.edges].sort((left, right) => compareAscii(edgeTuple(left), edgeTuple(right))),
  };
}

function manifestDigestFor(manifest) {
  return framedDigest(MANIFEST_DOMAIN, manifestDigestPayload(manifest));
}

function receiptDigestFor(receipt) {
  const { receiptDigest: _excluded, ...payload } = receipt;
  return framedDigest(RECEIPT_DOMAIN, payload);
}

function withManifestDigest(manifest) {
  const candidate = clone(manifest);
  candidate.manifestDigest = manifestDigestFor(candidate);
  return candidate;
}

function assertAuthorityBoundary(value, label) {
  if (value.autoDispatch !== false
    || value.operatorAdvanceRequired !== true
    || value.dryRunRequired !== true) {
    reject('manifest_malformed', `${label} dispatch/dry-run boundary changed`);
  }
  for (const field of AUTHORITY_FIELDS) {
    if (value[field] !== 'none') {
      reject('manifest_malformed', `${label} attempted to grant ${field}`);
    }
  }
}

function topologicalOrder(stageIds, outgoing, indegree) {
  const remaining = new Map(indegree);
  const available = stageIds.filter((stageId) => remaining.get(stageId) === 0).sort(compareAscii);
  const ordered = [];
  while (available.length > 0) {
    const stageId = available.shift();
    ordered.push(stageId);
    for (const edge of outgoing.get(stageId)) {
      const next = remaining.get(edge.toStageId) - 1;
      remaining.set(edge.toStageId, next);
      if (next === 0) {
        available.push(edge.toStageId);
        available.sort(compareAscii);
      }
    }
  }
  return ordered;
}

function validateManifest(manifest) {
  assertClosed(manifest, MANIFEST_FIELDS, 'WavePlanDagManifestV2');
  if (manifest.kind !== 'WavePlanDagManifestV2' || manifest.version !== 2) {
    reject('manifest_malformed', 'manifest kind/version mismatch');
  }
  if (!['model', 'operator'].includes(manifest.proposalSource)) {
    reject('manifest_malformed', 'proposalSource is not closed');
  }
  assertPattern(manifest.manifestAlias, PLAN_ALIAS_PATTERN, 'manifestAlias');
  assertPattern(manifest.manifestDigest, DIGEST_PATTERN, 'manifestDigest');
  if (manifest.manifestDigestDomain !== MANIFEST_DOMAIN) {
    reject('manifest_malformed', 'manifest digest domain mismatch');
  }
  assertClosed(manifest.limits, Object.keys(LIMITS), 'limits');
  if (canonicalize(manifest.limits) !== canonicalize(LIMITS)) {
    reject('manifest_malformed', 'limits must equal fixed V2 limits');
  }
  assertAuthorityBoundary(manifest, 'manifest');

  if (!Array.isArray(manifest.stages)) {
    reject('manifest_malformed', 'stages must be an array');
  }
  if (manifest.stages.length < 1 || manifest.stages.length > LIMITS.maxStages) {
    reject('stage_limit_exceeded', 'stage count outside 1..32');
  }
  if (!Array.isArray(manifest.edges)) {
    reject('manifest_malformed', 'edges must be an array');
  }
  if (manifest.edges.length > LIMITS.maxEdges) {
    reject('edge_limit_exceeded', 'edge count exceeds 64');
  }

  const stageIds = [];
  const stageById = new Map();
  const manifestAliases = new Set();
  for (const stage of manifest.stages) {
    assertClosed(
      stage,
      ['joinPolicy', 'manifestAlias', 'reviewedManifestDigest', 'stageId'],
      'WavePlanDagStageV2',
    );
    assertPattern(stage.stageId, STAGE_ID_PATTERN, 'stageId');
    assertPattern(stage.manifestAlias, STAGE_MANIFEST_ALIAS_PATTERN, 'stage manifestAlias');
    assertPattern(stage.reviewedManifestDigest, DIGEST_PATTERN, 'reviewedManifestDigest');
    if (!['root', 'all_matching', 'any_matching'].includes(stage.joinPolicy)) {
      reject('manifest_malformed', 'unknown joinPolicy');
    }
    if (stageById.has(stage.stageId)) {
      reject('duplicate_stage', `duplicate stage ${stage.stageId}`);
    }
    if (manifestAliases.has(stage.manifestAlias)) {
      reject('manifest_malformed', 'stage manifest aliases must be unique');
    }
    stageIds.push(stage.stageId);
    stageById.set(stage.stageId, stage);
    manifestAliases.add(stage.manifestAlias);
  }

  const incoming = new Map(stageIds.map((stageId) => [stageId, []]));
  const outgoing = new Map(stageIds.map((stageId) => [stageId, []]));
  const endpointPairs = new Set();
  for (const edge of manifest.edges) {
    assertClosed(edge, ['fromStageId', 'toStageId', 'when'], 'WavePlanDagEdgeV2');
    assertPattern(edge.fromStageId, STAGE_ID_PATTERN, 'fromStageId');
    assertPattern(edge.toStageId, STAGE_ID_PATTERN, 'toStageId');
    if (!['gate_passed', 'gate_failed', 'any_terminal'].includes(edge.when)) {
      reject('manifest_malformed', 'unknown edge predicate');
    }
    if (edge.fromStageId === edge.toStageId) {
      reject('self_edge', `self edge ${edge.fromStageId}`);
    }
    if (!stageById.has(edge.fromStageId) || !stageById.has(edge.toStageId)) {
      reject('unknown_endpoint', 'edge references unknown stage');
    }
    const pair = `${edge.fromStageId}\0${edge.toStageId}`;
    if (endpointPairs.has(pair)) {
      reject('duplicate_edge', 'repeated endpoint pair');
    }
    endpointPairs.add(pair);
    outgoing.get(edge.fromStageId).push(edge);
    incoming.get(edge.toStageId).push(edge);
  }

  for (const stageId of stageIds) {
    if (incoming.get(stageId).length > LIMITS.maxFanIn) {
      reject('fan_in_limit_exceeded', `fan-in exceeds 8 at ${stageId}`);
    }
    if (outgoing.get(stageId).length > LIMITS.maxFanOut) {
      reject('fan_out_limit_exceeded', `fan-out exceeds 8 at ${stageId}`);
    }
  }

  const roots = stageIds.filter((stageId) => incoming.get(stageId).length === 0);
  if (roots.length !== 1) reject('root_count_invalid', 'graph must have exactly one root');
  const root = roots[0];
  if (!stageIds.some((stageId) => outgoing.get(stageId).length === 0)) {
    reject('manifest_malformed', 'graph must have at least one leaf');
  }
  for (const stageId of stageIds) {
    const expectedJoin = stageId === root ? 'root' : null;
    if ((expectedJoin && stageById.get(stageId).joinPolicy !== expectedJoin)
      || (!expectedJoin && stageById.get(stageId).joinPolicy === 'root')) {
      reject('manifest_malformed', 'root joinPolicy must match structural root');
    }
  }

  const reachable = new Set([root]);
  const queue = [root];
  while (queue.length > 0) {
    const stageId = queue.shift();
    for (const edge of outgoing.get(stageId)) {
      if (!reachable.has(edge.toStageId)) {
        reachable.add(edge.toStageId);
        queue.push(edge.toStageId);
      }
    }
  }
  if (reachable.size !== stageIds.length) {
    reject('unreachable_stage', 'every stage must be reachable from root');
  }

  const indegree = new Map(stageIds.map((stageId) => [stageId, incoming.get(stageId).length]));
  const topology = topologicalOrder(stageIds, outgoing, indegree);
  if (topology.length !== stageIds.length) {
    reject('cycle_detected', 'graph must be acyclic');
  }

  const depth = new Map(stageIds.map((stageId) => [stageId, 0]));
  for (const stageId of topology) {
    for (const edge of outgoing.get(stageId)) {
      depth.set(edge.toStageId, Math.max(depth.get(edge.toStageId), depth.get(stageId) + 1));
    }
  }
  if (Math.max(...depth.values()) > LIMITS.maxDepth) {
    reject('depth_limit_exceeded', 'longest root path exceeds 8 edges');
  }

  const expectedDigest = manifestDigestFor(manifest);
  if (manifest.manifestDigest !== expectedDigest) {
    reject(
      'manifest_digest_mismatch',
      `manifest digest mismatch: expected ${expectedDigest}`,
    );
  }

  for (const edges of incoming.values()) edges.sort((a, b) => compareAscii(edgeTuple(a), edgeTuple(b)));
  for (const edges of outgoing.values()) edges.sort((a, b) => compareAscii(edgeTuple(a), edgeTuple(b)));
  return { root, stageById, incoming, outgoing, topology, depth };
}

function validateRequest(request, manifest, graph) {
  assertClosed(
    request,
    ['kind', 'manifestAlias', 'manifestDigest', 'outcomes', 'version'],
    'WavePlanDagDryRunRequestV2',
    'outcome_set_malformed',
  );
  if (request.kind !== 'WavePlanDagDryRunRequestV2' || request.version !== 2) {
    reject('outcome_set_malformed', 'dry-run request kind/version mismatch');
  }
  assertPattern(request.manifestAlias, PLAN_ALIAS_PATTERN, 'request manifestAlias', 'outcome_set_malformed');
  assertPattern(request.manifestDigest, DIGEST_PATTERN, 'request manifestDigest', 'outcome_set_malformed');
  if (request.manifestAlias !== manifest.manifestAlias
    || request.manifestDigest !== manifest.manifestDigest) {
    reject('manifest_digest_mismatch', 'dry-run request does not bind exact manifest');
  }
  if (!Array.isArray(request.outcomes) || request.outcomes.length > LIMITS.maxStages) {
    reject('outcome_set_malformed', 'outcome count outside 0..32');
  }
  const outcomes = new Map();
  for (const outcome of request.outcomes) {
    assertClosed(
      outcome,
      ['kind', 'outcome', 'stageId', 'version'],
      'WavePlanDagStageOutcomeV2',
      'outcome_set_malformed',
    );
    if (outcome.kind !== 'WavePlanDagStageOutcomeV2' || outcome.version !== 2) {
      reject('outcome_set_malformed', 'stage outcome kind/version mismatch');
    }
    assertPattern(outcome.stageId, STAGE_ID_PATTERN, 'outcome stageId', 'outcome_set_malformed');
    if (!graph.stageById.has(outcome.stageId)) {
      reject('outcome_set_malformed', 'outcome references unknown stage');
    }
    if (!['gate_passed', 'gate_failed'].includes(outcome.outcome)) {
      reject('unknown_outcome', 'unknown stage gate outcome');
    }
    if (outcomes.has(outcome.stageId)) {
      reject('outcome_set_malformed', 'duplicate stage outcome');
    }
    outcomes.set(outcome.stageId, outcome.outcome);
  }
  return outcomes;
}

function edgeMatches(edge, sourceReason) {
  return edge.when === 'any_terminal' || edge.when === sourceReason;
}

function baseStageSignal(stageId, graph, signals) {
  if (stageId === graph.root) return { stageId, state: 'ready', reason: 'root_stage' };

  let matching = 0;
  let unresolved = 0;
  for (const edge of graph.incoming.get(stageId)) {
    const source = signals.get(edge.fromStageId);
    if (source.state === 'terminal') {
      if (edgeMatches(edge, source.reason)) matching += 1;
    } else if (source.state !== 'not_selected') {
      unresolved += 1;
    }
  }

  const policy = graph.stageById.get(stageId).joinPolicy;
  if (policy === 'any_matching' && matching > 0) {
    return { stageId, state: 'ready', reason: 'any_matching_satisfied' };
  }
  if (unresolved > 0) {
    return { stageId, state: 'waiting', reason: 'join_unresolved' };
  }
  if (matching === 0) {
    return { stageId, state: 'not_selected', reason: 'no_matching_edge' };
  }
  return { stageId, state: 'ready', reason: 'all_matching_satisfied' };
}

function buildDryRunReceipt(manifest, request) {
  const graph = validateManifest(manifest);
  const outcomes = validateRequest(request, manifest, graph);
  const signals = new Map();

  for (const stageId of graph.topology) {
    let signal = baseStageSignal(stageId, graph, signals);
    if (outcomes.has(stageId)) {
      if (signal.state !== 'ready') {
        reject(
          'outcome_join_mismatch',
          `outcome supplied for ${stageId} while ${signal.state}`,
        );
      }
      signal = { stageId, state: 'terminal', reason: outcomes.get(stageId) };
    }
    signals.set(stageId, signal);
  }

  const receipt = {
    kind: 'WavePlanDagDryRunReceiptV2',
    version: 2,
    manifestAlias: manifest.manifestAlias,
    manifestDigest: manifest.manifestDigest,
    mode: 'read_only_rehearsal',
    topologicalOrder: [...graph.topology],
    stages: graph.topology.map((stageId) => signals.get(stageId)),
    autoDispatch: false,
    operatorAdvanceRequired: true,
    dryRunRequired: true,
    executionAuthority: 'none',
    claimAuthority: 'none',
    retryAuthority: 'none',
    finalizerAuthority: 'none',
    successAuthority: 'none',
    liveAuthority: 'none',
    receiptDigestDomain: RECEIPT_DOMAIN,
  };
  return { ...receipt, receiptDigest: framedDigest(RECEIPT_DOMAIN, receipt) };
}

function validateReceipt(receipt, manifest, request) {
  assertClosed(receipt, RECEIPT_FIELDS, 'WavePlanDagDryRunReceiptV2');
  if (receipt.kind !== 'WavePlanDagDryRunReceiptV2'
    || receipt.version !== 2
    || receipt.mode !== 'read_only_rehearsal') {
    reject('manifest_malformed', 'receipt header mismatch');
  }
  if (receipt.manifestAlias !== manifest.manifestAlias
    || receipt.manifestDigest !== manifest.manifestDigest) {
    reject('manifest_digest_mismatch', 'receipt manifest binding mismatch');
  }
  if (receipt.receiptDigestDomain !== RECEIPT_DOMAIN) {
    reject('manifest_malformed', 'receipt digest domain mismatch');
  }
  assertPattern(receipt.receiptDigest, DIGEST_PATTERN, 'receiptDigest');
  assertAuthorityBoundary(receipt, 'receipt');

  const graph = validateManifest(manifest);
  if (!Array.isArray(receipt.topologicalOrder)
    || canonicalize(receipt.topologicalOrder) !== canonicalize(graph.topology)) {
    reject('manifest_malformed', 'receipt topological order mismatch');
  }
  if (!Array.isArray(receipt.stages) || receipt.stages.length !== graph.topology.length) {
    reject('manifest_malformed', 'receipt stage count mismatch');
  }

  const validStateReasons = new Set([
    'ready\0root_stage',
    'ready\0all_matching_satisfied',
    'ready\0any_matching_satisfied',
    'waiting\0join_unresolved',
    'not_selected\0no_matching_edge',
    'terminal\0gate_passed',
    'terminal\0gate_failed',
  ]);
  receipt.stages.forEach((signal, index) => {
    assertClosed(signal, ['reason', 'stageId', 'state'], 'WavePlanDagStageSignalV2');
    if (signal.stageId !== graph.topology[index]) {
      reject('manifest_malformed', 'receipt stages are not in topological order');
    }
    if (!validStateReasons.has(`${signal.state}\0${signal.reason}`)) {
      reject('manifest_malformed', 'invalid receipt state/reason combination');
    }
  });

  const expectedDigest = receiptDigestFor(receipt);
  if (receipt.receiptDigest !== expectedDigest) {
    reject(
      'manifest_digest_mismatch',
      `receipt digest mismatch: expected ${expectedDigest}`,
    );
  }
  assert.deepEqual(receipt, buildDryRunReceipt(manifest, request));
}

function expectReason(fn, reason, label) {
  assert.throws(
    fn,
    (error) => error instanceof ContractError && error.reason === reason,
    label,
  );
}

function stage(stageId, manifestAlias, digit, joinPolicy = 'all_matching') {
  return {
    stageId,
    manifestAlias,
    reviewedManifestDigest: `sha256:${digit.repeat(64)}`,
    joinPolicy,
  };
}

function minimalManifest(stages, edges) {
  const manifest = {
    kind: 'WavePlanDagManifestV2',
    version: 2,
    proposalSource: 'operator',
    manifestAlias: 'wpm_fedcba9876543210',
    stages,
    edges,
    limits: { ...LIMITS },
    autoDispatch: false,
    operatorAdvanceRequired: true,
    dryRunRequired: true,
    executionAuthority: 'none',
    claimAuthority: 'none',
    retryAuthority: 'none',
    finalizerAuthority: 'none',
    successAuthority: 'none',
    liveAuthority: 'none',
    manifestDigestDomain: MANIFEST_DOMAIN,
    manifestDigest: 'sha256:' + '0'.repeat(64),
  };
  return withManifestDigest(manifest);
}

function chainManifest(edgeCount) {
  const stages = Array.from({ length: edgeCount + 1 }, (_, index) => stage(
    `stg_${index.toString(16).padStart(8, '0')}`,
    `mft_${index.toString(16).padStart(16, '0')}`,
    ((index % 14) + 1).toString(16),
    index === 0 ? 'root' : 'all_matching',
  ));
  const edges = Array.from({ length: edgeCount }, (_, index) => ({
    fromStageId: stages[index].stageId,
    toStageId: stages[index + 1].stageId,
    when: 'any_terminal',
  }));
  return minimalManifest(stages, edges);
}

function fanOutManifest() {
  const stages = [
    stage('stg_00000000', 'mft_0000000000000000', '1', 'root'),
    ...Array.from({ length: 9 }, (_, index) => stage(
      `stg_${(index + 1).toString(16).padStart(8, '0')}`,
      `mft_${(index + 1).toString(16).padStart(16, '0')}`,
      ((index + 2) % 15).toString(16),
    )),
  ];
  return minimalManifest(stages, stages.slice(1).map((child) => ({
    fromStageId: stages[0].stageId,
    toStageId: child.stageId,
    when: 'any_terminal',
  })));
}

function fanInManifest() {
  const stages = Array.from({ length: 13 }, (_, index) => stage(
    `stg_${index.toString(16).padStart(8, '0')}`,
    `mft_${index.toString(16).padStart(16, '0')}`,
    ((index % 14) + 1).toString(16),
    index === 0 ? 'root' : 'all_matching',
  ));
  const edges = [
    { fromStageId: stages[0].stageId, toStageId: stages[1].stageId, when: 'any_terminal' },
    { fromStageId: stages[0].stageId, toStageId: stages[2].stageId, when: 'any_terminal' },
    ...stages.slice(3, 8).map((target) => ({
      fromStageId: stages[1].stageId,
      toStageId: target.stageId,
      when: 'any_terminal',
    })),
    ...stages.slice(8, 12).map((target) => ({
      fromStageId: stages[2].stageId,
      toStageId: target.stageId,
      when: 'any_terminal',
    })),
    ...stages.slice(3, 12).map((source) => ({
      fromStageId: source.stageId,
      toStageId: stages[12].stageId,
      when: 'any_terminal',
    })),
  ];
  return minimalManifest(stages, edges);
}

function validateFixtureSafety(value) {
  const prohibitedKeys = new Set([
    'workerId',
    'personId',
    'requesterId',
    'providerId',
    'modelId',
    'prompt',
    'payload',
    'path',
    'url',
    'timestamp',
    'labels',
    'metadata',
    'extensions',
    'command',
    'script',
    'code',
    'shell',
    'executable',
    'entrypoint',
    'arguments',
    'environment',
    'interpreter',
  ]);
  const forbiddenValues = [
    /(?:https?|file):\/\//i,
    /(?:^|[\s"'(])\/(?:home|Users|work|etc)\//,
    /\b[A-Za-z]:\\/,
    /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
    /\bghp_[A-Za-z0-9_]{20,}\b/,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  ];

  function visit(item) {
    if (Array.isArray(item)) {
      item.forEach(visit);
    } else if (item !== null && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) {
        assert.equal(prohibitedKeys.has(key), false, `fixture contains prohibited key ${key}`);
        visit(child);
      }
    } else if (typeof item === 'string') {
      for (const pattern of forbiddenValues) {
        assert.equal(pattern.test(item), false, `fixture contains prohibited value shape ${pattern}`);
      }
    }
  }
  visit(value);
}

function validateNoNetworkImports() {
  const source = readFileSync(THIS_PATH, 'utf8');
  const imports = [...source.matchAll(/^\s*import(?:[\s\S]*?\sfrom\s*)?['"]([^'"]+)['"];?$/gm)]
    .map((match) => match[1]);
  assert.ok(imports.length >= 1, 'checker import scan must find built-ins');
  for (const specifier of imports) {
    assert.match(specifier, /^node:/, `non-built-in import forbidden: ${specifier}`);
  }
  assert.doesNotMatch(source, /\bfetch\s*\(/, 'network fetch is forbidden');
  assert.doesNotMatch(source, /node:(?:http|https|net|tls|dns|dgram)\b/, 'network built-ins are forbidden');
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
assertClosed(
  fixture,
  ['dryRuns', 'fixtureKind', 'fixtureVersion', 'manifest'],
  'WavePlanDagV2Fixture',
);
assert.equal(fixture.fixtureKind, 'WavePlanDagV2Fixture');
assert.equal(fixture.fixtureVersion, 2);
assert.ok(Array.isArray(fixture.dryRuns));
assert.equal(fixture.dryRuns.length, 2);
fixture.dryRuns.forEach((vector) => {
  assertClosed(vector, ['receipt', 'request'], 'WavePlanDagV2 dry-run vector');
});

validateNoNetworkImports();
validateFixtureSafety(fixture);

const graph = validateManifest(fixture.manifest);
assert.equal(fixture.manifest.proposalSource, 'model');
assertAuthorityBoundary(fixture.manifest, 'model-proposed manifest');
assert.deepEqual(graph.topology, EXPECTED_TOPOLOGY);
assert.equal(fixture.manifest.manifestDigest, PINNED_MANIFEST_DIGEST);

// The fixture is intentionally unordered. Reversing both input arrays keeps
// the semantic digest and ASCII-tie-broken topological order exact.
const reorderedManifest = clone(fixture.manifest);
reorderedManifest.stages.reverse();
reorderedManifest.edges.reverse();
assert.equal(manifestDigestFor(reorderedManifest), fixture.manifest.manifestDigest);
assert.deepEqual(validateManifest(reorderedManifest).topology, EXPECTED_TOPOLOGY);

fixture.dryRuns.forEach((vector, index) => {
  validateReceipt(vector.receipt, fixture.manifest, vector.request);
  assert.equal(vector.receipt.receiptDigest, PINNED_RECEIPT_DIGESTS[index]);
  const reversedRequest = clone(vector.request);
  reversedRequest.outcomes.reverse();
  assert.deepEqual(
    buildDryRunReceipt(fixture.manifest, reversedRequest),
    vector.receipt,
    `outcome order independence for vector ${index}`,
  );
});

// A partial outcome set derived from the exact pass vector waits at the
// all-matching diamond, while any-matching is ready from one terminal source.
const partialRequest = clone(fixture.dryRuns[0].request);
partialRequest.outcomes = partialRequest.outcomes.filter((outcome) =>
  ['stg_00000000', 'stg_00000010'].includes(outcome.stageId));
const partialReceipt = buildDryRunReceipt(fixture.manifest, partialRequest);
const partialSignals = new Map(partialReceipt.stages.map((item) => [item.stageId, item]));
assert.deepEqual(
  partialSignals.get('stg_00000030'),
  { stageId: 'stg_00000030', state: 'waiting', reason: 'join_unresolved' },
);
assert.deepEqual(
  partialSignals.get('stg_00000035'),
  { stageId: 'stg_00000035', state: 'ready', reason: 'any_matching_satisfied' },
);

// Passed and failed gate vectors select exactly one branch.
const passSignals = new Map(fixture.dryRuns[0].receipt.stages.map((item) => [item.stageId, item]));
const failSignals = new Map(fixture.dryRuns[1].receipt.stages.map((item) => [item.stageId, item]));
assert.equal(passSignals.get('stg_00000050').state, 'ready');
assert.equal(passSignals.get('stg_00000060').state, 'not_selected');
assert.equal(failSignals.get('stg_00000050').state, 'not_selected');
assert.equal(failSignals.get('stg_00000060').state, 'ready');

// Structural rejection table keeps the checker focused without repeating
// fixture-sized literals.
const graphMutations = [
  ['duplicate_stage', 'duplicate_stage', (manifest) => {
    manifest.stages.push(clone(manifest.stages[0]));
  }],
  ['unknown_endpoint', 'unknown_endpoint', (manifest) => {
    manifest.edges[0].toStageId = 'stg_ffffffff';
  }],
  ['duplicate_edge', 'duplicate_edge', (manifest) => {
    manifest.edges.push(clone(manifest.edges[0]));
  }],
  ['self_edge', 'self_edge', (manifest) => {
    manifest.edges[0].toStageId = manifest.edges[0].fromStageId;
  }],
  ['multiple_root', 'root_count_invalid', (manifest) => {
    manifest.edges = manifest.edges.filter((edge) => !(
      edge.fromStageId === 'stg_00000000' && edge.toStageId === 'stg_00000020'
    ));
  }],
  ['cycle', 'cycle_detected', (manifest) => {
    manifest.edges.push({
      fromStageId: 'stg_00000060',
      toStageId: 'stg_00000030',
      when: 'any_terminal',
    });
  }],
];
for (const [label, reason, mutate] of graphMutations) {
  const candidate = clone(fixture.manifest);
  mutate(candidate);
  candidate.manifestDigest = manifestDigestFor(candidate);
  expectReason(() => validateManifest(candidate), reason, label);
}

const unreachable = clone(fixture.manifest);
unreachable.stages.push(
  stage('stg_00000070', 'mft_0000000000000070', '9'),
  stage('stg_00000080', 'mft_0000000000000080', 'a'),
);
unreachable.edges.push(
  { fromStageId: 'stg_00000070', toStageId: 'stg_00000080', when: 'any_terminal' },
  { fromStageId: 'stg_00000080', toStageId: 'stg_00000070', when: 'any_terminal' },
);
unreachable.manifestDigest = manifestDigestFor(unreachable);
expectReason(() => validateManifest(unreachable), 'unreachable_stage', 'unreachable component');

const oversizeStages = clone(fixture.manifest);
while (oversizeStages.stages.length <= LIMITS.maxStages) {
  const index = oversizeStages.stages.length;
  oversizeStages.stages.push(stage(
    `stg_${(0x100 + index).toString(16).padStart(8, '0')}`,
    `mft_${(0x100 + index).toString(16).padStart(16, '0')}`,
    ((index % 14) + 1).toString(16),
  ));
}
oversizeStages.manifestDigest = manifestDigestFor(oversizeStages);
expectReason(() => validateManifest(oversizeStages), 'stage_limit_exceeded', 'stage cap');

const oversizeEdges = clone(fixture.manifest);
while (oversizeEdges.edges.length <= LIMITS.maxEdges) {
  oversizeEdges.edges.push(clone(oversizeEdges.edges[0]));
}
oversizeEdges.manifestDigest = manifestDigestFor(oversizeEdges);
expectReason(() => validateManifest(oversizeEdges), 'edge_limit_exceeded', 'edge cap');
expectReason(() => validateManifest(chainManifest(9)), 'depth_limit_exceeded', 'depth cap');
expectReason(() => validateManifest(fanInManifest()), 'fan_in_limit_exceeded', 'fan-in cap');
expectReason(() => validateManifest(fanOutManifest()), 'fan_out_limit_exceeded', 'fan-out cap');

// Closed fields reject code/execution and private material at the manifest
// boundary. One iteration proves the same closed-object rule for each name.
for (const forbiddenField of [
  'workerId',
  'personId',
  'providerId',
  'prompt',
  'payload',
  'path',
  'url',
  'timestamp',
  'labels',
  'metadata',
  'extensions',
  'command',
  'script',
  'code',
  'shell',
  'executable',
]) {
  const candidate = { ...fixture.manifest, [forbiddenField]: 'forbidden' };
  expectReason(() => validateManifest(candidate), 'manifest_malformed', `forbidden ${forbiddenField}`);
}

const digestMismatch = clone(fixture.manifest);
digestMismatch.manifestDigest = `sha256:${'f'.repeat(64)}`;
expectReason(() => validateManifest(digestMismatch), 'manifest_digest_mismatch', 'digest mismatch');

const baseRequest = fixture.dryRuns[0].request;
const mismatchRequest = clone(partialRequest);
mismatchRequest.outcomes.push({
  kind: 'WavePlanDagStageOutcomeV2',
  version: 2,
  stageId: 'stg_00000030',
  outcome: 'gate_passed',
});
expectReason(
  () => buildDryRunReceipt(fixture.manifest, mismatchRequest),
  'outcome_join_mismatch',
  'outcome cannot skip unresolved all-matching join',
);

const malformedOutcomeCases = [
  ['duplicate outcome', (request) => request.outcomes.push(clone(request.outcomes[0])), 'outcome_set_malformed'],
  ['unknown stage', (request) => {
    request.outcomes[0].stageId = 'stg_ffffffff';
  }, 'outcome_set_malformed'],
  ['unknown outcome', (request) => {
    request.outcomes[0].outcome = 'completed';
  }, 'unknown_outcome'],
  ['private outcome field', (request) => {
    request.outcomes[0].payload = 'forbidden';
  }, 'outcome_set_malformed'],
];
for (const [label, mutate, reason] of malformedOutcomeCases) {
  const candidate = clone(baseRequest);
  mutate(candidate);
  expectReason(() => buildDryRunReceipt(fixture.manifest, candidate), reason, label);
}

const wrongRequestDigest = clone(baseRequest);
wrongRequestDigest.manifestDigest = `sha256:${'e'.repeat(64)}`;
expectReason(
  () => buildDryRunReceipt(fixture.manifest, wrongRequestDigest),
  'manifest_digest_mismatch',
  'request digest mismatch',
);

console.log(
  'wave-plan-dag-v2 conformance ok: closed DAG, deterministic joins/order/digests, read-only no-authority dry-run',
);
