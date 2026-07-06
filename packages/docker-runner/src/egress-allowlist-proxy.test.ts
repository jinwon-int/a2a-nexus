import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  EgressAllowlistError,
  fetchGithubResolvedRefSnapshot,
  fetchWithEgressAllowlist,
  verifyRetrievalSnapshot,
  type EgressAllowlistDeps,
  type EgressHttpResponse,
  type RetrievalSnapshot,
} from "./egress-allowlist-proxy.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const ALLOW = { allowedHosts: ["raw.githubusercontent.com"], maxBytes: 1024, timeoutMs: 1000, maxRedirects: 2 };

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function failCode(error: unknown): string | undefined {
  return error instanceof EgressAllowlistError ? error.code : undefined;
}

function deps(overrides: Partial<EgressAllowlistDeps> = {}): EgressAllowlistDeps {
  return {
    resolveHost: async (hostname) => {
      if (hostname === "raw.githubusercontent.com") return [{ address: "203.0.113.10", family: 4 }];
      if (hostname === "api.github.com") return [{ address: "203.0.113.11", family: 4 }];
      return [{ address: "198.51.100.7", family: 4 }];
    },
    request: async ({ url, resolvedIp }) => ({
      statusCode: 200,
      headers: {},
      body: Buffer.from(`ok:${url.hostname}:${resolvedIp}`),
    }),
    now: () => new Date("2026-07-06T12:00:00.000Z"),
    ...overrides,
  };
}

test("RED adversarial: non-allowlist host is denied before request", async () => {
  let requested = false;
  await assert.rejects(
    () => fetchWithEgressAllowlist("https://evil.example/payload", ALLOW, deps({
      request: async () => {
        requested = true;
        return { statusCode: 200, headers: {}, body: Buffer.from("bad") };
      },
    })),
    (error) => failCode(error) === "host_not_allowed",
  );
  assert.equal(requested, false, "deny-by-default must block before any outbound request");
});

test("RED adversarial: unsupported hosts are denied even if operator config accidentally lists them", async () => {
  let requested = false;
  await assert.rejects(
    () => fetchWithEgressAllowlist("https://example.com/payload", { ...ALLOW, allowedHosts: ["example.com"] }, deps({
      request: async () => {
        requested = true;
        return { statusCode: 200, headers: {}, body: Buffer.from("bad") };
      },
    })),
    (error) => failCode(error) === "host_not_allowed",
  );
  assert.equal(requested, false, "only GitHub retrieval hosts are supported even when listed by mistake");
});

test("RED adversarial: cleartext HTTP source retrieval is denied before request", async () => {
  let requested = false;
  await assert.rejects(
    () => fetchWithEgressAllowlist("http://raw.githubusercontent.com/owner/repo/ref/path", ALLOW, deps({
      request: async () => {
        requested = true;
        return { statusCode: 200, headers: {}, body: Buffer.from("bad") };
      },
    })),
    (error) => failCode(error) === "unsupported_protocol",
  );
  assert.equal(requested, false, "cleartext protocol must fail before any outbound request");
});

test("RED adversarial: literal internal IP targets are denied even if allowlisted", async () => {
  await assert.rejects(
    () => fetchWithEgressAllowlist("https://127.0.0.1/latest/meta-data", { ...ALLOW, allowedHosts: ["127.0.0.1"] }, deps()),
    (error) => failCode(error) === "internal_ip_denied",
  );
  await assert.rejects(
    () => fetchWithEgressAllowlist("https://[::1]/latest/meta-data", { ...ALLOW, allowedHosts: ["[::1]"] }, deps()),
    (error) => failCode(error) === "internal_ip_denied",
  );
});

test("RED adversarial: DNS rebinding to internal IP is denied and not connected", async () => {
  let requested = false;
  await assert.rejects(
    () => fetchWithEgressAllowlist("https://raw.githubusercontent.com/owner/repo/main/README.md", ALLOW, deps({
      resolveHost: async () => [{ address: "169.254.169.254", family: 4 }],
      request: async () => {
        requested = true;
        return { statusCode: 200, headers: {}, body: Buffer.from("bad") };
      },
    })),
    (error) => failCode(error) === "internal_ip_denied",
  );
  assert.equal(requested, false, "rebound internal IP must be rejected before connect");
});

test("RED adversarial: redirect targets are revalidated and internal redirect is blocked", async () => {
  await assert.rejects(
    () => fetchWithEgressAllowlist("https://raw.githubusercontent.com/owner/repo/main/README.md", ALLOW, deps({
      request: async () => ({
        statusCode: 302,
        headers: { location: "https://127.0.0.1/metadata" },
        body: Buffer.alloc(0),
      }),
    })),
    (error) => failCode(error) === "internal_ip_denied",
  );
});

test("RED adversarial: redirect protocol downgrade is blocked", async () => {
  await assert.rejects(
    () => fetchWithEgressAllowlist("https://raw.githubusercontent.com/owner/repo/main/README.md", ALLOW, deps({
      request: async () => ({
        statusCode: 302,
        headers: { location: "http://raw.githubusercontent.com/owner/repo/main/README.md" },
        body: Buffer.alloc(0),
      }),
    })),
    (error) => failCode(error) === "unsupported_protocol",
  );
});

test("RED adversarial: redirect loops hit the redirect limit", async () => {
  await assert.rejects(
    () => fetchWithEgressAllowlist("https://raw.githubusercontent.com/owner/repo/main/README.md", { ...ALLOW, maxRedirects: 1 }, deps({
      request: async () => ({
        statusCode: 302,
        headers: { location: "https://raw.githubusercontent.com/owner/repo/next/README.md" },
        body: Buffer.alloc(0),
      }),
    })),
    (error) => failCode(error) === "redirect_limit_exceeded",
  );
});

test("RED adversarial: symbolic resolvedRef is rejected before egress", async () => {
  const { privateKeyPem } = keys();
  let requested = false;
  await assert.rejects(
    () => fetchGithubResolvedRefSnapshot({
      repo: "jinwon-int/a2a-nexus",
      requestedRef: "main",
      resolvedRef: "main",
      path: "README.md",
      signingKeyPem: privateKeyPem,
      keyId: "runner:test",
      egress: ALLOW,
    }, deps({
      request: async () => {
        requested = true;
        return { statusCode: 200, headers: {}, body: Buffer.from("bad") };
      },
    })),
    (error) => failCode(error) === "symbolic_ref_denied",
  );
  assert.equal(requested, false, "symbolic refs must be rejected before fetch because snapshots bind immutable commits only");
});

test("GREEN: allowlisted GitHub raw fetch emits signed snapshot that verifies", async () => {
  const { privateKeyPem, publicKeyPem } = keys();
  let seenResolvedIp = "";
  const snapshot = await fetchGithubResolvedRefSnapshot({
    repo: "jinwon-int/a2a-nexus",
    requestedRef: "main",
    resolvedRef: SHA,
    path: "README.md",
    signingKeyPem: privateKeyPem,
    keyId: "runner:test",
    egress: ALLOW,
  }, deps({
    request: async ({ url, resolvedIp }): Promise<Omit<EgressHttpResponse, "finalUrl" | "resolvedIp">> => {
      seenResolvedIp = resolvedIp;
      assert.equal(url.hostname, "raw.githubusercontent.com");
      assert.match(url.pathname, new RegExp(`/jinwon-int/a2a-nexus/${SHA}/README\\.md$`));
      return { statusCode: 200, headers: {}, body: Buffer.from("# signed source\n") };
    },
  }));

  assert.equal(seenResolvedIp, "203.0.113.10", "request must use the DNS-validated pinned IP");
  assert.equal(snapshot.resolvedRef, SHA);
  assert.equal(snapshot.byteLen, Buffer.byteLength("# signed source\n", "utf8"));
  assert.ok(snapshot.signature, "signed snapshot must carry a JWS signature");
  assert.deepEqual(verifyRetrievalSnapshot(snapshot, { publicKeyPem }), { ok: true });

  const symbolicSnapshot: RetrievalSnapshot = { ...snapshot, resolvedRef: "main" };
  assert.deepEqual(verifyRetrievalSnapshot(symbolicSnapshot, { publicKeyPem }), { ok: false, reason: "resolvedRef must be a commit SHA" });
});

test("RED adversarial: non-2xx GitHub raw responses are not signed as snapshots", async () => {
  const { privateKeyPem } = keys();
  await assert.rejects(
    () => fetchGithubResolvedRefSnapshot({
      repo: "jinwon-int/a2a-nexus",
      requestedRef: "main",
      resolvedRef: SHA,
      path: "README.md",
      signingKeyPem: privateKeyPem,
      keyId: "runner:test",
      egress: ALLOW,
    }, deps({
      request: async () => ({ statusCode: 404, headers: {}, body: Buffer.from("not found") }),
    })),
    (error) => failCode(error) === "request_failed",
  );
});

test("GREEN: response byte cap fails closed", async () => {
  await assert.rejects(
    () => fetchWithEgressAllowlist("https://raw.githubusercontent.com/owner/repo/ref/path", { ...ALLOW, maxBytes: 3 }, deps({
      request: async ({ maxBytes }) => {
        const body = Buffer.from("too large");
        if (body.length > maxBytes) throw new EgressAllowlistError("response_too_large", "response exceeded test cap");
        return { statusCode: 200, headers: {}, body };
      },
    })),
    (error) => failCode(error) === "response_too_large",
  );
});
