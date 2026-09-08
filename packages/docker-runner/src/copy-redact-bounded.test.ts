// #2083 item 1: copyAndRedactFile must read a constant-size prefix of an
// oversized artifact instead of the whole file. Verified behaviorally (the
// runtime FileHandle prototype is not patchable): a marker byte placed just
// past the 64 KB prefix boundary must be invisible to the redaction path on a
// 10 MB text input, while the same marker inside the prefix forces the raw
// binary copy path.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { copyAndRedactFile } from "./scanner.js";
import { RESULT_STREAM_LIMIT } from "./redaction.js";

const PREFIX_BYTES = 64 * 1024;

test("copyAndRedactFile reads a constant prefix of a 10 MB text artifact (#2083)", async () => {
  const root = mkdtempSync(join(tmpdir(), "a2a-redact-bounded-"));
  const src = join(root, "huge.log");
  const dest = join(root, "huge.redacted.log");
  // 10 MB: secret at the very front, a NUL byte at ~PREFIX_BYTES + 4 KB, then
  // more payload. If the implementation read the whole file (old behavior),
  // the NUL byte would classify the artifact as binary and the output would
  // be a raw 10 MB copy. With the bounded prefix read, the prefix is clean
  // text: the secret is redacted and the output stays at RESULT_STREAM_LIMIT.
  const secret = "ghp_" + "12345678901234567890";
  writeFileSync(src, `Token: ${secret}\n`);
  const filler = "A".repeat(1024);
  for (let written = 20; written < 10 * 1024 * 1024; written += filler.length) {
    if (written < PREFIX_BYTES && written + filler.length >= PREFIX_BYTES + 4096) {
      // splice the NUL marker just past the prefix boundary
      writeFileSync(src, Buffer.concat([Buffer.from(filler), Buffer.from([0])]), { flag: "a" });
      written += filler.length;
      continue;
    }
    appendFiller(src, filler);
  }

  await copyAndRedactFile(src, dest);
  const content = readFileSync(dest, "utf8");
  assert.ok(content.length <= RESULT_STREAM_LIMIT + 200, `output must stay bounded, got ${content.length}`);
  assert.ok(content.includes("<redacted-github-token>"), "secret in the scanned prefix must be redacted");
  assert.ok(content.includes("<truncated"), "oversized input must carry the truncation marker");
  assert.equal(statSync(src).size > 10 * 1024 * 1024 - 4096, true);
  rmSync(root, { recursive: true, force: true });
});

test("copyAndRedactFile: NUL inside the scanned prefix still forces the raw copy path", async () => {
  const root = mkdtempSync(join(tmpdir(), "a2a-redact-binary-"));
  const src = join(root, "huge.bin");
  const dest = join(root, "huge.copied.bin");
  const blob = Buffer.alloc(128 * 1024);
  blob[1024] = 0; // NUL well inside the prefix → binary
  writeFileSync(src, blob);

  await copyAndRedactFile(src, dest);
  const copied = readFileSync(dest);
  assert.equal(copied.length, blob.length, "binary artifacts must be copied as-is");
  assert.ok(copied.equals(blob));
  rmSync(root, { recursive: true, force: true });
});

function appendFiller(path: string, filler: string): void {
  writeFileSync(path, filler, { flag: "a" });
}
