import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import {
  EXIT,
  SNAPSHOT_KIND,
  buildSnapshot,
  extractShadow,
  main,
  parseArgs,
} from "./shared-state-shadow-snapshot.mjs";

const STARTED = Date.parse("2026-09-26T03:15:42.531+09:00");
const NOW = STARTED + 6 * 3_600_000;
const SECRET = "edge-secret-value-must-never-leak-7f3a";

function family(compared, unexplained = 0, warmupMismatches = 0) {
  return { compared, matches: compared - unexplained - warmupMismatches, warmupMismatches, unexplained };
}

function healthBody(overrides = {}) {
  return {
    status: "ok",
    // Fields that must never reach the snapshot.
    workers: [{ nodeId: "bangtong", token: "worker-token" }],
    replay: { nonces: ["n-1", "n-2"] },
    stateShadow: {
      startedAtUnixMs: STARTED,
      replay: family(5488),
      rate: family(14905),
      extraSecretishField: "nonce-abc",
      ...overrides,
    },
  };
}

function sink() {
  let text = "";
  return { write: (chunk) => { text += chunk; return true; }, get text() { return text; } };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "shadow-snapshot-"));
}

function fakeFetch(body, { status = 200, seen = [] } = {}) {
  return async (url, init) => {
    seen.push({ url: String(url), headers: { ...init.headers } });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
}

describe("extractShadow", () => {
  it("keeps only allowlisted aggregate counters", () => {
    const r = extractShadow(healthBody());
    assert.equal(r.ok, true);
    assert.deepEqual(Object.keys(r.shadow).sort(), ["rate", "replay", "startedAtUnixMs"]);
    assert.deepEqual(Object.keys(r.shadow.replay).sort(), ["compared", "matches", "unexplained", "warmupMismatches"]);
    assert.equal(JSON.stringify(r).includes("nonce-abc"), false);
  });

  it("reports an absent stateShadow block (shadow flag off / old build)", () => {
    const body = healthBody();
    delete body.stateShadow;
    assert.deepEqual(extractShadow(body), { ok: false, reason: "state-shadow-absent" });
  });

  it("rejects non-integer, negative, and missing counters", () => {
    assert.equal(extractShadow(healthBody({ replay: { ...family(3), matches: 2.5 } })).reason, "replay.matches-invalid");
    assert.equal(extractShadow(healthBody({ rate: { ...family(3), unexplained: -1 } })).reason, "rate.unexplained-invalid");
    assert.equal(extractShadow(healthBody({ rate: undefined })).reason, "rate-missing");
    assert.equal(extractShadow(healthBody({ startedAtUnixMs: "x" })).reason, "started-at-invalid");
  });

  it("rejects counters that break compared = matches + warmupMismatches + unexplained", () => {
    const r = extractShadow(healthBody({ replay: { compared: 10, matches: 9, warmupMismatches: 0, unexplained: 0 } }));
    assert.deepEqual(r, { ok: false, reason: "replay-counters-inconsistent" });
  });
});

describe("buildSnapshot verdicts", () => {
  const source = { mode: "input" };

  it("pass when both families have zero unexplained (warm-up mismatches allowed)", () => {
    const { doc, exitCode } = buildSnapshot({
      body: healthBody({ replay: family(100, 0, 3) }), capturedAtMs: NOW, label: "pre-phase7-replay", source,
    });
    assert.equal(exitCode, EXIT.pass);
    assert.equal(doc.kind, SNAPSHOT_KIND);
    assert.equal(doc.verdict, "pass");
    assert.equal(doc.label, "pre-phase7-replay");
    assert.equal(doc.window.durationMs, 6 * 3_600_000);
    assert.equal(doc.window.startedAt, new Date(STARTED).toISOString());
  });

  it("unexplained (exit 2) when either family has an unexplained observation", () => {
    const { doc, exitCode } = buildSnapshot({ body: healthBody({ rate: family(50, 1) }), capturedAtMs: NOW, source });
    assert.equal(exitCode, EXIT.unexplained);
    assert.equal(doc.verdict, "unexplained");
  });

  it("no-evidence (exit 3) carries only the reason, never partial counters", () => {
    const { doc, exitCode } = buildSnapshot({ body: { status: "ok" }, capturedAtMs: NOW, source });
    assert.equal(exitCode, EXIT.noEvidence);
    assert.equal(doc.verdict, "no-evidence");
    assert.equal(doc.stateShadow, undefined);
  });
});

describe("parseArgs", () => {
  it("refuses the edge secret on argv", () => {
    assert.throws(() => parseArgs(["--stdout", "--edge-secret", SECRET]), /environment/);
    assert.throws(() => parseArgs(["--stdout", `--edge-secret=${SECRET}`]), /environment/);
  });

  it("requires exactly one of --out / --stdout and rejects credentialed URLs", () => {
    assert.throws(() => parseArgs([]), /--out/);
    assert.throws(() => parseArgs(["--stdout", "--out", "x"]), /mutually exclusive/);
    assert.throws(() => parseArgs(["--stdout", "--base-url", "http://u:p@127.0.0.1:8787"]), /credentials/);
    assert.throws(() => parseArgs(["--stdout", "--bogus"]), /unknown argument/);
  });
});

describe("main (live fetch path)", () => {
  it("sends the env edge secret as a header but never prints or writes it", async () => {
    const dir = tmpDir();
    const out = path.join(dir, "evidence", "snap.json");
    const seen = [];
    const stdout = sink();
    const stderr = sink();
    const code = await main(["--out", out, "--label", "pre-phase7-replay"], {
      env: { EDGE_SECRET: SECRET }, fetchImpl: fakeFetch(healthBody(), { seen }), stdout, stderr, now: () => NOW,
    });
    assert.equal(code, EXIT.pass);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "http://127.0.0.1:8787/health");
    assert.equal(seen[0].headers["x-a2a-edge-secret"], SECRET);

    const written = fs.readFileSync(out, "utf8");
    for (const text of [written, stdout.text, stderr.text]) {
      assert.equal(text.includes(SECRET), false);
      assert.equal(text.includes("worker-token"), false);
      assert.equal(text.includes("n-1"), false);
    }
    assert.equal(fs.statSync(out).mode & 0o777, 0o600);
    const doc = JSON.parse(written);
    assert.deepEqual(doc.source, { mode: "live", origin: "http://127.0.0.1:8787" });
    assert.match(stderr.text, /state-shadow-snapshot: pass .* replay=5488\/5488 unexplained=0 rate=14905\/14905 unexplained=0/);
  });

  it("never overwrites an existing evidence file", async () => {
    const dir = tmpDir();
    const out = path.join(dir, "snap.json");
    fs.writeFileSync(out, "earlier evidence\n");
    const stderr = sink();
    const code = await main(["--out", out], {
      env: {}, fetchImpl: fakeFetch(healthBody()), stdout: sink(), stderr, now: () => NOW,
    });
    assert.equal(code, EXIT.noEvidence);
    assert.equal(fs.readFileSync(out, "utf8"), "earlier evidence\n");
    assert.match(stderr.text, /EEXIST/);
  });

  it("records no-evidence on an HTTP error without leaking the secret", async () => {
    const dir = tmpDir();
    const out = path.join(dir, "snap.json");
    const stderr = sink();
    const code = await main(["--out", out], {
      env: { A2A_EDGE_SECRET: SECRET }, fetchImpl: fakeFetch({}, { status: 401 }), stdout: sink(), stderr, now: () => NOW,
    });
    assert.equal(code, EXIT.noEvidence);
    const doc = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.equal(doc.verdict, "no-evidence");
    assert.equal(doc.reason, "health-read-failed");
    assert.match(stderr.text, /HTTP 401/);
    assert.equal(stderr.text.includes(SECRET), false);
  });
});

describe("main (--input path)", () => {
  it("reads a saved /health body from stdin and prints the snapshot", async () => {
    const stdout = sink();
    const code = await main(["--input", "-", "--stdout"], {
      env: {}, fetchImpl: () => { throw new Error("must not fetch"); },
      stdin: Readable.from([JSON.stringify(healthBody({ replay: family(9, 2) }))]),
      stdout, stderr: sink(), now: () => NOW,
    });
    assert.equal(code, EXIT.unexplained);
    const doc = JSON.parse(stdout.text);
    assert.deepEqual(doc.source, { mode: "input" });
    assert.equal(doc.stateShadow.replay.unexplained, 2);
  });

  it("usage error exit 64 for bad arguments", async () => {
    const stderr = sink();
    assert.equal(await main(["--timeout", "0", "--stdout"], { stderr, stdout: sink() }), EXIT.usage);
    assert.match(stderr.text, /usage:/);
  });
});
