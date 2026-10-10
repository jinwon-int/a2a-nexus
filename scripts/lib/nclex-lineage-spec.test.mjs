#!/usr/bin/env node
/**
 * Contract tests for scripts/lib/nclex-lineage-spec.mjs (#2362): one review
 * lineage per (nclex PR, role), frozen intent from head-independent inputs,
 * and spec compatibility with review-lineage-client `create`. Offline only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  NCLEX_LINEAGE_ROLES,
  buildNclexLineageSpec,
  main,
  nclexLineageId,
  parsePrFields,
  stripHtmlComments,
} from "./nclex-lineage-spec.mjs";
import { buildCreateRequest, laneBinding } from "./review-lineage-client.mjs";

const BASE = "a743e8461b5d03facbe07280a0ba255337d7b884";
const HEAD_1 = "775b98622eb4ce267aa25e01eeb10870773ad00e";
const HEAD_2 = "1111111111111111111111111111111111111111";
const NOW = () => new Date("2026-10-10T12:00:00Z");

function body(risk = "standard", overrides = {}) {
  const fields = {
    TASK_ID: "RNM-20261004-001",
    TASK_KIND: "new_standalone",
    AUTHOR_NODE: "soonwook",
    TARGET_IDS: "RN-PHARM-0025, RN-PHARM-0026",
    SOURCE_PACKET: "PKT-PPT02-MED-RIGHTS-20261004-v1",
    REFS_MANIFEST_SHA256: "7af21128ced02d443792ec671cc4e0f31dcd42afd03dffab4a3ce8be3d80cabc",
    BASE_SHA: BASE,
    RISK_CLASS: risk,
    ...overrides,
  };
  const lines = Object.entries(fields).filter(([, v]) => v !== null).map(([k, v]) => `- ${k}: ${v}`);
  return ["## 계약", "", ...lines, "", "본문 설명"].join("\n");
}

function tmpDiff(text = "diff --git a/content/x.json b/content/x.json\n+1\n") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nclex-lineage-spec-"));
  const file = path.join(dir, "pr.diff");
  fs.writeFileSync(file, text);
  return file;
}

function spec(overrides = {}) {
  return buildNclexLineageSpec({
    prNumber: 624,
    role: "content_clinical",
    prBody: body(),
    baseSha: BASE,
    headSha: HEAD_1,
    diffFile: tmpDiff(),
    ...overrides,
  });
}

const INTENT_KEYS = ["lineageId", "dispatchRef", "goal", "nonGoals", "invariants", "acceptanceCriteria", "declaredPaths"];
const intentOf = (s) => Object.fromEntries(INTENT_KEYS.map((k) => [k, s[k]]));

test("parsePrFields matches the nclex `- KEY: value` grammar and strips HTML comments", () => {
  const fields = parsePrFields("- TASK_ID: T-1 <!-- note -->\n  - RISK_CLASS: high\nTASK_KIND: ignored (no dash)\n");
  assert.deepEqual(fields, { TASK_ID: "T-1", RISK_CLASS: "high" });
});

test("stripHtmlComments removes reassembled and unterminated comments (CodeQL incomplete sanitization)", () => {
  assert.equal(stripHtmlComments("a <!-- x --> b <!-- y --> c"), "a  b  c");
  assert.equal(stripHtmlComments("<!<!---->--x"), "");
  assert.equal(stripHtmlComments("value <!-- unterminated"), "value ");
  assert.equal(stripHtmlComments("no comment"), "no comment");
  for (const input of ["<!<!---->-- tail -->ok", "<<!-- -->!-- a -->--> z", "<!-<!-- x -->- y -->"]) {
    assert.ok(!stripHtmlComments(input).includes("<!--"), input);
  }
});

test("lineage id is deterministic per (PR, role) and distinct across roles", () => {
  assert.equal(nclexLineageId(624, "content_clinical"), "nclex-pr624-content-clinical");
  assert.equal(nclexLineageId("624", "evidence_adversarial"), "nclex-pr624-evidence-adversarial");
  const ids = Object.keys(NCLEX_LINEAGE_ROLES).map((role) => nclexLineageId(624, role));
  assert.equal(new Set(ids).size, ids.length);
  assert.throws(() => nclexLineageId(624, "terminology"), /unknown role/);
  assert.throws(() => nclexLineageId("0", "content_clinical"), /positive integer/);
});

test("frozen intent does not depend on the head: a correction head keeps the same intent fields", () => {
  const first = spec({ headSha: HEAD_1 });
  const corrected = spec({ headSha: HEAD_2, diffFile: tmpDiff("different diff\n") });
  assert.deepEqual(intentOf(corrected), intentOf(first));
  assert.equal(corrected.headSha, HEAD_2);
});

test("parallel role lanes of one head get separate lineages with separate intents", () => {
  const clinical = spec({ role: "content_clinical" });
  const adversarial = spec({ role: "evidence_adversarial" });
  assert.notEqual(clinical.lineageId, adversarial.lineageId);
  assert.notEqual(clinical.goal, adversarial.goal);
  assert.ok(clinical.nonGoals.includes("evidence_adversarial 역할의 판정 범위"));
  const a = buildCreateRequest(clinical, { now: NOW });
  const b = buildCreateRequest(adversarial, { now: NOW });
  assert.notEqual(a.request.contract.intentHash, b.request.contract.intentHash);
  assert.equal(a.request.binding.diffHash, b.request.binding.diffHash);
});

test("risk class gates the high_risk_safety role", () => {
  assert.throws(() => spec({ role: "high_risk_safety" }), /not a lane for RISK_CLASS standard/);
  const high = spec({ role: "high_risk_safety", prBody: body("high") });
  assert.equal(high.lineageId, "nclex-pr624-high-risk-safety");
  assert.equal(high.acceptanceCriteria.length, 3);
  assert.throws(() => spec({ prBody: body("extreme") }), /unsupported RISK_CLASS/);
});

test("fails closed on missing contract fields and malformed subjects", () => {
  assert.throws(() => spec({ prBody: body("standard", { REFS_MANIFEST_SHA256: null }) }), /missing required field REFS_MANIFEST_SHA256/);
  assert.throws(() => spec({ headSha: "775b986" }), /headSha must be/);
  assert.throws(() => spec({ baseSha: BASE.toUpperCase() }), /baseSha must be/);
  assert.throws(() => spec({ repo: "/tmp/x" }), /exactly one of repo or diffFile/);
  assert.throws(() => buildNclexLineageSpec({ prNumber: 1, role: "content_clinical", prBody: body(), baseSha: BASE, headSha: HEAD_1 }), /exactly one/);
});

test("spec is accepted by review-lineage-client create and yields a lane binding", () => {
  const s = spec({ brokerUrl: "http://127.0.0.1:18787", requesterId: "operator:test" });
  const built = buildCreateRequest(s, { now: NOW });
  const { contract, binding } = built.request;
  assert.equal(contract.lineageId, "nclex-pr624-content-clinical");
  assert.deepEqual(contract.acceptanceCriteria.map((c) => c.id), ["AC-1", "AC-2", "AC-3", "AC-4"]);
  assert.deepEqual(contract.declaredPaths.allowed, ["content/**", "data/**", "refs/**"]);
  assert.equal(binding.headSha, HEAD_1);
  assert.match(binding.intentHash, /\S/);
  const lane = laneBinding({
    schema: "a2a.review-lineage-client-record.v1",
    lineageId: contract.lineageId,
    binding,
  });
  assert.equal(lane.lineageId, contract.lineageId);
});

test("CLI: usage errors exit 2, contract errors exit 1, success writes a 0600 spec file", () => {
  const sink = () => { let s = ""; return { write: (t) => { s += t; }, get text() { return s; } }; };
  const err = sink();
  assert.equal(main(["--pr", "624"], { stdout: sink(), stderr: err }), 2);
  assert.match(err.text, /usage/);
  assert.equal(main(["--bogus", "x"], { stdout: sink(), stderr: sink() }), 2);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nclex-lineage-cli-"));
  const bodyFile = path.join(dir, "body.md");
  fs.writeFileSync(bodyFile, body());
  const diffFile = tmpDiff();
  const base = ["--pr", "624", "--base", BASE, "--head", HEAD_1, "--body-file", bodyFile, "--diff-file", diffFile];

  const bad = sink();
  assert.equal(main([...base, "--role", "high_risk_safety"], { stdout: sink(), stderr: bad }), 1);
  assert.match(bad.text, /not a lane/);

  const out = path.join(dir, "spec.json");
  assert.equal(main([...base, "--role", "evidence_adversarial", "--out", out], { stdout: sink(), stderr: sink() }), 0);
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  const written = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(written.lineageId, "nclex-pr624-evidence-adversarial");
  assert.equal(written.diffFile, diffFile);
});
