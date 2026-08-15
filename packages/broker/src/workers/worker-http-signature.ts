/**
 * Worker HTTP Signature (Ed25519) (#1601 churn-relief slice 5).
 *
 * Extracted verbatim from worker.ts: the worker HTTP Signature cluster —
 * HTTP_SIGNATURE_PARAM_VALUE_RE, WorkerA2AHttpSignatureConfig,
 * signA2AWorkerRequest, assertSafeHttpSignatureParamValue, parseBrokerIdEnv,
 * parseWorkerHttpSignatureConfig, validateWorkerPrivateJwk. worker.ts imports
 * them back one-way; only the required `export` keywords differ.
 */
import { createHash, createPrivateKey, randomUUID, sign } from "node:crypto";
import { buildA2AHttpSignatureBase } from "../core/request-security.js";
import { optionalTrimmed } from "./worker-metadata.js";

const HTTP_SIGNATURE_PARAM_VALUE_RE = /^[A-Za-z0-9._~:/@-]{1,256}$/;

export interface WorkerA2AHttpSignatureConfig {
  keyid: string;
  privateKeyJwk: Record<string, unknown>;
  brokerId: string;
  expiresAfterSec?: number;
  nowEpochSeconds?: () => number;
  nonceFactory?: () => string;
}

export function signA2AWorkerRequest(options: {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
  config: WorkerA2AHttpSignatureConfig;
}): void {
  const keyid = options.config.keyid.trim();
  const brokerId = options.config.brokerId.trim();
  if (!keyid) {
    throw new Error("A2A HTTP Signature worker key id is required");
  }
  if (!brokerId) {
    throw new Error("A2A HTTP Signature broker id is required");
  }
  assertSafeHttpSignatureParamValue(keyid, "A2A HTTP Signature worker key id");

  options.headers.set("content-digest", `sha-256=:${createHash("sha256").update(options.body).digest("base64")}:`);
  options.headers.set("x-a2a-broker-id", brokerId);

  const now = Math.trunc(options.config.nowEpochSeconds?.() ?? Date.now() / 1000);
  const expiresAfterSec = Math.max(1, Math.trunc(options.config.expiresAfterSec ?? 60));
  const nonce = options.config.nonceFactory?.() ?? randomUUID();
  assertSafeHttpSignatureParamValue(nonce, "A2A HTTP Signature nonce");
  const signatureInput = `a2a=("@method" "@authority" "@path" "@query" "content-digest" "x-a2a-requester-id" "x-a2a-requester-role" "x-a2a-broker-id");alg="ed25519";keyid="${keyid}";created=${now};expires=${now + expiresAfterSec};nonce="${nonce}";tag="a2a-worker-v1"`;
  options.headers.set("signature-input", signatureInput);

  const headers = Object.fromEntries([...options.headers.entries()]);
  const signatureBase = buildA2AHttpSignatureBase({
    method: options.method,
    authority: options.url.host,
    path: options.url.pathname,
    query: options.url.search.length > 0 ? options.url.search.slice(1) : "",
    headers,
    signatureInput,
  });
  const privateKey = createPrivateKey({ key: options.config.privateKeyJwk, format: "jwk" });
  const signatureValue = sign(null, Buffer.from(signatureBase), privateKey).toString("base64");
  options.headers.set("signature", `a2a=:${signatureValue}:`);
}

export function assertSafeHttpSignatureParamValue(value: string, label: string): void {
  if (!HTTP_SIGNATURE_PARAM_VALUE_RE.test(value)) {
    throw new Error(`${label} contains characters that are not safe for Signature-Input parameters`);
  }
}

export function parseBrokerIdEnv(value: string | undefined, label: string): string | undefined {
  const normalized = optionalTrimmed(value);
  if (!normalized) {
    return undefined;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) {
    throw new Error(`${label} must use only letters, numbers, dots, underscores, colons, or hyphens`);
  }
  return normalized;
}


export function parseWorkerHttpSignatureConfig(env: NodeJS.ProcessEnv): WorkerA2AHttpSignatureConfig | undefined {
  const keyid = optionalTrimmed(env.A2A_HTTP_SIGNATURE_WORKER_KEY_ID)
    ?? optionalTrimmed(env.WORKER_HTTP_SIGNATURE_KEY_ID);
  const privateKeyJwkRaw = optionalTrimmed(env.A2A_HTTP_SIGNATURE_WORKER_PRIVATE_KEY_JWK)
    ?? optionalTrimmed(env.WORKER_HTTP_SIGNATURE_PRIVATE_KEY_JWK);
  const brokerId = parseBrokerIdEnv(
    optionalTrimmed(env.A2A_HTTP_SIGNATURE_BROKER_ID) ?? optionalTrimmed(env.WORKER_HTTP_SIGNATURE_BROKER_ID),
    "A2A_HTTP_SIGNATURE_BROKER_ID",
  );

  if (!keyid && !privateKeyJwkRaw && !brokerId) {
    return undefined;
  }
  if (!keyid) {
    throw new Error("A2A_HTTP_SIGNATURE_WORKER_KEY_ID is required when worker HTTP Signature is configured");
  }
  if (!privateKeyJwkRaw) {
    throw new Error("A2A_HTTP_SIGNATURE_WORKER_PRIVATE_KEY_JWK is required when worker HTTP Signature is configured");
  }
  if (!brokerId) {
    throw new Error("A2A_HTTP_SIGNATURE_BROKER_ID is required when worker HTTP Signature is configured");
  }
  assertSafeHttpSignatureParamValue(keyid, "A2A_HTTP_SIGNATURE_WORKER_KEY_ID");

  let privateKeyJwk: unknown;
  try {
    privateKeyJwk = JSON.parse(privateKeyJwkRaw);
  } catch (error) {
    throw new Error(
      `A2A_HTTP_SIGNATURE_WORKER_PRIVATE_KEY_JWK must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  validateWorkerPrivateJwk(privateKeyJwk);

  return {
    keyid,
    privateKeyJwk: privateKeyJwk as Record<string, unknown>,
    brokerId,
  };
}

export function validateWorkerPrivateJwk(input: unknown): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("A2A_HTTP_SIGNATURE_WORKER_PRIVATE_KEY_JWK must be a JSON object");
  }
  const jwk = input as Record<string, unknown>;
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string" || typeof jwk.d !== "string") {
    throw new Error("A2A_HTTP_SIGNATURE_WORKER_PRIVATE_KEY_JWK must be an Ed25519 private JWK");
  }
  try {
    createPrivateKey({ key: jwk, format: "jwk" });
  } catch (error) {
    throw new Error(
      `A2A_HTTP_SIGNATURE_WORKER_PRIVATE_KEY_JWK is invalid: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
