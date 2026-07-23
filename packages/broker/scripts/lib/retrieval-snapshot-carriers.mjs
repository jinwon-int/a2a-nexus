import { createHash } from "node:crypto";

import { retrievalSnapshotToSourceCarrier } from "a2a-attestation";

export const DEFAULT_RETRIEVAL_SNAPSHOT_MAX_BYTES = 1_000_000;

function safeText(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function toArray(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object" && !Array.isArray(item)) : [];
}

function sha256Prefix(text) {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function snapshotIdentityPayload(snapshot) {
  return JSON.stringify({
    path: safeText(snapshot?.path, "unknown-path"),
    repo: safeText(snapshot?.repo, "unknown-repo"),
    resolvedRef: safeText(snapshot?.resolvedRef, safeText(snapshot?.requestedRef, "unknown-ref")),
    source: safeText(snapshot?.source, "source"),
  });
}

export function sourceIdForRetrievalSnapshot(snapshot) {
  return `github-retrieval:${sha256Prefix(snapshotIdentityPayload(snapshot))}`;
}

function snapshotByteCap(payload, env = process.env) {
  const candidates = [
    payload?.retrievalSnapshotMaxBytes,
    payload?.sourceSnapshotMaxBytes,
    payload?.source_snapshot_max_bytes,
    env.A2A_ANALYSIS_RETRIEVAL_SNAPSHOT_MAX_BYTES,
    env.A2A_RETRIEVAL_SNAPSHOT_MAX_BYTES,
  ];
  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_RETRIEVAL_SNAPSHOT_MAX_BYTES;
}

function collectRetrievalSnapshots(payload) {
  return [
    ...toArray(payload?.retrievalSnapshots),
    ...toArray(payload?.signedRetrievalSnapshots),
  ];
}

function hasSignature(snapshot) {
  return Boolean(
    snapshot?.signature &&
      typeof snapshot.signature === "object" &&
      !Array.isArray(snapshot.signature) &&
      typeof snapshot.signature.protected === "string" &&
      typeof snapshot.signature.signature === "string" &&
      snapshot.signature.protected.trim() &&
      snapshot.signature.signature.trim(),
  );
}

function validateRetrievalSnapshot(snapshot, { index, maxBytes }) {
  const label = `retrievalSnapshots[${index}]`;
  if (snapshot.schemaVersion !== "a2a.retrieval.snapshot.v1") {
    throw new Error(`${label} has unsupported schemaVersion`);
  }
  if (snapshot.canonicalization !== "rfc8785-jcs-v1") {
    throw new Error(`${label} has unsupported canonicalization`);
  }
  if (snapshot.source !== "github") {
    throw new Error(`${label} has unsupported source`);
  }
  if (!safeText(snapshot.repo) || !safeText(snapshot.resolvedRef) || !safeText(snapshot.path)) {
    throw new Error(`${label} missing repo/resolvedRef/path`);
  }
  if (typeof snapshot.content !== "string") {
    throw new Error(`${label} missing content`);
  }
  if (!hasSignature(snapshot)) {
    throw new Error(`${label} missing signed snapshot signature`);
  }
  const actualBytes = Buffer.byteLength(snapshot.content, "utf8");
  if (snapshot.byteLen !== actualBytes) {
    throw new Error(`${label} byteLen mismatch`);
  }
  if (actualBytes > maxBytes) {
    throw new Error(`${label} exceeds retrieval snapshot byte cap: ${actualBytes} > ${maxBytes}`);
  }
  if (snapshot.contentHash !== sha256Prefix(snapshot.content)) {
    throw new Error(`${label} contentHash mismatch`);
  }
}

export function snapshotSourceDeclarations(payload, env = process.env) {
  const snapshots = collectRetrievalSnapshots(payload);
  if (!snapshots.length) return [];
  const maxBytes = snapshotByteCap(payload, env);
  const seen = new Set();
  return snapshots.map((snapshot, index) => {
    validateRetrievalSnapshot(snapshot, { index, maxBytes });
    const sourceId = sourceIdForRetrievalSnapshot(snapshot);
    if (seen.has(sourceId)) {
      throw new Error(`duplicate retrieval snapshot source declaration: ${sourceId}`);
    }
    seen.add(sourceId);
    return {
      sourceId,
      contentHash: snapshot.contentHash,
    };
  });
}

export function payloadWithRetrievalSnapshotSourceCarriers(payload, env = process.env) {
  const snapshots = collectRetrievalSnapshots(payload);
  if (!snapshots.length) return { payload, sources: [] };
  const maxBytes = snapshotByteCap(payload, env);
  const seen = new Set();
  const files = snapshots.map((snapshot, index) => {
    validateRetrievalSnapshot(snapshot, { index, maxBytes });
    const sourceId = sourceIdForRetrievalSnapshot(snapshot);
    if (seen.has(sourceId)) {
      throw new Error(`duplicate retrieval snapshot source declaration: ${sourceId}`);
    }
    seen.add(sourceId);
    return retrievalSnapshotToSourceCarrier(snapshot);
  });
  const sourceBundle = payload?.sourceBundle && typeof payload.sourceBundle === "object" && !Array.isArray(payload.sourceBundle)
    ? payload.sourceBundle
    : {};
  const existingFiles = Array.isArray(sourceBundle.files) ? sourceBundle.files : [];
  return {
    payload: {
      ...payload,
      sourceBundle: {
        ...sourceBundle,
        files: [...existingFiles, ...files],
      },
    },
    sources: snapshots.map((snapshot) => ({
      sourceId: sourceIdForRetrievalSnapshot(snapshot),
      contentHash: snapshot.contentHash,
    })),
  };
}
