import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { IncomingHttpHeaders } from "node:http";

import { stableJsonStringify } from "./execution-proof.js";

export const RETRIEVAL_SNAPSHOT_SCHEMA = "a2a.retrieval.snapshot.v1" as const;
export const RETRIEVAL_SNAPSHOT_CANONICALIZATION = "rfc8785-jcs-v1" as const;
export const DEFAULT_EGRESS_MAX_BYTES = 1_000_000;
export const DEFAULT_EGRESS_TIMEOUT_MS = 10_000;
export const DEFAULT_EGRESS_MAX_REDIRECTS = 3;
export const GITHUB_EGRESS_ALLOWED_HOSTS = ["api.github.com", "raw.githubusercontent.com"] as const;
const GITHUB_EGRESS_ALLOWED_HOST_SET = new Set<string>(GITHUB_EGRESS_ALLOWED_HOSTS);

export type EgressAllowlistErrorCode =
  | "invalid_url"
  | "unsupported_protocol"
  | "host_not_allowed"
  | "internal_host_denied"
  | "internal_ip_denied"
  | "dns_resolution_failed"
  | "redirect_missing_location"
  | "redirect_limit_exceeded"
  | "deadline_exceeded"
  | "response_too_large"
  | "request_failed"
  | "symbolic_ref_denied"
  | "github_repo_invalid"
  | "github_path_invalid"
  | "retrieval_signature_invalid";

export class EgressAllowlistError extends Error {
  readonly code: EgressAllowlistErrorCode;
  constructor(code: EgressAllowlistErrorCode, message: string) {
    super(message);
    this.name = "EgressAllowlistError";
    this.code = code;
  }
}

export interface EgressAllowlistConfig {
  /** Exact hostnames allowed for outbound reads. Empty/omitted means deny by default. */
  allowedHosts?: string[];
  /** Maximum response bytes read into the snapshot. */
  maxBytes?: number;
  /** Per-hop timeout in milliseconds. Each redirect hop gets its own socket timeout. */
  timeoutMs?: number;
  /**
   * Wall-clock ceiling for the whole fetch, DNS and every redirect hop
   * included. Defaults to `timeoutMs * (maxRedirects + 1)` — the worst case a
   * per-hop timeout alone permits, now actually enforced rather than implied.
   */
  totalTimeoutMs?: number;
  /** Maximum number of redirects; each redirect is revalidated against host/IP rules. */
  maxRedirects?: number;
}

export interface EgressResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface EgressHttpResponse {
  statusCode: number;
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>;
  body: Buffer;
  finalUrl: string;
  resolvedIp: string;
}

interface EgressHttpRequest {
  url: URL;
  resolvedIp: string;
  family: 4 | 6;
  timeoutMs: number;
  maxBytes: number;
}

export interface EgressAllowlistDeps {
  resolveHost?: (hostname: string) => Promise<EgressResolvedAddress[]>;
  request?: (request: EgressHttpRequest) => Promise<Omit<EgressHttpResponse, "finalUrl" | "resolvedIp">>;
  now?: () => Date;
}

export interface RetrievalSnapshotSignature {
  protected: string;
  signature: string;
}

export interface RetrievalSnapshot {
  schemaVersion: typeof RETRIEVAL_SNAPSHOT_SCHEMA;
  canonicalization: typeof RETRIEVAL_SNAPSHOT_CANONICALIZATION;
  source: "github";
  repo: string;
  requestedRef: string;
  resolvedRef: string;
  path: string;
  fetchedAt: string;
  byteLen: number;
  contentHash: string;
  content: string;
  signature?: RetrievalSnapshotSignature;
}

export interface GithubResolvedRefSnapshotRequest {
  repo: string;
  requestedRef: string;
  resolvedRef: string;
  path: string;
  signingKeyPem: string;
  keyId: string;
  egress: EgressAllowlistConfig;
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().replace(/\.$/, "").toLowerCase();
}

function allowedHostSet(hosts: string[] | undefined): Set<string> {
  return new Set((hosts ?? []).map(normalizeHostname).filter(Boolean));
}

export function isCommitSha(ref: string): boolean {
  return /^[0-9a-f]{40}$/i.test(ref);
}

function assertCommitSha(ref: string): void {
  if (!isCommitSha(ref)) {
    throw new EgressAllowlistError("symbolic_ref_denied", "resolvedRef must be a 40-character commit SHA; symbolic refs are denied");
  }
}

export function isDeniedInternalHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal");
}

function ipv4ToNumber(ip: string): number | undefined {
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
  return (((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!) >>> 0;
}

function ipv4InCidr(ip: string, base: string, bits: number): boolean {
  const value = ipv4ToNumber(ip);
  const baseValue = ipv4ToNumber(base);
  if (value === undefined || baseValue === undefined) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (baseValue & mask);
}

/**
 * The embedded IPv4 literal of an IPv6 address that carries one: the
 * `::ffff:a.b.c.d` mapped form, the deprecated `::a.b.c.d` compatible form,
 * and the `64:ff9b::a.b.c.d` NAT64 well-known prefix. Each reaches an IPv4
 * destination, so each must be judged by the IPv4 rules.
 */
function embeddedIpv4(ip: string): string | undefined {
  const lower = ip.toLowerCase();
  const match = /^(?:::ffff:|::|64:ff9b::)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  return match?.[1];
}

const DENIED_IPV4_CIDRS: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // RFC 1918 private
  ["100.64.0.0", 10], // RFC 6598 carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. cloud metadata at 169.254.169.254
  ["172.16.0.0", 12], // RFC 1918 private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.168.0.0", 16], // RFC 1918 private
  ["198.18.0.0", 15], // RFC 2544 benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, incl. 255.255.255.255 broadcast
];

export function isDeniedInternalIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return DENIED_IPV4_CIDRS.some(([base, bits]) => ipv4InCidr(address, base, bits));
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    const embedded = embeddedIpv4(lower);
    if (embedded) return isDeniedInternalIp(embedded);
    return (
      lower === "::" ||
      lower === "::1" ||
      lower.startsWith("fc") || // fc00::/7 unique local
      lower.startsWith("fd") ||
      // fe00::/8 covers fe80::/10 link-local and fec0::/10 site-local; no
      // global unicast (2000::/3) falls in it, so denying the whole block is
      // safe and leaves no gap between the two.
      lower.startsWith("fe") ||
      lower.startsWith("ff") // ff00::/8 multicast
    );
  }
  return false;
}

function unbracketIpLiteral(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function validateHostBeforeDns(url: URL, config: EgressAllowlistConfig): string {
  const host = normalizeHostname(url.hostname);
  const ipHost = unbracketIpLiteral(host);
  if (url.protocol !== "https:") {
    throw new EgressAllowlistError("unsupported_protocol", `unsupported protocol: ${url.protocol}`);
  }
  if (isDeniedInternalHostname(host)) {
    throw new EgressAllowlistError("internal_host_denied", `internal hostname denied: ${host}`);
  }
  if (isIP(ipHost) && isDeniedInternalIp(ipHost)) {
    throw new EgressAllowlistError("internal_ip_denied", `internal IP denied: ${host}`);
  }
  if (!GITHUB_EGRESS_ALLOWED_HOST_SET.has(host)) {
    throw new EgressAllowlistError("host_not_allowed", `egress host is outside the GitHub retrieval allowlist: ${host}`);
  }
  const allowed = allowedHostSet(config.allowedHosts);
  if (!allowed.has(host)) {
    throw new EgressAllowlistError("host_not_allowed", `host is not in the explicit egress allowlist: ${host}`);
  }
  return host;
}

async function defaultResolveHost(hostname: string): Promise<EgressResolvedAddress[]> {
  if (isIP(hostname)) return [{ address: hostname, family: isIP(hostname) as 4 | 6 }];
  const rows = await lookup(hostname, { all: true, verbatim: true });
  return rows.map((row) => ({ address: row.address, family: row.family as 4 | 6 }));
}

async function resolveAndPinHost(
  hostname: string,
  deps: EgressAllowlistDeps,
): Promise<EgressResolvedAddress> {
  let rows: EgressResolvedAddress[];
  try {
    rows = await (deps.resolveHost ?? defaultResolveHost)(hostname);
  } catch (error) {
    throw new EgressAllowlistError("dns_resolution_failed", `DNS resolution failed for ${hostname}: ${(error as Error).message}`);
  }
  if (rows.length === 0) throw new EgressAllowlistError("dns_resolution_failed", `DNS resolution returned no addresses for ${hostname}`);
  const internal = rows.find((row) => isDeniedInternalIp(row.address));
  if (internal) {
    throw new EgressAllowlistError("internal_ip_denied", `resolved IP for ${hostname} is internal and denied: ${internal.address}`);
  }
  return rows[0]!;
}

type PinnedLookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

export function createPinnedLookup(resolvedIp: string, family: 4 | 6) {
  return (_hostname: string, opts: unknown, cb?: unknown): void => {
    const callback = typeof opts === "function" ? opts : cb;
    if (typeof callback !== "function") return;
    const all = typeof opts === "object" && opts !== null && "all" in opts && (opts as { all?: boolean }).all === true;
    if (all) {
      (callback as PinnedLookupCallback)(null, [{ address: resolvedIp, family }]);
      return;
    }
    (callback as PinnedLookupCallback)(null, resolvedIp, family);
  };
}

async function defaultRequest({ url, resolvedIp, family, timeoutMs, maxBytes }: EgressHttpRequest): Promise<Omit<EgressHttpResponse, "finalUrl" | "resolvedIp">> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: { host: url.host, "user-agent": "a2a-docker-runner-egress-proxy/1" },
      timeout: timeoutMs,
      lookup: createPinnedLookup(resolvedIp, family),
    }, (res) => {
      // Refuse an over-cap body on its declared length instead of buffering up
      // to the cap first. A lying content-length is still caught below.
      const declared = Number(res.headers["content-length"]);
      if (Number.isFinite(declared) && declared > maxBytes) {
        req.destroy(new EgressAllowlistError("response_too_large", `response exceeded ${maxBytes} bytes`));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      res.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxBytes) {
          req.destroy(new EgressAllowlistError("response_too_large", `response exceeded ${maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("timeout", () => req.destroy(new EgressAllowlistError("request_failed", `request timed out after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.end();
  });
}

export async function fetchWithEgressAllowlist(
  urlInput: string,
  config: EgressAllowlistConfig,
  deps: EgressAllowlistDeps = {},
): Promise<EgressHttpResponse> {
  const maxBytes = Math.max(1, Math.floor(config.maxBytes ?? DEFAULT_EGRESS_MAX_BYTES));
  const timeoutMs = Math.max(1, Math.floor(config.timeoutMs ?? DEFAULT_EGRESS_TIMEOUT_MS));
  const maxRedirects = Math.max(0, Math.floor(config.maxRedirects ?? DEFAULT_EGRESS_MAX_REDIRECTS));
  const totalTimeoutMs = Math.max(
    1,
    Math.floor(config.totalTimeoutMs ?? timeoutMs * (maxRedirects + 1)),
  );
  const startedAt = Date.now();
  const remainingMs = (): number => totalTimeoutMs - (Date.now() - startedAt);
  let current: URL;
  try {
    current = new URL(urlInput);
  } catch {
    throw new EgressAllowlistError("invalid_url", "invalid egress URL");
  }

  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const host = validateHostBeforeDns(current, config);
    const pinned = await resolveAndPinHost(host, deps);
    // A per-hop timeout alone lets DNS plus a full redirect chain run for
    // (maxRedirects + 1) x timeoutMs; charge each hop against the shared
    // deadline so the caller's ceiling is the real one.
    const hopBudget = remainingMs();
    if (hopBudget <= 0) {
      throw new EgressAllowlistError("deadline_exceeded", `egress fetch exceeded its ${totalTimeoutMs}ms deadline`);
    }
    const response = await (deps.request ?? defaultRequest)({ url: current, resolvedIp: pinned.address, family: pinned.family, timeoutMs: Math.min(timeoutMs, hopBudget), maxBytes });
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      const location = Array.isArray(response.headers.location) ? response.headers.location[0] : response.headers.location;
      if (!location) throw new EgressAllowlistError("redirect_missing_location", "redirect response did not include a Location header");
      if (redirect === maxRedirects) throw new EgressAllowlistError("redirect_limit_exceeded", "egress redirect limit exceeded");
      current = new URL(location, current);
      continue;
    }
    return { ...response, finalUrl: current.toString(), resolvedIp: pinned.address };
  }
  throw new EgressAllowlistError("redirect_limit_exceeded", "egress redirect limit exceeded");
}

function sha256Prefix(content: string | Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function encodeGithubPath(path: string): string {
  if (!path || path.startsWith("/") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new EgressAllowlistError("github_path_invalid", "GitHub path must be relative and must not contain empty, . or .. segments");
  }
  return path.split("/").map(encodeURIComponent).join("/");
}

function assertGithubRepo(repo: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new EgressAllowlistError("github_repo_invalid", "GitHub repo must be an owner/name slug");
  }
}

export function buildGithubRawUrl(repo: string, resolvedRef: string, path: string): string {
  assertGithubRepo(repo);
  assertCommitSha(resolvedRef);
  return `https://raw.githubusercontent.com/${repo}/${resolvedRef}/${encodeGithubPath(path)}`;
}

export function buildGithubRetrievalSnapshot(params: {
  repo: string;
  requestedRef: string;
  resolvedRef: string;
  path: string;
  fetchedAt: string;
  content: string;
}): RetrievalSnapshot {
  assertCommitSha(params.resolvedRef);
  return {
    schemaVersion: RETRIEVAL_SNAPSHOT_SCHEMA,
    canonicalization: RETRIEVAL_SNAPSHOT_CANONICALIZATION,
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

function retrievalSnapshotSigningPayload(snapshot: RetrievalSnapshot): string {
  const { signature: _omit, ...rest } = snapshot;
  return stableJsonStringify(rest);
}

function algForPrivateKey(privateKeyPem: string): "EdDSA" | "ES256" {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType === "ed25519") return "EdDSA";
  if (key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1") return "ES256";
  throw new Error(`unsupported retrieval snapshot signing key type: ${key.asymmetricKeyType ?? "unknown"}`);
}

export function signRetrievalSnapshot(snapshot: RetrievalSnapshot, options: { privateKeyPem: string; keyId: string }): RetrievalSnapshot {
  assertCommitSha(snapshot.resolvedRef);
  const alg = algForPrivateKey(options.privateKeyPem);
  const key = createPrivateKey(options.privateKeyPem);
  const protectedHeader = Buffer.from(stableJsonStringify({ alg, kid: options.keyId, typ: "JOSE" })).toString("base64url");
  const payload = Buffer.from(retrievalSnapshotSigningPayload(snapshot)).toString("base64url");
  const signature = cryptoSign(
    alg === "ES256" ? "sha256" : null,
    Buffer.from(`${protectedHeader}.${payload}`, "utf8"),
    alg === "ES256" ? { key, dsaEncoding: "ieee-p1363" } : key,
  ).toString("base64url");
  return { ...snapshot, signature: { protected: protectedHeader, signature } };
}

export function verifyRetrievalSnapshot(snapshot: RetrievalSnapshot, options: { publicKeyPem: string }): { ok: true } | { ok: false; reason: string } {
  if (snapshot.schemaVersion !== RETRIEVAL_SNAPSHOT_SCHEMA) return { ok: false, reason: "unsupported retrieval schema" };
  if (snapshot.canonicalization !== RETRIEVAL_SNAPSHOT_CANONICALIZATION) return { ok: false, reason: "unsupported retrieval canonicalization" };
  if (!isCommitSha(snapshot.resolvedRef)) return { ok: false, reason: "resolvedRef must be a commit SHA" };
  if (snapshot.byteLen !== Buffer.byteLength(snapshot.content, "utf8")) return { ok: false, reason: "byteLen mismatch" };
  if (snapshot.contentHash !== sha256Prefix(snapshot.content)) return { ok: false, reason: "contentHash mismatch" };
  if (!snapshot.signature) return { ok: false, reason: "missing retrieval signature" };
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(snapshot.signature.protected, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "retrieval signature protected header invalid" };
  }
  const key = createPublicKey(options.publicKeyPem);
  const alg = key.asymmetricKeyType === "ed25519" ? "EdDSA" : key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1" ? "ES256" : undefined;
  if (!alg || header.alg !== alg) return { ok: false, reason: "retrieval signature algorithm mismatch" };
  const payload = Buffer.from(retrievalSnapshotSigningPayload(snapshot)).toString("base64url");
  const ok = cryptoVerify(
    alg === "ES256" ? "sha256" : null,
    Buffer.from(`${snapshot.signature.protected}.${payload}`, "utf8"),
    alg === "ES256" ? { key, dsaEncoding: "ieee-p1363" } : key,
    Buffer.from(snapshot.signature.signature, "base64url"),
  );
  return ok ? { ok: true } : { ok: false, reason: "retrieval signature invalid" };
}

export async function fetchGithubResolvedRefSnapshot(
  request: GithubResolvedRefSnapshotRequest,
  deps: EgressAllowlistDeps = {},
): Promise<RetrievalSnapshot> {
  const url = buildGithubRawUrl(request.repo, request.resolvedRef, request.path);
  const response = await fetchWithEgressAllowlist(url, request.egress, deps);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new EgressAllowlistError("request_failed", `GitHub raw fetch failed with HTTP ${response.statusCode}`);
  }
  const content = response.body.toString("utf8");
  const fetchedAt = (deps.now ?? (() => new Date()))().toISOString();
  return signRetrievalSnapshot(buildGithubRetrievalSnapshot({
    repo: request.repo,
    requestedRef: request.requestedRef,
    resolvedRef: request.resolvedRef,
    path: request.path,
    fetchedAt,
    content,
  }), { privateKeyPem: request.signingKeyPem, keyId: request.keyId });
}
