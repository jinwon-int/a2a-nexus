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
} from "../nclex-evaluation/receipt-contract.js";
import { NclexEvaluationReceiptStore } from "../nclex-evaluation/receipt-store.js";
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
  assert.equal(body.ready, false, "one stale receipt is reported as a reason");
  assert.equal(body.freshPassCount, 2);
  assert.equal(body.staleReceiptCount, 1);
  assert.ok(body.reasons.includes("stale_receipts_excluded:1"));

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
