/**
 * Auth-rejection observability unit coverage (#1764).
 *
 * The load-bearing test here is the last one: it scans the source tree for
 * statically-worded `unauthorized` throws and fails when one stops classifying.
 * Without it the message map silently rots the first time someone rewords a
 * throw, and the observability regresses back to the 22-hour blind spot the
 * issue was filed for.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AUTH_REJECTION_LOG_INTERVAL_MS,
  AUTH_REJECTION_MAX_KEYS,
  AUTH_REJECTION_REASONS,
  authRejectionSnapshot,
  classifyAuthRejection,
  recordAuthRejection,
  resetAuthRejectionMetrics,
} from "./auth-rejection-metrics.js";

/**
 * Resolve `packages/broker/src` regardless of how this suite is executed. CI
 * runs the COMPILED copy (`dist/*.test.js`, see the broker test manifest), where
 * `import.meta.url` points at `dist/` and no `.ts` file exists — walking up to
 * the package root keeps the drift guard scanning real sources in both modes.
 */
function resolveSrcDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "src"))) {
      return join(dir, "src");
    }
    dir = resolve(dir, "..");
  }
  throw new Error("could not locate packages/broker/src from the test file location");
}

const srcDir = resolveSrcDir();

test("classifies the edge-secret rejection that caused the 22-hour blind spot (#1764)", () => {
  const { reason, subCode } = classifyAuthRejection("x-a2a-edge-secret is required for this route");
  assert.equal(reason, "edge_secret_missing_or_invalid");
  assert.equal(subCode, undefined);
});

test("collapses the signature family into one reason but keeps the specific code", () => {
  for (const code of [
    "a2a_signature_unknown_key",
    "a2a_signature_key_revoked",
    "a2a_signature_time_invalid",
    "a2a_signature_replay_detected",
    "a2a_signature_digest_mismatch",
    "a2a_signature_required",
  ]) {
    const result = classifyAuthRejection(`${code}: some human readable detail`);
    assert.equal(result.reason, "a2a_signature_failed", code);
    assert.equal(result.subCode, code, code);
  }
});

test("distinguishes live-approval identity denial from malformed live-approval tokens", () => {
  assert.equal(classifyAuthRejection("invalid live approval token format").reason, "live_approval_invalid");
  assert.equal(classifyAuthRejection("live approval token signature mismatch").reason, "live_approval_invalid");
  assert.equal(
    classifyAuthRejection("live task requester identity mismatch").reason,
    "live_approval_identity_denied",
  );
  assert.equal(
    classifyAuthRejection("live task submission requires an authenticated operator or hub").reason,
    "live_approval_identity_denied",
  );
});

test("separates the two GitHub webhook HMAC failures", () => {
  assert.equal(
    classifyAuthRejection("x-hub-signature-256 is required for this route").reason,
    "github_webhook_signature_missing",
  );
  assert.equal(
    classifyAuthRejection("x-hub-signature-256 verification failed").reason,
    "github_webhook_signature_invalid",
  );
});

test("an unknown message degrades to unspecified rather than echoing itself", () => {
  const result = classifyAuthRejection("brand new rejection nobody mapped yet");
  assert.equal(result.reason, "unspecified");
  assert.equal(result.subCode, undefined);
  assert.ok(AUTH_REJECTION_REASONS.includes(result.reason));
});

test("a token-shaped prefix that is not a signature code is not treated as a sub-code", () => {
  // Guards against a future throw site interpolating attacker-influenced text
  // ahead of a colon and having it land in a counter key.
  const result = classifyAuthRejection("ghp_exampleexampleexample: nope");
  assert.equal(result.reason, "unspecified");
  assert.equal(result.subCode, undefined);
});

test("accumulates counts and rate limits logging per (route, reason)", () => {
  resetAuthRejectionMetrics();
  const base = 1_000_000;
  const first = recordAuthRejection({
    route: "workers.heartbeat",
    method: "POST",
    message: "x-a2a-edge-secret is required for this route",
    nowMs: base,
  });
  assert.equal(first.shouldLog, true, "first rejection of a key logs");
  assert.equal(first.count, 1);
  assert.equal(first.suppressedSinceLastLog, 0);

  for (let i = 1; i <= 5; i += 1) {
    const next = recordAuthRejection({
      route: "workers.heartbeat",
      method: "POST",
      message: "x-a2a-edge-secret is required for this route",
      nowMs: base + i * 1_000,
    });
    assert.equal(next.shouldLog, false, "within the interval the key stays quiet");
    assert.equal(next.count, i + 1);
  }

  const afterWindow = recordAuthRejection({
    route: "workers.heartbeat",
    method: "POST",
    message: "x-a2a-edge-secret is required for this route",
    nowMs: base + AUTH_REJECTION_LOG_INTERVAL_MS,
  });
  assert.equal(afterWindow.shouldLog, true, "logging resumes after the interval");
  assert.equal(afterWindow.suppressedSinceLastLog, 5, "and reports what it swallowed");
  assert.equal(afterWindow.count, 7);
});

test("a different reason on the same route is tracked and logged independently", () => {
  resetAuthRejectionMetrics();
  const base = 2_000_000;
  recordAuthRejection({
    route: "workers.heartbeat",
    method: "POST",
    message: "x-a2a-edge-secret is required for this route",
    nowMs: base,
  });
  const other = recordAuthRejection({
    route: "workers.heartbeat",
    method: "POST",
    message: "a2a_signature_key_revoked: key revoked",
    nowMs: base + 10,
  });
  assert.equal(other.shouldLog, true, "a distinct reason is not suppressed by its neighbour");
  assert.equal(other.reason, "a2a_signature_failed");
  assert.equal(other.subCode, "a2a_signature_key_revoked");
});

test("snapshot reports bounded aggregates and no raw message text", () => {
  resetAuthRejectionMetrics();
  const base = 3_000_000;
  recordAuthRejection({
    route: "workers.heartbeat",
    method: "POST",
    message: "x-a2a-edge-secret is required for this route",
    nowMs: base,
  });
  recordAuthRejection({
    route: "workers.heartbeat",
    method: "POST",
    message: "x-a2a-edge-secret is required for this route",
    nowMs: base + 5,
  });
  recordAuthRejection({
    route: "a2a.jsonrpc",
    method: "POST",
    message: "a2a_signature_time_invalid: clock skew",
    nowMs: base + 10,
  });

  const snapshot = authRejectionSnapshot();
  assert.equal(snapshot.total, 3);
  assert.equal(snapshot.trackedKeys, 2);
  assert.equal(snapshot.droppedKeys, 0);
  assert.equal(snapshot.byReason.edge_secret_missing_or_invalid, 2);
  assert.equal(snapshot.byReason.a2a_signature_failed, 1);
  assert.equal(snapshot.top[0]?.route, "workers.heartbeat");
  assert.equal(snapshot.top[0]?.count, 2);
  assert.match(snapshot.since ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(snapshot.top[1]?.subCodes?.a2a_signature_time_invalid, 1);

  const raw = JSON.stringify(snapshot);
  assert.equal(raw.includes("x-a2a-edge-secret is required"), false, "no raw message text in the snapshot");
  assert.equal(raw.includes("clock skew"), false, "no raw message text in the snapshot");
  for (const entry of snapshot.top) {
    assert.ok(AUTH_REJECTION_REASONS.includes(entry.reason));
  }
});

test("key growth is bounded and overflow is reported rather than silently dropped", () => {
  resetAuthRejectionMetrics();
  // Force the backstop by recording more distinct keys than the cap allows.
  // Route/reason are closed sets in production, so this is a guard against
  // future enum growth rather than a reachable state today.
  for (let i = 0; i < AUTH_REJECTION_MAX_KEYS + 25; i += 1) {
    recordAuthRejection({
      route: `synthetic-${i}` as never,
      method: "GET",
      message: "unmapped rejection",
      nowMs: 4_000_000 + i,
    });
  }
  const snapshot = authRejectionSnapshot();
  assert.equal(snapshot.trackedKeys, AUTH_REJECTION_MAX_KEYS, "tracked keys stay capped");
  assert.equal(snapshot.droppedKeys, 25, "overflow is counted, not hidden");
  assert.equal(snapshot.total, AUTH_REJECTION_MAX_KEYS + 25, "the total still counts every rejection");
  assert.ok(snapshot.top.length <= 10);
});

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, acc);
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) {
      acc.push(full);
    }
  }
  return acc;
}

test("every statically-worded unauthorized throw in the tree still classifies (#1764 drift guard)", () => {
  // Only static, developer-authored messages are checked. Template literals are
  // skipped: their leading value is dynamic, so they either carry a signature
  // code prefix (covered above) or legitimately fall back to `unspecified`.
  const pattern = /new BrokerError\(\s*"unauthorized"\s*,\s*"([^"\n]+)"/g;
  const unclassified: string[] = [];
  let examined = 0;

  for (const file of collectSourceFiles(srcDir)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(pattern)) {
      const message = match[1];
      if (!message) continue;
      examined += 1;
      if (classifyAuthRejection(message).reason === "unspecified") {
        const line = text.slice(0, match.index).split("\n").length;
        unclassified.push(`${file.slice(srcDir.length + 1)}:${line} -> ${message}`);
      }
    }
  }

  assert.ok(examined >= 15, `expected to find the known unauthorized throw sites, found ${examined}`);
  assert.deepEqual(
    unclassified,
    [],
    "these unauthorized throws no longer map to a reason; add them to STATIC_MESSAGE_REASONS "
      + "or give them an a2a_signature_* code prefix",
  );
});
