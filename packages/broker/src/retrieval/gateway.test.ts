import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";

import { createRetrievalGateway, labelSharedCitations } from "./gateway.js";
import { createFixtureProvider } from "./provider.js";
import { verifyWebRetrievalSnapshot, snapshotIdFor } from "./snapshot.js";

function signingKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    signingKey: {
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      keyId: "gw-test",
    },
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function block(overrides: Partial<Parameters<typeof createRetrievalGateway>[0]["block"]> = {}) {
  return { allowedHosts: ["docs.example.com"], maxRequests: 5, maxBytes: 1_000_000, ...overrides };
}

const NOW = () => new Date("2026-08-30T00:00:00.000Z");

test("scrape returns a signed snapshot inside the allowlist", async () => {
  const { signingKey, publicKeyPem } = signingKeys();
  const provider = createFixtureProvider({ pages: { "https://docs.example.com/a": { body: "page a" } } });
  const gateway = createRetrievalGateway({ provider, block: block(), signingKey, now: NOW });
  const result = await gateway.scrape("https://docs.example.com/a");
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.dedupHit, false);
  assert.deepEqual(verifyWebRetrievalSnapshot(result.snapshot, { publicKeyPem }), { ok: true });
});

test("hosts outside the allowlist are denied as host_not_allowed", async () => {
  const { signingKey } = signingKeys();
  const gateway = createRetrievalGateway({ provider: createFixtureProvider({}), block: block(), signingKey, now: NOW });
  const result = await gateway.scrape("https://other.example.com/page");
  assert.deepEqual(result, { status: "denied", code: "host_not_allowed", message: result.status === "denied" ? result.message : "" });
  assert.match(result.status === "denied" ? result.message : "", /outside this lane's retrieval allowlist/);
});

test("internal and metadata hosts are denied even if someone allowlists a bare name", async () => {
  const { signingKey } = signingKeys();
  const gateway = createRetrievalGateway({ provider: createFixtureProvider({}), block: block({ allowedHosts: ["localhost", "metadata.google.internal"] }), signingKey, now: NOW });
  const loopback = await gateway.scrape("https://localhost/secret");
  assert.equal(loopback.status === "denied" ? loopback.code : "", "internal_host_denied");
  const metadata = await gateway.scrape("https://metadata.google.internal/computeMetadata/v1/");
  assert.equal(metadata.status === "denied" ? metadata.code : "", "internal_host_denied");
});

test("invalid urls are denied as invalid_url", async () => {
  const { signingKey } = signingKeys();
  const gateway = createRetrievalGateway({ provider: createFixtureProvider({}), block: block(), signingKey, now: NOW });
  const result = await gateway.scrape("file:///etc/passwd");
  assert.equal(result.status === "denied" ? result.code : "", "invalid_url");
});

test("request budget is enforced fail-closed after successful fetches", async () => {
  const { signingKey } = signingKeys();
  const provider = createFixtureProvider({
    pages: {
      "https://docs.example.com/1": { body: "one" },
      "https://docs.example.com/2": { body: "two" },
    },
  });
  const gateway = createRetrievalGateway({ provider, block: block({ maxRequests: 1 }), signingKey, now: NOW });
  const first = await gateway.scrape("https://docs.example.com/1");
  assert.equal(first.status, "ok");
  const second = await gateway.scrape("https://docs.example.com/2");
  assert.equal(second.status === "denied" ? second.code : "", "budget_requests_exhausted");
});

test("provider outage does not consume the request budget", async () => {
  const { signingKey } = signingKeys();
  const failing = {
    name: "failing",
    async search() {
      return [];
    },
    async scrape() {
      throw new Error("provider down");
    },
  };
  const gateway = createRetrievalGateway({ provider: failing, block: block({ maxRequests: 1 }), signingKey, now: NOW });
  const denied = await gateway.scrape("https://docs.example.com/x");
  assert.equal(denied.status === "denied" ? denied.code : "", "provider_error");
  assert.equal(gateway.budget.requestsUsed, 0);
});

test("byte budget is enforced and denied content never enters the cache", async () => {
  const { signingKey } = signingKeys();
  const provider = createFixtureProvider({ pages: { "https://docs.example.com/big": { body: "x".repeat(100) } } });
  const gateway = createRetrievalGateway({ provider, block: block({ maxBytes: 50 }), signingKey, now: NOW });
  const result = await gateway.scrape("https://docs.example.com/big");
  assert.equal(result.status === "denied" ? result.code : "", "budget_bytes_exhausted");
  assert.equal(gateway.budget.bytesUsed, 0);
});

test("dedup: identical url+content returns the cached snapshot without a provider call", async () => {
  const { signingKey } = signingKeys();
  let scrapeCalls = 0;
  const provider = createFixtureProvider({ pages: { "https://docs.example.com/same": { body: "same body" } } });
  const wrapped = {
    name: provider.name,
    async search(query: string) {
      return provider.search(query);
    },
    async scrape(url: string) {
      scrapeCalls += 1;
      return provider.scrape(url);
    },
  };
  const gateway = createRetrievalGateway({ provider: wrapped, block: block({ maxRequests: 5 }), signingKey, now: NOW });
  const first = await gateway.scrape("https://docs.example.com/same");
  const second = await gateway.scrape("https://docs.example.com/same");
  assert.equal(first.status, "ok");
  assert.equal(second.status, "ok");
  if (first.status === "ok" && second.status === "ok") {
    assert.equal(first.dedupHit, false);
    assert.equal(second.dedupHit, true);
    assert.equal(snapshotIdFor(first.snapshot), snapshotIdFor(second.snapshot));
  }
  assert.equal(scrapeCalls, 1);
  assert.equal(gateway.budget.requestsUsed, 1);
  assert.equal(gateway.budget.cacheHits, 1);
});

test("labelSharedCitations groups snapshot ids cited by more than one phase", () => {
  const labeled = labelSharedCitations({
    thesis: ["web-a", "web-b"],
    antithesis: ["web-a", "web-c", "web-c"],
    synthesis: ["web-d"],
  });
  assert.deepEqual(labeled.sharedGroups, [{ snapshotId: "web-a", phases: ["antithesis", "thesis"] }]);
  assert.deepEqual(labeled.uniqueByPhase, { thesis: 2, antithesis: 2, synthesis: 1 });
});

test("search filters allowlisted hits only and does not consume the request budget", async () => {
  const { signingKey } = signingKeys();
  const provider = createFixtureProvider({
    searchHits: {
      "example docs": [
        { url: "https://docs.example.com/ok" },
        { url: "https://evil.example.com/trap" },
      ],
    },
    pages: { "https://docs.example.com/ok": { body: "ok page" } },
  });
  const gateway = createRetrievalGateway({ provider, block: block({ maxRequests: 1 }), signingKey, now: NOW });
  const hits = await gateway.search("example docs");
  assert.equal(hits.status, "ok");
  if (hits.status !== "ok") return;
  assert.deepEqual(hits.hits, [{ url: "https://docs.example.com/ok" }]);
  assert.equal(gateway.budget.requestsUsed, 0);
  const scraped = await gateway.scrape("https://docs.example.com/ok");
  assert.equal(scraped.status, "ok");
});
