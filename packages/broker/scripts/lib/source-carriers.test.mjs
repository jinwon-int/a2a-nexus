import assert from "node:assert/strict";
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
