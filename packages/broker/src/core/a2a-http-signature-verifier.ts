import { createPublicKey, verify, type JsonWebKey as NodeJsonWebKey } from "node:crypto";

const REQUIRED_COMPONENTS = [
  "@method",
  "@authority",
  "@path",
  "@query",
  "content-digest",
  "x-a2a-requester-id",
  "x-a2a-requester-role",
  "x-a2a-broker-id",
] as const;

export type A2AHttpSignatureFailureCode =
  | "missing_signature"
  | "malformed_signature_input"
  | "malformed_signature"
  | "unsupported_alg"
  | "unsupported_tag"
  | "unknown_key"
  | "identity_mismatch"
  | "time_invalid"
  | "component_mismatch"
  | "signature_invalid";

export interface A2AWorkerKeyRecord {
  keyid: string;
  workerId: string;
  requesterId: string;
  alg: "ed25519";
  publicKeyJwk: NodeJsonWebKey;
  status?: "active" | "revoked" | "disabled";
}

export interface A2AHttpSignatureRequest {
  method: string;
  authority: string;
  path: string;
  query: string;
  headers: Record<string, string | undefined>;
  signatureInput: string | undefined;
  signature: string | undefined;
  keyRegistry: readonly A2AWorkerKeyRecord[];
  expectedWorkerId?: string;
  expectedRequesterId?: string;
  nowEpochSeconds?: number;
  clockSkewSeconds?: number;
}

export type A2AHttpSignatureVerificationResult =
  | {
      ok: true;
      keyid: string;
      workerId: string;
      requesterId: string;
      created: number;
      expires: number;
      nonce: string;
    }
  | {
      ok: false;
      code: A2AHttpSignatureFailureCode;
    };

interface ParsedSignatureInput {
  label: string;
  components: string[];
  alg: string;
  keyid: string;
  created: number;
  expires: number;
  nonce: string;
  tag: string;
  signatureParams: string;
}

export function verifyA2AHttpSignature(
  request: A2AHttpSignatureRequest,
): A2AHttpSignatureVerificationResult {
  if (!request.signatureInput || !request.signature) {
    return { ok: false, code: "missing_signature" };
  }

  const parsed = parseSignatureInput(request.signatureInput);
  if (!parsed) {
    return { ok: false, code: "malformed_signature_input" };
  }
  if (!sameComponents(parsed.components, [...REQUIRED_COMPONENTS])) {
    return { ok: false, code: "component_mismatch" };
  }
  if (parsed.alg !== "ed25519") {
    return { ok: false, code: "unsupported_alg" };
  }
  if (parsed.tag !== "a2a-worker-v1") {
    return { ok: false, code: "unsupported_tag" };
  }

  const signatureBytes = parseSignatureHeader(request.signature, parsed.label);
  if (!signatureBytes) {
    return { ok: false, code: "malformed_signature" };
  }

  const key = request.keyRegistry.find((record) => record.keyid === parsed.keyid && record.status !== "revoked" && record.status !== "disabled");
  if (!key) {
    return { ok: false, code: "unknown_key" };
  }

  const requesterId = getHeader(request.headers, "x-a2a-requester-id");
  if (
    key.alg !== "ed25519" ||
    key.workerId !== key.requesterId ||
    requesterId !== key.requesterId ||
    (request.expectedWorkerId && key.workerId !== request.expectedWorkerId) ||
    (request.expectedRequesterId && key.requesterId !== request.expectedRequesterId)
  ) {
    return { ok: false, code: "identity_mismatch" };
  }

  const now = request.nowEpochSeconds ?? Math.floor(Date.now() / 1000);
  const skew = request.clockSkewSeconds ?? 60;
  if (!Number.isFinite(parsed.created) || !Number.isFinite(parsed.expires) || parsed.created > now + skew || parsed.expires < now - skew || parsed.expires <= parsed.created) {
    return { ok: false, code: "time_invalid" };
  }

  let signingBase: string;
  try {
    signingBase = buildA2AHttpSignatureBase(request);
  } catch {
    return { ok: false, code: "component_mismatch" };
  }

  try {
    const publicKey = createPublicKey({ key: key.publicKeyJwk, format: "jwk" });
    const valid = verify(null, Buffer.from(signingBase), publicKey, signatureBytes);
    if (!valid) {
      return { ok: false, code: "signature_invalid" };
    }
  } catch {
    return { ok: false, code: "signature_invalid" };
  }

  return {
    ok: true,
    keyid: parsed.keyid,
    workerId: key.workerId,
    requesterId: key.requesterId,
    created: parsed.created,
    expires: parsed.expires,
    nonce: parsed.nonce,
  };
}

export function buildA2AHttpSignatureBase(request: A2AHttpSignatureRequest): string {
  const parsed = parseSignatureInput(request.signatureInput);
  if (!parsed) {
    throw new Error("malformed Signature-Input");
  }

  const lines = parsed.components.map((component) => {
    const value = coveredComponentValue(request, component);
    if (value === undefined) {
      throw new Error(`missing covered component ${component}`);
    }
    return `"${component}": ${value}`;
  });
  lines.push(`"@signature-params": ${parsed.signatureParams}`);
  return lines.join("\n");
}

function coveredComponentValue(request: A2AHttpSignatureRequest, component: string): string | undefined {
  switch (component) {
    case "@method":
      return request.method.toUpperCase();
    case "@authority":
      return request.authority;
    case "@path":
      return request.path;
    case "@query":
      return request.query ? `?${request.query.replace(/^\?/, "")}` : "?";
    case "content-digest":
    case "x-a2a-requester-id":
    case "x-a2a-requester-role":
    case "x-a2a-broker-id":
      return getHeader(request.headers, component);
    default:
      return undefined;
  }
}

function parseSignatureInput(raw: string | undefined): ParsedSignatureInput | null {
  if (!raw) return null;
  const match = raw.match(/^([A-Za-z][A-Za-z0-9_-]*)=\(([^)]*)\)(.*)$/);
  if (!match) return null;
  const [, label, componentBlock, paramsBlock] = match;
  if (!label || label !== "a2a" || !componentBlock || !paramsBlock) return null;

  const components = [...componentBlock.matchAll(/"([^"]+)"/g)].map((item) => item[1]).filter((item): item is string => Boolean(item));
  if (components.length === 0 || components.join(" ") !== componentBlock.trim().replace(/"/g, "")) {
    return null;
  }

  const params = new Map<string, string>();
  for (const part of paramsBlock.split(";").slice(1)) {
    const param = part.trim();
    if (!param) return null;
    const eq = param.indexOf("=");
    if (eq <= 0) return null;
    const name = param.slice(0, eq);
    const value = param.slice(eq + 1);
    if (params.has(name)) return null;
    params.set(name, unquoteParam(value));
  }

  const alg = params.get("alg");
  const keyid = params.get("keyid");
  const createdRaw = params.get("created");
  const expiresRaw = params.get("expires");
  const nonce = params.get("nonce");
  const tag = params.get("tag");
  if (!alg || !keyid || !createdRaw || !expiresRaw || !nonce || !tag) return null;
  if (!/^\d+$/.test(createdRaw) || !/^\d+$/.test(expiresRaw)) return null;

  return {
    label,
    components,
    alg,
    keyid,
    created: Number(createdRaw),
    expires: Number(expiresRaw),
    nonce,
    tag,
    signatureParams: `(${components.map((component) => `"${component}"`).join(" ")});alg="${alg}";keyid="${keyid}";created=${createdRaw};expires=${expiresRaw};nonce="${nonce}";tag="${tag}"`,
  };
}

function unquoteParam(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

function parseSignatureHeader(raw: string, expectedLabel: string): Buffer | null {
  const match = raw.match(/^([A-Za-z][A-Za-z0-9_-]*)=:([A-Za-z0-9+/]+={0,2}):$/);
  if (!match || match[1] !== expectedLabel) return null;
  const encoded = match[2];
  if (!encoded || encoded.length % 4 === 1) return null;
  try {
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.length === 0 || decoded.toString("base64") !== encoded) return null;
    return decoded;
  } catch {
    return null;
  }
}

function getHeader(headers: Record<string, string | undefined>, name: string): string | undefined {
  const direct = headers[name];
  if (direct !== undefined) return direct;
  const lower = name.toLowerCase();
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === lower);
  return found?.[1];
}

function sameComponents(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && actual.every((component, index) => component === expected[index]);
}
