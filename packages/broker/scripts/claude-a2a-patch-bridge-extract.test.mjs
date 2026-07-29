// Diff-extraction unit tests for the Claude patch bridge.
//
// Found while triaging a live propose_patch failure whose only symptom was
// `git apply --check failed: corrupt patch at line 42`. The patch itself lives
// in a workspace the bridge deletes on exit, so the extraction path is covered
// directly here rather than only through a spawned bridge process.
import assert from "node:assert/strict";
import { test } from "node:test";
import { __test } from "./claude-a2a-patch-bridge.mjs";

const { extractUnifiedDiff } = __test;

const DIFF = [
  "diff --git a/guide.md b/guide.md",
  "--- a/guide.md",
  "+++ b/guide.md",
  "@@ -3,5 +3,11 @@",
  " Set it via:",
  " ",
  " ```bash",
  " EXISTING=1",
  " ```",
  "+",
  "+```bash",
  "+ADDED=1",
  "+```",
].join("\n");

test("a fenced diff that patches a markdown file keeps its inner fences and drops trailing prose", () => {
  const stdout = JSON.stringify({
    type: "result",
    result: "```diff\n" + DIFF + "\n```\n\nApplied the documentation update as requested.",
  });
  const got = extractUnifiedDiff(stdout);
  assert.equal(got.kind, "diff");
  assert.equal(got.body, DIFF, "extracted body must equal the diff exactly");
  assert.equal(got.body.includes("Applied the documentation update"), false, "prose must not enter the patch");
  assert.equal(/^```[ \t]*$/m.test(got.body), false, "the closing fence must not enter the patch");
});

test("a non-diff string earlier in the envelope does not mask a diff in a later field", () => {
  const stdout = JSON.stringify({
    type: "result",
    message: "I inspected the repository and prepared a change.",
    result: "```diff\n" + DIFF + "\n```",
  });
  const got = extractUnifiedDiff(stdout);
  assert.equal(got.kind, "diff");
  assert.equal(got.body, DIFF);
});

test("an explicit NO_DIFF marker is still honoured", () => {
  const stdout = JSON.stringify({ type: "result", result: "```\nNO_DIFF: nothing to change\n```" });
  assert.equal(extractUnifiedDiff(stdout).kind, "no_diff");
});

// ---------------------------------------------------------------------------
// a2a-nexus#1673: the raw (unfenced) scan used to stop at the next
// `diff --git `, which dropped every file after the first. The truncated body
// still parses, so `git apply --check` accepted it and the run reported success
// for a commit carrying part of the change.
//
// Every fixture below is verbatim output from a real `git diff` / `diff -u` run;
// the counts asserted are the counts git produced.
// ---------------------------------------------------------------------------

const THREE_FILE_DIFF = [
  "diff --git a/A.txt b/A.txt",
  "index d4998d2..085f61e 100644",
  "--- a/A.txt",
  "+++ b/A.txt",
  "@@ -1,5 +1,5 @@",
  " a1",
  " a2",
  "-a3",
  "+aX",
  " a4",
  " a5",
  "diff --git a/B.txt b/B.txt",
  "index 7e43a98..dff154a 100644",
  "--- a/B.txt",
  "+++ b/B.txt",
  "@@ -1,5 +1,5 @@",
  " b1",
  " b2",
  "-b3",
  "+bX",
  " b4",
  " b5",
  "diff --git a/C.txt b/C.txt",
  "index 486707c..694f77f 100644",
  "--- a/C.txt",
  "+++ b/C.txt",
  "@@ -1,5 +1,5 @@",
  " c1",
  " c2",
  "-c3",
  "+cX",
  " c4",
  " c5",
  "",
].join("\n");

const fileSections = (body) => (body.match(/^diff --git /gm) ?? []).length;
const hunks = (body) => (body.match(/^@@ /gm) ?? []).length;

test("a raw multi-file diff keeps every file section", () => {
  const got = extractUnifiedDiff(THREE_FILE_DIFF);
  assert.equal(got.kind, "diff");
  assert.equal(fileSections(got.body), 3, "all three file sections must survive");
  assert.equal(hunks(got.body), 3);
  assert.equal(got.body, THREE_FILE_DIFF, "the body must be the diff, byte for byte");
});

test("a raw multi-file diff survives prose on both sides, and takes none of it", () => {
  const stdout = "I reviewed the repository and prepared the change.\n\n"
    + THREE_FILE_DIFF
    + "\nThat updates all three files as requested.\n";
  const got = extractUnifiedDiff(stdout);
  assert.equal(got.kind, "diff");
  assert.equal(fileSections(got.body), 3);
  assert.equal(got.body.includes("That updates all three files"), false, "prose must not enter the patch");
  assert.equal(got.body.includes("I reviewed the repository"), false);
});

test("a raw multi-file diff inside a JSON envelope keeps every file section", () => {
  const got = extractUnifiedDiff(JSON.stringify({ type: "result", result: THREE_FILE_DIFF }));
  assert.equal(got.kind, "diff");
  assert.equal(fileSections(got.body), 3);
});

test("prose between two file sections is refused, not silently truncated", () => {
  // The scan cannot carry on past prose, but a body that stops there is a
  // partial patch that git would apply without complaint. Refusing is the only
  // answer that cannot be mistaken for the whole change.
  const [first, rest] = [
    THREE_FILE_DIFF.slice(0, THREE_FILE_DIFF.indexOf("diff --git a/B.txt")),
    THREE_FILE_DIFF.slice(THREE_FILE_DIFF.indexOf("diff --git a/B.txt")),
  ];
  const got = extractUnifiedDiff(`${first}Now the second file:\n${rest}`);
  assert.equal(got.kind, "no_diff", "a patch cut at a file boundary must not be handed to git apply");
  assert.match(got.body, /refusing a partial patch/);
});

test("plain `diff -u` output with no `diff --git` header keeps both files", () => {
  const plain = [
    "diff -ur a/P.txt b/P.txt",
    "--- a/P.txt",
    "+++ b/P.txt",
    "@@ -1,5 +1,5 @@",
    " p1",
    " p2",
    "-p3",
    "+pX",
    " p4",
    " p5",
    "diff -ur a/Q.txt b/Q.txt",
    "--- a/Q.txt",
    "+++ b/Q.txt",
    "@@ -1,5 +1,5 @@",
    " q1",
    " q2",
    "-q3",
    "+qX",
    " q4",
    " q5",
    "",
  ].join("\n");
  const got = extractUnifiedDiff(plain);
  assert.equal(got.kind, "diff");
  assert.equal(hunks(got.body), 2, "both files must survive without `diff --git` anchors");
  // The scan anchors on the first `--- a/`, so GNU diff's leading command line is
  // not part of the body; everything from there on must be, including the second
  // file's own `diff -ur` line.
  assert.equal(got.body, plain.slice(plain.indexOf("--- a/P.txt")));
  assert.match(got.body, /^diff -ur a\/Q\.txt b\/Q\.txt$/m);
});

test("a `-- ` deletion in a non-final file does not end the scan", () => {
  // Deleting a SQL comment emits `--- header one`, textually a file header. Only
  // the ordered `--- `/`+++ `/`@@ ` triple may end a hunk body.
  const sql = [
    "diff --git a/q1.sql b/q1.sql",
    "index b331c9a..38df91f 100644",
    "--- a/q1.sql",
    "+++ b/q1.sql",
    "@@ -1,4 +1,3 @@",
    "--- header one",
    " SELECT 1;",
    " -- tail",
    " SELECT 2;",
    "diff --git a/q2.sql b/q2.sql",
    "index d5e62db..0094d11 100644",
    "--- a/q2.sql",
    "+++ b/q2.sql",
    "@@ -1,4 +1,3 @@",
    "--- header two",
    " SELECT 3;",
    " -- tail",
    " SELECT 4;",
    "",
  ].join("\n");
  const got = extractUnifiedDiff(sql);
  assert.equal(got.kind, "diff");
  assert.equal(fileSections(got.body), 2);
  assert.equal(got.body, sql);
});

test("git's extended headers (rename, similarity) do not end the scan", () => {
  const renamed = [
    "diff --git a/old.txt b/new.txt",
    "similarity index 100%",
    "rename from old.txt",
    "rename to new.txt",
    "diff --git a/other.txt b/other.txt",
    "index 6012f1a..bc72145 100644",
    "--- a/other.txt",
    "+++ b/other.txt",
    "@@ -1,5 +1,5 @@",
    " o1",
    "-o2",
    "+oX",
    " o3",
    " o4",
    " o5",
    "",
  ].join("\n");
  const got = extractUnifiedDiff(renamed);
  assert.equal(got.kind, "diff");
  assert.equal(fileSections(got.body), 2, "the rename section must not be dropped");
  assert.equal(got.body, renamed);
});

test("a GIT binary patch payload does not end the scan", () => {
  // base85 payload lines follow no diff grammar, so only a new file section or a
  // fence may end them.
  const binary = [
    "diff --git a/b.bin b/b.bin",
    "index ad32fd722a7060547d4811c0707ef1b7813f7d9e..2c04f638b174e811b72aaf44aa63c1ca1c170cb5 100644",
    "GIT binary patch",
    "literal 8",
    "PcmZSJ<X~rGWncsV0Kxzz",
    "",
    "literal 8",
    "PcmZQzWMXDvW#9w=08#)M",
    "",
    "diff --git a/t.txt b/t.txt",
    "index 7e63c67..3723432 100644",
    "--- a/t.txt",
    "+++ b/t.txt",
    "@@ -1,5 +1,5 @@",
    " t1",
    "-t2",
    "+tX",
    " t3",
    " t4",
    " t5",
    "",
  ].join("\n");
  const got = extractUnifiedDiff(binary);
  assert.equal(got.kind, "diff");
  assert.equal(fileSections(got.body), 2);
  assert.equal(got.body, binary);
});

test("a bare closing fence still terminates the raw scan", () => {
  const got = extractUnifiedDiff(THREE_FILE_DIFF + "```\ntrailing notes\n");
  assert.equal(got.kind, "diff");
  assert.equal(got.body.includes("```"), false, "the fence must not enter the patch");
  assert.equal(got.body.includes("trailing notes"), false);
  assert.equal(fileSections(got.body), 3);
});

// ---------------------------------------------------------------------------
// Byte fidelity. Extraction hands its result straight to `git apply`, so any
// byte it changes is a byte the model never wrote. CRLF is where that used to
// leak: the raw scan split on /\r?\n/ and rejoined with "\n", and the fenced
// pattern's `\r?\n` terminator ate the last line's own CR. A patch that only
// ADDS lines has no context to mismatch, so git applied the mangled bytes
// happily and committed a CRLF file rewritten as LF.
// ---------------------------------------------------------------------------

const CRLF_NEW_FILE = [
  "diff --git a/win.txt b/win.txt",
  "new file mode 100644",
  "index 0000000..2b31b2a",
  "--- /dev/null",
  "+++ b/win.txt",
  "@@ -0,0 +1,3 @@",
  "+w1\r",
  "+w2\r",
  "+w3\r",
  "",
].join("\n");

test("raw extraction preserves CRLF line endings byte for byte", () => {
  const got = extractUnifiedDiff(CRLF_NEW_FILE);
  assert.equal(got.kind, "diff");
  assert.equal((got.body.match(/\r/g) ?? []).length, 3, "no CR may be dropped");
  assert.equal(got.body, CRLF_NEW_FILE);
});

test("fenced extraction preserves the CR of the last diff line", () => {
  const stdout = "Here is the patch.\n\n```diff\n" + CRLF_NEW_FILE.replace(/\n$/, "") + "\n```\n";
  const got = extractUnifiedDiff(stdout);
  assert.equal(got.kind, "diff");
  assert.equal((got.body.match(/\r/g) ?? []).length, 3, "the final line's CR must survive the fence terminator");
});

test("a fenced LF diff gains no stray CR", () => {
  const got = extractUnifiedDiff("```diff\n" + DIFF + "\n```\n");
  assert.equal(got.kind, "diff");
  assert.equal(got.body, DIFF);
  assert.equal(got.body.includes("\r"), false);
});

test("a truncation refusal inside a JSON envelope is not masked by a later field", () => {
  // Without propagation the walk treats the refusal as "no diff here", moves on
  // to `output`, and ships that field's single-file patch as if it were the
  // whole change — reintroducing the silent partial this guard exists to stop.
  const cut = THREE_FILE_DIFF.indexOf("diff --git a/B.txt");
  const stdout = JSON.stringify({
    type: "result",
    result: THREE_FILE_DIFF.slice(0, cut) + "Now the second file:\n" + THREE_FILE_DIFF.slice(cut),
    output: THREE_FILE_DIFF.slice(0, cut),
  });
  const got = extractUnifiedDiff(stdout);
  assert.equal(got.kind, "no_diff");
  assert.match(got.body, /refusing a partial patch/);
});
