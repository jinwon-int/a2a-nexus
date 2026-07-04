import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  collectSourceCarrierItems,
  normalizeSourceCarrierFile,
  sourceCarrierContent,
  sourceCarrierPath,
} from "./source-carriers.mjs";

test("source carrier helper normalizes all carriers and content fields including summary (#1272)", () => {
  const payload = {
    sourceBundle: { files: [{ repo: "r", path: "bundle.md", content: "bundle" }] },
    sourceFiles: [{ repository: "r", file: "source-files.md", contentText: "content text" }],
    sourceEvidence: [{ carrier: "sourceEvidence", name: "evidence.md", text: "text value" }],
    embeddedSourceEvidence: [{ path: "summary.md", summary: "SUMMARY_MARKER" }],
  };

  const items = collectSourceCarrierItems(payload);
  assert.deepEqual(items.map((item) => item.carrier), [
    "embeddedSourceEvidence",
    "sourceBundle.files",
    "sourceFiles",
    "sourceEvidence",
  ]);
  assert.deepEqual(items.map((item) => sourceCarrierPath(item.item)), [
    "summary.md",
    "bundle.md",
    "source-files.md",
    "evidence.md",
  ]);
  assert.deepEqual(items.map((item) => sourceCarrierContent(item.item).field), [
    "summary",
    "content",
    "contentText",
    "text",
  ]);
});

test("source carrier helper reports bounded drop reasons for unusable files (#1272)", () => {
  const unsafe = normalizeSourceCarrierFile({ path: "../secret.txt", content: "nope" }, { fallbackRepo: "r", maxFileBytes: 100, remainingBytes: 100 });
  assert.equal(unsafe.reason, "unsafe_path");
  assert.match(unsafe.warning, /skipped unsafe embedded source path/);

  const empty = normalizeSourceCarrierFile({ path: "empty.md", summary: "" }, { fallbackRepo: "r", maxFileBytes: 100, remainingBytes: 100 });
  assert.equal(empty.reason, "empty_content");
  assert.match(empty.warning, /skipped empty embedded source file/);

  const capped = normalizeSourceCarrierFile({ path: "large.md", summary: "x".repeat(20) }, { fallbackRepo: "r", maxFileBytes: 8, remainingBytes: 8 });
  assert.equal(capped.reason, "ok");
  assert.equal(capped.file.content, "xxxxxxxx");
  assert.equal(capped.file.contentField, "summary");
  assert.equal(capped.file.truncated, true);
});

test("source carrier conformance fixture covers all carrier/content-field parity paths (#1272)", () => {
  const fixture = JSON.parse(readFileSync(new URL("../../../../fixtures/conformance/source-carriers.json", import.meta.url), "utf8"));
  const items = collectSourceCarrierItems(fixture.payload);
  assert.equal(items.length, 12);
  assert.deepEqual(new Set(items.map((item) => item.carrier)), new Set(["sourceBundle.files", "sourceFiles", "sourceEvidence"]));
  assert.deepEqual(new Set(items.map((item) => sourceCarrierContent(item.item).field)), new Set(["content", "contentText", "text", "summary"]));
  for (const requiredPath of fixture.requiredPaths) {
    assert.ok(items.some((item) => sourceCarrierPath(item.item) === requiredPath), `missing required path ${requiredPath}`);
  }
});

test("V4 reproduction shape keeps two 8-item content carriers usable (#1272)", () => {
  const requiredPaths = ["ISSUE-1270.md", "V2-CANARY-EVIDENCE.md", "packages/broker/scripts/hermes-a2a-analysis-bridge.mjs"];
  const files = Array.from({ length: 8 }, (_, index) => ({
    repo: "jinwon-int/a2a-nexus",
    path: requiredPaths[index] || `v4-carrier-${index}.md`,
    content: `${index}:${"x".repeat(13000)}`,
  }));
  const payload = { sourceBundle: { files }, sourceFiles: files.map((file) => ({ ...file })) };
  const items = collectSourceCarrierItems(payload);
  assert.equal(items.length, 16);
  assert.equal(items.reduce((sum, item) => sum + sourceCarrierContent(item.item).content.length, 0) > 200000, true);
  for (const item of items) {
    const normalized = normalizeSourceCarrierFile(item.item, { fallbackRepo: "jinwon-int/a2a-nexus", maxFileBytes: 20000, remainingBytes: 20000 });
    assert.equal(normalized.reason, "ok");
    assert.equal(normalized.file.contentField, "content");
  }
  for (const requiredPath of requiredPaths) {
    assert.equal(items.some((item) => sourceCarrierPath(item.item) === requiredPath), true);
  }
});
