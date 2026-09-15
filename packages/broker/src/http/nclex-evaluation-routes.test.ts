/**
 * NCLEX evaluation route tests (#1724): operator-gated signed-receipt
 * admission (fail-closed), idempotent storage, and the merge-ready
 * projection. Default-off surface: no route merges or touches a PR branch.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";

import { canonicalizeJson } from "a2a-attestation";

import { BrokerError } from "../core/broker-error.js";
import {
  parseReceiptCore,
  receiptIdOf,
  NCLEX_RECEIPT_SCHEMA,
  type NclexEvaluationKeyring,
} from "a2a-nclex-evaluation";
import { NclexEvaluationReceiptStore } from "a2a-nclex-evaluation";
import { handleNclexEvaluationRoutesIfMatched } from "./nclex-evaluation-routes.js";

class CapturingResponse extends EventEmitter {
  statusCode?: number;
  body = "";
  writeHead(statusCode: number): this {
    this.statusCode = statusCode;
    return this;
  }
  end(chunk?: string): this {
    if (chunk) this.body += chunk;
    return this;
  }
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PRIVATE_PEM = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const PUBLIC_PEM = publicKey.export({ type: "spki", format: "pem" }) as string;
const KEYRING: NclexEvaluationKeyring = { "review-key-1": PUBLIC_PEM };

function makeReceipt(overrides: Record<string, unknown> = {}) {
  const core = parseReceiptCore({
    schema: NCLEX_RECEIPT_SCHEMA,
    canonicalization: "rfc8785-jcs-v1",
    repo: "jinwon-int/nclex",
    prNumber: 145,
    baseSha: "c".repeat(40),
    headSha: "a".repeat(40),
    diffHash: "dh-1",
    intentHash: "ih-1",
    authorNodeId: "dungae",
    reviewerNodeId: "seoseo",
    team: "T1",
    lane: "content_clinical",
    verdict: "PASS",
    findings: [],
    producedAt: "2026-08-06T09:00:00.000Z",
    ...overrides,
  });
  const protectedHeader = Buffer.from(
    JSON.stringify({ alg: "EdDSA", kid: "review-key-1", canonicalization: "rfc8785-jcs-v1" }),
    "utf8",
  ).toString("base64url");
  const payload = Buffer.from(canonicalizeJson(core), "utf8").toString("base64url");
  const signature = cryptoSign(null, Buffer.from(`${protectedHeader}.${payload}`, "utf8"), PRIVATE_PEM).toString("base64url");
  return { ...core, receiptId: receiptIdOf(core), signatures: [{ protected: protectedHeader, signature }] };
}

function ctxFor({
  method,
  path,
  body,
  identity = { id: "operator-1", kind: "node", role: "operator" } as never,
  enforceRequesterIdentity = true,
}: {
  method: string;
  path: string;
  body?: unknown;
  identity?: never;
  enforceRequesterIdentity?: boolean;
}) {
  const store = new NclexEvaluationReceiptStore();
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  const res = new CapturingResponse();
  const url = new URL(`http://127.0.0.1${path}`);
  return {
    store,
    res,
    ctx: {
      method,
      path: url.pathname,
      req: req as never,
      res: res as never,
      url,
      store,
      keyring: KEYRING,
      enforceRequesterIdentity,
      requesterIdentity: identity ?? null,
    },
  };
}

async function post(store: NclexEvaluationReceiptStore, body: unknown) {
  const req = Readable.from([JSON.stringify(body)]);
  const res = new CapturingResponse();
  const url = new URL("http://127.0.0.1/nclex-evaluations/receipts");
  await handleNclexEvaluationRoutesIfMatched({
    method: "POST",
    path: url.pathname,
    req: req as never,
    res: res as never,
    url,
    store,
    keyring: KEYRING,
    enforceRequesterIdentity: true,
    requesterIdentity: { id: "operator-1", kind: "node", role: "operator" } as never,
  });
  return res;
}

function mergeReadyUrl(headSha: string, extraQuery = "") {
  return new URL(
    `http://127.0.0.1/nclex-evaluations/jinwon-int/nclex/145/merge-ready?headSha=${headSha}${extraQuery}`,
  );
}

async function getMergeReady(store: NclexEvaluationReceiptStore, url: URL) {
  const res = new CapturingResponse();
  await handleNclexEvaluationRoutesIfMatched({
    method: "GET",
    path: url.pathname,
    req: Readable.from([]) as never,
    res: res as never,
    url,
    store,
    keyring: KEYRING,
    enforceRequesterIdentity: true,
    requesterIdentity: { id: "operator-1", kind: "node", role: "operator" } as never,
  });
  assert.equal(res.statusCode, 200);
  return JSON.parse(res.body);
}

async function postReceipt(store: NclexEvaluationReceiptStore, overrides: Record<string, unknown> = {}) {
  return post(store, makeReceipt(overrides));
}

test("POST admits a valid signed receipt and stores it idempotently (#1724)", async () => {
  const { store } = ctxFor({ method: "POST", path: "/nclex-evaluations/receipts" });
  const receipt = makeReceipt();
  const first = await post(store, receipt);
  assert.equal(first.statusCode, 200);
  assert.equal(JSON.parse(first.body).receiptId, receipt.receiptId);
  const second = await post(store, receipt);
  assert.equal(second.statusCode, 200, "re-submission is idempotent");
  assert.equal(store.count(), 1);
});

test("POST rejects tampered and unsigned receipts fail-closed (#1724)", async () => {
  const { store } = ctxFor({ method: "POST", path: "/nclex-evaluations/receipts" });
  const tampered = { ...makeReceipt(), verdict: "BLOCK" };
  await assert.rejects(post(store, tampered), (error: unknown) => {
    assert.ok(error instanceof BrokerError);
    assert.match(error.message, /receipt_id_mismatch/);
    return true;
  });
  const unsigned = makeReceipt();
  const { signatures, ...noSig } = unsigned as Record<string, unknown>;
  await assert.rejects(post(store, noSig), (error: unknown) => {
    assert.ok(error instanceof BrokerError);
    assert.match(error.message, /receipt_signature_missing/);
    return true;
  });
  assert.equal(store.count(), 0);
});

test("POST requires the operator role even when enforcement is on (#1724)", async () => {
  const { store } = ctxFor({ method: "POST", path: "/nclex-evaluations/receipts" });
  const req = Readable.from([JSON.stringify(makeReceipt())]);
  const res = new CapturingResponse();
  const url = new URL("http://127.0.0.1/nclex-evaluations/receipts");
  await assert.rejects(
    handleNclexEvaluationRoutesIfMatched({
      method: "POST",
      path: url.pathname,
      req: req as never,
      res: res as never,
      url,
      store,
      keyring: KEYRING,
      enforceRequesterIdentity: true,
      requesterIdentity: { id: "analyst-1", kind: "node", role: "analyst" } as never,
    }),
  );
  assert.equal(store.count(), 0);
});

test("merge-ready projection reflects stored fresh receipts and query facts (#1724)", async () => {
  const { store } = ctxFor({ method: "GET", path: "/x" });
  await post(store, makeReceipt());
  await post(store, makeReceipt({ reviewerNodeId: "nosuk", producedAt: "2026-08-06T09:05:00.000Z" }));
  await post(store, makeReceipt({ reviewerNodeId: "yukson", headSha: "b".repeat(40), producedAt: "2026-08-06T09:10:00.000Z" }));

  const res = new CapturingResponse();
  const url = new URL(
    "http://127.0.0.1/nclex-evaluations/jinwon-int/nclex/145/merge-ready?headSha=" + "a".repeat(40) + "&gateGreen=1&authorDistinctApproval=1",
  );
  await handleNclexEvaluationRoutesIfMatched({
    method: "GET",
    path: url.pathname,
    req: Readable.from([]) as never,
    res: res as never,
    url,
    store,
    keyring: KEYRING,
    enforceRequesterIdentity: true,
    requesterIdentity: { id: "operator-1", kind: "node", role: "operator" } as never,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  // BUG-08: a stale receipt is reported via staleReceiptCount but is NOT a
  // merge-ready veto. With quorum met, gate green, author-distinct approval and
  // no conflict, the PR is ready even though an old-head receipt lingers.
  assert.equal(body.ready, true, "stale receipts must not block a PR that otherwise meets every condition");
  assert.equal(body.freshPassCount, 2);
  assert.equal(body.distinctReviewerCount, 2, "seoseo and nosuk are two distinct declared reviewers");
  assert.equal(body.staleReceiptCount, 1);
  assert.ok(!body.reasons.includes("stale_receipts_excluded:1"), "stale receipts must not appear as a blocking reason");

  const res2 = new CapturingResponse();
  const url2 = new URL(
    "http://127.0.0.1/nclex-evaluations/jinwon-int/nclex/145/merge-ready?headSha=" + "b".repeat(40) + "&risk=high-risk&gateGreen=1&authorDistinctApproval=1",
  );
  await handleNclexEvaluationRoutesIfMatched({
    method: "GET",
    path: url2.pathname,
    req: Readable.from([]) as never,
    res: res2 as never,
    url: url2,
    store,
    keyring: KEYRING,
    enforceRequesterIdentity: true,
    requesterIdentity: { id: "operator-1", kind: "node", role: "operator" } as never,
  });
  const body2 = JSON.parse(res2.body);
  assert.equal(body2.ready, false);
  assert.ok(body2.reasons.includes("insufficient_fresh_signed_pass:1/3"));
  assert.equal(body2.distinctReviewerCount, 1);
  assert.ok(body2.reasons.includes("insufficient_independent_reviewers:1/3"));
});

test("distinct-reviewer quorum: repeated receipts from one reviewer cannot satisfy quorum (#1724)", async () => {
  // Same declared node, separately signed receipts with different
  // receiptId/producedAt/lane/team: raw count reaches 2 but the distinct
  // declared reviewer count stays 1, so the PR is not ready.
  const { store } = ctxFor({ method: "POST", path: "/nclex-evaluations/receipts" });
  await postReceipt(store, { producedAt: "2026-08-06T09:00:00.000Z", lane: "content_clinical", team: "T1" });
  await postReceipt(store, {
    reviewerNodeId: "seoseo",
    producedAt: "2026-08-06T09:05:00.000Z",
    lane: "evidence_adversarial",
    team: "cross-team",
  });
  assert.equal(store.count(), 2, "both receipts are separately admitted");

  const body = await getMergeReady(store, mergeReadyUrl("a".repeat(40), "&gateGreen=1&authorDistinctApproval=1"));
  assert.equal(body.ready, false);
  assert.equal(body.receiptCount, 2);
  assert.equal(body.freshPassCount, 2, "freshPassCount stays the raw qualifying PASS record count");
  assert.equal(body.distinctReviewerCount, 1);
  assert.ok(body.reasons.includes("insufficient_independent_reviewers:1/2"));
  assert.ok(
    !body.reasons.some((reason: string) => reason.startsWith("insufficient_fresh_signed_pass")),
    "the raw count met its quorum; only the distinct count is short",
  );
});

test("distinct-reviewer quorum: two separately signed reviewers are ready; high-risk needs three (#1724)", async () => {
  const { store } = ctxFor({ method: "POST", path: "/nclex-evaluations/receipts" });
  await postReceipt(store, { reviewerNodeId: "seoseo" });
  await postReceipt(store, { reviewerNodeId: "nosuk", producedAt: "2026-08-06T09:05:00.000Z" });

  const ready = await getMergeReady(store, mergeReadyUrl("a".repeat(40), "&gateGreen=1&authorDistinctApproval=1"));
  assert.equal(ready.ready, true);
  assert.equal(ready.freshPassCount, 2);
  assert.equal(ready.distinctReviewerCount, 2);

  const highRisk = await getMergeReady(
    store,
    mergeReadyUrl("a".repeat(40), "&risk=high-risk&gateGreen=1&authorDistinctApproval=1"),
  );
  assert.equal(highRisk.ready, false);
  assert.ok(highRisk.reasons.includes("insufficient_independent_reviewers:2/3"));

  await postReceipt(store, {
    reviewerNodeId: "yukson",
    producedAt: "2026-08-06T09:10:00.000Z",
    team: "cross-team",
    lane: "evidence_adversarial",
  });
  const met = await getMergeReady(store, mergeReadyUrl("a".repeat(40), "&risk=high-risk&gateGreen=1&authorDistinctApproval=1"));
  assert.equal(met.ready, true);
  assert.equal(met.distinctReviewerCount, 3);
  assert.ok(!met.reasons.some((reason: string) => reason.startsWith("insufficient_")));
});

test("distinct-reviewer quorum: a duplicate reviewer's blocking finding still vetoes (#1724)", async () => {
  const { store } = ctxFor({ method: "POST", path: "/nclex-evaluations/receipts" });
  await postReceipt(store, { reviewerNodeId: "seoseo" });
  await postReceipt(store, {
    reviewerNodeId: "seoseo",
    producedAt: "2026-08-06T09:05:00.000Z",
    verdict: "BLOCK",
    findings: [{ findingId: "F-1", blocking: true }],
  });

  const body = await getMergeReady(store, mergeReadyUrl("a".repeat(40), "&gateGreen=1&authorDistinctApproval=1"));
  assert.equal(body.ready, false);
  assert.equal(body.freshPassCount, 1, "only the PASS receipt qualifies");
  assert.equal(body.distinctReviewerCount, 1);
  assert.equal(body.blockingFindings, 1, "all fresh blocking findings are counted, duplicate reviewer or not");
  assert.ok(body.reasons.includes("blocking_findings:1"));
  assert.ok(body.reasons.includes("insufficient_independent_reviewers:1/2"));
});

test("POST persists a newly stored receipt through the persist hook (#1724)", async () => {
  const store = new NclexEvaluationReceiptStore();
  let persisted = 0;
  const receipt = makeReceipt();
  const call = async () => {
    const req = Readable.from([JSON.stringify(receipt)]);
    const res = new CapturingResponse();
    const url = new URL("http://127.0.0.1/nclex-evaluations/receipts");
    await handleNclexEvaluationRoutesIfMatched({
      method: "POST",
      path: url.pathname,
      req: req as never,
      res: res as never,
      url,
      store,
      keyring: KEYRING,
      enforceRequesterIdentity: true,
      requesterIdentity: { id: "operator-1", kind: "node", role: "operator" } as never,
      persistReceipts: () => { persisted += 1; },
    });
  };
  await call();
  assert.equal(persisted, 1, "new receipt triggers durable persistence");
  await call();
  assert.equal(persisted, 1, "idempotent re-submission does not re-persist");
});

test("store survives a snapshot restore round-trip (#1724)", () => {
  const store = new NclexEvaluationReceiptStore();
  const receipt = makeReceipt();
  store.add(receipt, "2026-08-06T09:00:01.000Z");
  const snapshotRows = store.listAll();
  const restored = new NclexEvaluationReceiptStore(snapshotRows);
  assert.equal(restored.count(), 1);
  assert.deepEqual(restored.listAll(), snapshotRows);
});
