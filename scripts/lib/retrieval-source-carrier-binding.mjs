/**
 * Source-only K2 approval -> retrieval snapshot -> source carrier -> report
 * binding validator (#1374).
 *
 * This module performs offline conformance checks only. It does not fetch from
 * GitHub, enable an egress proxy, mutate network policy, deploy/restart a
 * runner/broker/worker, mutate DB/outbox/ACK/replay state, send to providers,
 * or move signing keys/secrets.
 */

import { validateRetrievalApprovalPacket, UNTRUSTED_EXTERNAL_DATA_TAG } from './retrieval-approval-contract.mjs';
import { verifyReport } from '../verify-analysis-report.mjs';

export const RETRIEVAL_SOURCE_CARRIER_SCHEMA = 'a2a.retrieval.sourceCarrier.v0';

const SECRET_LIKE = /(?:ghp_|github_pat_|xox[baprs]-|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._~+/-]{20,}|api[_-]?key\s*[:=])/i;

function isRecord(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function add(checks, ok, id, detail) {
  checks.push({ ok, id, ...(detail ? { detail } : {}) });
}

function redactSecretProbe(value, path = '$', checks = []) {
  if (typeof value === 'string') {
    if (SECRET_LIKE.test(value)) add(checks, false, 'raw-secret-forbidden', `${path} contains secret-like material`);
    return checks;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => redactSecretProbe(item, `${path}[${index}]`, checks));
    return checks;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) redactSecretProbe(item, `${path}.${key}`, checks);
  }
  return checks;
}

function indexByContentHash(items) {
  const out = new Map();
  for (const item of items) {
    if (isRecord(item) && typeof item.contentHash === 'string') out.set(item.contentHash, item);
  }
  return out;
}

function reportDeclaredSources(report) {
  return Array.isArray(report?.result?.output?.sources) ? report.result.output.sources.filter(isRecord) : [];
}

function verifyApproval(packet, checks, now) {
  const approval = validateRetrievalApprovalPacket(packet, { now });
  for (const finding of approval.findings) {
    add(checks, finding.ok, `approval:${finding.id}`, finding.detail);
  }
  return approval.valid;
}

function verifySourceCarrierShape(carrier, approvalPacket, checks) {
  if (!isRecord(carrier)) {
    add(checks, false, 'source-carrier-shape', 'sourceCarrier must be an object');
    return [];
  }
  add(checks, carrier.schemaVersion === RETRIEVAL_SOURCE_CARRIER_SCHEMA, 'source-carrier-schema', `schemaVersion must be ${RETRIEVAL_SOURCE_CARRIER_SCHEMA}`);
  add(checks, carrier.sourceOnly === true, 'source-carrier-source-only', 'sourceCarrier.sourceOnly must be true');
  add(checks, carrier.noLive === true, 'source-carrier-no-live', 'sourceCarrier.noLive must be true');
  add(checks, carrier.approvalRef === approvalPacket?.approval?.approvalRef, 'source-carrier-approval-ref', 'sourceCarrier.approvalRef must equal approval.approvalRef');
  add(checks, carrier.envelope === UNTRUSTED_EXTERNAL_DATA_TAG, 'source-carrier-untrusted-envelope', `sourceCarrier.envelope must be ${UNTRUSTED_EXTERNAL_DATA_TAG}`);
  add(checks, carrier.analysisNetworkAccess === false, 'source-carrier-no-analysis-network', 'analysisNetworkAccess must be false');
  add(checks, carrier.liveFetchPerformed === false, 'source-carrier-no-live-fetch', 'liveFetchPerformed must be false');
  add(checks, carrier.networkPolicyChanged === false, 'source-carrier-no-network-policy-change', 'networkPolicyChanged must be false');
  const items = Array.isArray(carrier.items) ? carrier.items : [];
  add(checks, items.length > 0, 'source-carrier-items-present', 'sourceCarrier.items must be non-empty');
  return items;
}

function verifyItemEnvelope(item, index, checks) {
  if (!isRecord(item)) {
    add(checks, false, `source-carrier-item[${index}]`, 'item must be an object');
    return;
  }
  add(checks, item.envelope === UNTRUSTED_EXTERNAL_DATA_TAG, `source-carrier-item[${index}]:envelope`, `item.envelope must be ${UNTRUSTED_EXTERNAL_DATA_TAG}`);
  add(checks, hasText(item.sourceId), `source-carrier-item[${index}]:source-id`, 'sourceId required');
  add(checks, hasText(item.contentHash), `source-carrier-item[${index}]:content-hash`, 'contentHash required');
  add(checks, Number.isInteger(item.byteLen) && item.byteLen >= 0, `source-carrier-item[${index}]:byte-len`, 'byteLen must be non-negative integer');
  const rendered = item.renderedText;
  add(checks, typeof rendered === 'string' && rendered.includes('<untrusted_external_data') && rendered.includes('</untrusted_external_data>'), `source-carrier-item[${index}]:rendered-envelope`, 'renderedText must wrap content in untrusted_external_data tags');
  add(checks, typeof rendered === 'string' && rendered.includes(String(item.contentHash)), `source-carrier-item[${index}]:rendered-content-hash`, 'renderedText must include contentHash citation');
  add(checks, typeof rendered !== 'string' || !rendered.includes('<trusted_data'), `source-carrier-item[${index}]:no-trusted-envelope`, 'trusted_data envelope is forbidden');
}

function verifyApprovalSnapshotScope(approvalPacket, snapshots, checks) {
  const req = approvalPacket?.retrievalRequest;
  const allowedPaths = new Set(Array.isArray(req?.paths) ? req.paths : []);
  for (const [index, snap] of snapshots.entries()) {
    if (!isRecord(snap)) {
      add(checks, false, `snapshot-scope[${index}]`, 'snapshot must be an object');
      continue;
    }
    add(checks, snap.source === req?.source, `snapshot-scope[${index}]:source`, 'snapshot.source must match approved source');
    add(checks, snap.repo === req?.repo, `snapshot-scope[${index}]:repo`, 'snapshot.repo must match approved repo');
    add(checks, snap.requestedRef === req?.ref, `snapshot-scope[${index}]:requested-ref`, 'snapshot.requestedRef must match approved SHA ref');
    add(checks, snap.resolvedRef === req?.resolvedRef, `snapshot-scope[${index}]:resolved-ref`, 'snapshot.resolvedRef must match approved resolvedRef');
    add(checks, allowedPaths.has(snap.path), `snapshot-scope[${index}]:path`, 'snapshot.path must be in approved path allowlist');
  }
}

function verifyCarrierSnapshotReportBinding(carrierItems, report, checks) {
  const snapshots = Array.isArray(report?.sources) ? report.sources : [];
  const declared = reportDeclaredSources(report);
  const itemByHash = indexByContentHash(carrierItems);
  const snapByHash = indexByContentHash(snapshots);
  const declaredByHash = indexByContentHash(declared);

  for (const [index, item] of carrierItems.entries()) {
    if (!isRecord(item)) continue;
    const snap = snapByHash.get(item.contentHash);
    const decl = declaredByHash.get(item.contentHash);
    add(checks, Boolean(snap), `carrier-binding[${index}]:snapshot-present`, 'carrier item contentHash must have matching report.sources snapshot');
    add(checks, Boolean(decl), `carrier-binding[${index}]:report-declaration-present`, 'carrier item contentHash must be declared by result.output.sources');
    if (snap) {
      add(checks, snap.byteLen === item.byteLen, `carrier-binding[${index}]:byte-len`, 'carrier byteLen must match snapshot byteLen');
      add(checks, snap.repo === item.repo, `carrier-binding[${index}]:repo`, 'carrier repo must match snapshot repo');
      add(checks, snap.requestedRef === item.requestedRef, `carrier-binding[${index}]:requested-ref`, 'carrier requestedRef must match snapshot requestedRef');
      add(checks, snap.resolvedRef === item.resolvedRef, `carrier-binding[${index}]:resolved-ref`, 'carrier resolvedRef must match snapshot resolvedRef');
      add(checks, snap.path === item.path, `carrier-binding[${index}]:path`, 'carrier path must match snapshot path');
    }
    if (decl) {
      add(checks, decl.sourceId === item.sourceId, `carrier-binding[${index}]:source-id`, 'result.output.sources sourceId must match carrier sourceId');
    }
  }

  for (const [index, snap] of snapshots.entries()) {
    if (!isRecord(snap)) continue;
    add(checks, itemByHash.has(snap.contentHash), `report-snapshot[${index}]:carrier-present`, 'every report snapshot must be projected into sourceCarrier.items');
  }
  for (const [index, decl] of declared.entries()) {
    if (!isRecord(decl)) continue;
    add(checks, itemByHash.has(decl.contentHash), `report-declaration[${index}]:carrier-present`, 'every result.output.sources declaration must be projected into sourceCarrier.items');
  }
}

export function verifyRetrievalSourceCarrierBundle(bundle, options = {}) {
  const checks = [];
  if (!isRecord(bundle)) {
    return { green: false, checks: [{ ok: false, id: 'bundle-shape', detail: 'bundle must be an object' }] };
  }
  const approvalPacket = bundle.approvalPacket;
  const sourceCarrier = bundle.sourceCarrier;
  const report = bundle.report;
  const keyring = bundle.keyring;

  verifyApproval(approvalPacket, checks, options.now);
  const carrierItems = verifySourceCarrierShape(sourceCarrier, approvalPacket, checks);
  carrierItems.forEach((item, index) => verifyItemEnvelope(item, index, checks));

  const reportResult = verifyReport(report, keyring);
  for (const check of reportResult.checks) add(checks, check.ok, `report:${check.id}`, check.detail);

  const snapshots = Array.isArray(report?.sources) ? report.sources : [];
  verifyApprovalSnapshotScope(approvalPacket, snapshots, checks);
  verifyCarrierSnapshotReportBinding(carrierItems, report, checks);
  for (const finding of redactSecretProbe({ sourceCarrier, report })) checks.push(finding);

  return { green: checks.every((check) => check.ok === true), checks };
}
