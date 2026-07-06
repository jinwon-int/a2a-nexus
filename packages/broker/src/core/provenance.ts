import { createHash } from "node:crypto";

import {
  type AgentCardSignature,
  canonicalizeJson,
  signAgentCard,
  verifyAgentCardSignature,
} from "../a2a/agent-card-signing.js";

export const PROVENANCE_CANONICALIZATION = "rfc8785-jcs-v1" as const;
export const RESULT_PROVENANCE_SCHEMA = "a2a.result.provenance.v1" as const;
export const RETRIEVAL_SNAPSHOT_SCHEMA = "a2a.retrieval.snapshot.v1" as const;
export const UNTRUSTED_EXTERNAL_DATA_TAG = "untrusted_external_data" as const;
export const UNTRUSTED_EXTERNAL_DATA_TEXT_ENCODING = "xml-text-escaped" as const;
export const UNTRUSTED_EXTERNAL_DATA_METADATA_ENCODING = "base64url-json" as const;

export interface BrokerCounterSignature {
  brokerKeyId: string;
  verifiedAt: string;
  sig: AgentCardSignature;
}

export interface TaskResultProvenance {
  schemaVersion: typeof RESULT_PROVENANCE_SCHEMA;
  canonicalization: typeof PROVENANCE_CANONICALIZATION;
  alg: "EdDSA" | "ES256";
  workerKeyId: string;
  claimedAt: string;
  resultHash: string;
  workerSig: AgentCardSignature;
  brokerCountersig?: BrokerCounterSignature;
}

export type ResultWithProvenance = Record<string, unknown> & {
  provenance?: TaskResultProvenance;
};

interface WorkerResultProvenancePayload {
  schemaVersion: typeof RESULT_PROVENANCE_SCHEMA;
  canonicalization: typeof PROVENANCE_CANONICALIZATION;
  taskId: string;
  claimedAt: string;
  resultHash: string;
}

interface BrokerCounterSignaturePayload {
  schemaVersion: "a2a.result.provenance.broker-countersig.v1";
  canonicalization: typeof PROVENANCE_CANONICALIZATION;
  taskId: string;
  verifiedAt: string;
  workerSig: AgentCardSignature;
}

export interface RetrievalSnapshot {
  schemaVersion: typeof RETRIEVAL_SNAPSHOT_SCHEMA;
  canonicalization: typeof PROVENANCE_CANONICALIZATION;
  source: "github";
  repo: string;
  requestedRef: string;
  resolvedRef: string;
  path: string;
  fetchedAt: string;
  byteLen: number;
  contentHash: string;
  content: string;
  signature?: AgentCardSignature;
}

export interface RetrievalSourceCarrierFile {
  path: string;
  contentText: string;
  source: RetrievalSnapshot["source"];
  repo: string;
  requestedRef: string;
  resolvedRef: string;
  contentHash: string;
  fetchedAt: string;
  byteLen: number;
  untrustedExternalData: true;
}

export type ProvenanceVerificationResult =
  | { ok: true }
  | { ok: false; reason: string };

function sha256Prefix(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function decodeProtectedAlg(signature: AgentCardSignature): "EdDSA" | "ES256" {
  const header = JSON.parse(Buffer.from(signature.protected, "base64url").toString("utf8")) as { alg?: unknown };
  if (header.alg !== "EdDSA" && header.alg !== "ES256") {
    throw new Error(`unsupported provenance signature alg: ${String(header.alg)}`);
  }
  return header.alg;
}

function stripResultProvenance(result: Record<string, unknown>): Record<string, unknown> {
  const { provenance: _omit, ...rest } = result;
  return rest;
}

export function canonicalTaskResultWithoutProvenance(result: Record<string, unknown>): string {
  return canonicalizeJson(stripResultProvenance(result));
}

export function hashTaskResult(result: Record<string, unknown>): string {
  return sha256Prefix(canonicalTaskResultWithoutProvenance(result));
}

function workerResultProvenancePayload(params: {
  taskId: string;
  claimedAt: string;
  resultHash: string;
}): WorkerResultProvenancePayload {
  return {
    schemaVersion: RESULT_PROVENANCE_SCHEMA,
    canonicalization: PROVENANCE_CANONICALIZATION,
    taskId: params.taskId,
    claimedAt: params.claimedAt,
    resultHash: params.resultHash,
  };
}

export function signTaskResultProvenance(
  result: Record<string, unknown>,
  options: { taskId: string; claimedAt: string; privateKeyPem: string; workerKeyId: string },
): TaskResultProvenance {
  const resultHash = hashTaskResult(result);
  const payload = workerResultProvenancePayload({ taskId: options.taskId, claimedAt: options.claimedAt, resultHash });
  const signed = signAgentCard(payload as unknown as Record<string, unknown>, {
    privateKeyPem: options.privateKeyPem,
    kid: options.workerKeyId,
  });
  const workerSig = signed.signatures[0];
  if (!workerSig) throw new Error("worker provenance signing did not produce a signature");
  return {
    schemaVersion: RESULT_PROVENANCE_SCHEMA,
    canonicalization: PROVENANCE_CANONICALIZATION,
    alg: decodeProtectedAlg(workerSig),
    workerKeyId: options.workerKeyId,
    claimedAt: options.claimedAt,
    resultHash,
    workerSig,
  };
}

export function verifyTaskResultProvenance(
  result: Record<string, unknown>,
  options: { taskId: string; publicKeyPem: string },
): ProvenanceVerificationResult {
  const provenance = (result as ResultWithProvenance).provenance;
  if (!provenance) return { ok: false, reason: "missing provenance" };
  if (provenance.schemaVersion !== RESULT_PROVENANCE_SCHEMA) return { ok: false, reason: "unsupported provenance schema" };
  if (provenance.canonicalization !== PROVENANCE_CANONICALIZATION) return { ok: false, reason: "unsupported provenance canonicalization" };
  const actualHash = hashTaskResult(result);
  if (actualHash !== provenance.resultHash) return { ok: false, reason: "resultHash mismatch" };
  const payload = workerResultProvenancePayload({
    taskId: options.taskId,
    claimedAt: provenance.claimedAt,
    resultHash: provenance.resultHash,
  }) as unknown as Record<string, unknown> & { signatures?: AgentCardSignature[] };
  const ok = verifyAgentCardSignature({ ...payload, signatures: [provenance.workerSig] }, options.publicKeyPem);
  return ok ? { ok: true } : { ok: false, reason: "worker signature invalid" };
}

export function countersignTaskResultProvenance(
  provenance: TaskResultProvenance,
  options: { taskId: string; verifiedAt: string; privateKeyPem: string; brokerKeyId: string },
): TaskResultProvenance {
  const payload: BrokerCounterSignaturePayload = {
    schemaVersion: "a2a.result.provenance.broker-countersig.v1",
    canonicalization: PROVENANCE_CANONICALIZATION,
    taskId: options.taskId,
    verifiedAt: options.verifiedAt,
    workerSig: provenance.workerSig,
  };
  const signed = signAgentCard(payload as unknown as Record<string, unknown>, {
    privateKeyPem: options.privateKeyPem,
    kid: options.brokerKeyId,
  });
  const sig = signed.signatures[0];
  if (!sig) throw new Error("broker countersigning did not produce a signature");
  return {
    ...provenance,
    brokerCountersig: { brokerKeyId: options.brokerKeyId, verifiedAt: options.verifiedAt, sig },
  };
}

export function buildGithubRetrievalSnapshot(params: {
  repo: string;
  requestedRef: string;
  resolvedRef: string;
  path: string;
  fetchedAt: string;
  content: string;
}): RetrievalSnapshot {
  return {
    schemaVersion: RETRIEVAL_SNAPSHOT_SCHEMA,
    canonicalization: PROVENANCE_CANONICALIZATION,
    source: "github",
    repo: params.repo,
    requestedRef: params.requestedRef,
    resolvedRef: params.resolvedRef,
    path: params.path,
    fetchedAt: params.fetchedAt,
    byteLen: Buffer.byteLength(params.content, "utf8"),
    contentHash: sha256Prefix(params.content),
    content: params.content,
  };
}

function unsignedRetrievalSnapshot(snapshot: RetrievalSnapshot): Record<string, unknown> {
  const { signature: _omit, ...rest } = snapshot;
  return rest;
}

export function signRetrievalSnapshot(
  snapshot: RetrievalSnapshot,
  options: { privateKeyPem: string; keyId: string },
): RetrievalSnapshot {
  const signed = signAgentCard(unsignedRetrievalSnapshot(snapshot), {
    privateKeyPem: options.privateKeyPem,
    kid: options.keyId,
  });
  const signature = signed.signatures[0];
  if (!signature) throw new Error("retrieval snapshot signing did not produce a signature");
  return { ...snapshot, signature };
}

export function verifyRetrievalSnapshot(
  snapshot: RetrievalSnapshot,
  options: { publicKeyPem: string },
): ProvenanceVerificationResult {
  if (snapshot.schemaVersion !== RETRIEVAL_SNAPSHOT_SCHEMA) return { ok: false, reason: "unsupported retrieval schema" };
  if (snapshot.canonicalization !== PROVENANCE_CANONICALIZATION) return { ok: false, reason: "unsupported retrieval canonicalization" };
  if (snapshot.byteLen !== Buffer.byteLength(snapshot.content, "utf8")) return { ok: false, reason: "byteLen mismatch" };
  if (snapshot.contentHash !== sha256Prefix(snapshot.content)) return { ok: false, reason: "contentHash mismatch" };
  if (!snapshot.signature) return { ok: false, reason: "missing retrieval signature" };
  const ok = verifyAgentCardSignature({ ...unsignedRetrievalSnapshot(snapshot), signatures: [snapshot.signature] }, options.publicKeyPem);
  return ok ? { ok: true } : { ok: false, reason: "retrieval signature invalid" };
}

function delimiterSafeMetadata(metadata: Record<string, unknown>): string {
  return Buffer.from(canonicalizeJson(metadata), "utf8").toString("base64url");
}

function delimiterSafeExternalDataText(content: string): string {
  return content
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function retrievalSnapshotToSourceCarrier(snapshot: RetrievalSnapshot): RetrievalSourceCarrierFile {
  const metadata = {
    source: snapshot.source,
    repo: snapshot.repo,
    requestedRef: snapshot.requestedRef,
    resolvedRef: snapshot.resolvedRef,
    path: snapshot.path,
    fetchedAt: snapshot.fetchedAt,
    contentHash: snapshot.contentHash,
    byteLen: snapshot.byteLen,
  };
  const metadataText = delimiterSafeMetadata(metadata);
  const contentText = [
    `<${UNTRUSTED_EXTERNAL_DATA_TAG} metadataEncoding="${UNTRUSTED_EXTERNAL_DATA_METADATA_ENCODING}" metadata="${metadataText}" textEncoding="${UNTRUSTED_EXTERNAL_DATA_TEXT_ENCODING}">`,
    delimiterSafeExternalDataText(snapshot.content),
    `</${UNTRUSTED_EXTERNAL_DATA_TAG}>`,
  ].join("\n");
  return {
    path: snapshot.path,
    contentText,
    source: snapshot.source,
    repo: snapshot.repo,
    requestedRef: snapshot.requestedRef,
    resolvedRef: snapshot.resolvedRef,
    contentHash: snapshot.contentHash,
    fetchedAt: snapshot.fetchedAt,
    byteLen: snapshot.byteLen,
    untrustedExternalData: true,
  };
}
