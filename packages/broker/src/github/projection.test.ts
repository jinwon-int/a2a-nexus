import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { TaskRecord } from "../core/types.js";
import {
  MAX_GITHUB_COMMENT_LENGTH,
  projectStatusMarker,
  projectTaskComment,
  redactSensitive,
} from "./projection.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// #2256 A4 per-egress fixture: every GitHub egress point must scrub these and
// keep the 40-hex commit SHA. Token shapes are assembled at runtime so this
// file never carries a literal secret-scanner hit.
const EGRESS_SHA = "0123456789abcdef0123456789abcdef01234567";
const EGRESS_SK = ["sk", "proj", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6"].join("-");
const EGRESS_BEARER = "eyJhbGciOiJIUzI1NiJ9.payload.signature";
const EGRESS_ENV_VALUE = "env-secret-value-123";
const EGRESS_TOKEN_VALUE = "tok-secret-value-456";
const EGRESS_LINES = [
  `key ${EGRESS_SK}`,
  `Authorization: Bearer ${EGRESS_BEARER}`,
  `OPENAI_API_KEY=${EGRESS_ENV_VALUE}`,
  `token=${EGRESS_TOKEN_VALUE}`,
  "log at /home/alice/.ssh/id_ed25519 and /root/.openclaw/agents/main/session.json",
  `commit ${EGRESS_SHA}`,
];

function assertEgressRedacted(text: string): void {
  for (const leak of [EGRESS_SK, EGRESS_BEARER, EGRESS_ENV_VALUE, EGRESS_TOKEN_VALUE, "/home/alice", "/root/.openclaw"]) {
    assert.equal(text.includes(leak), false, `${leak} leaked: ${text}`);
  }
  assert.match(text, /<redacted-api-key>/);
  assert.match(text, /<redacted-private-path>/);
  assert.ok(text.includes(EGRESS_SHA), `commit SHA must survive: ${text}`);
}

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-1",
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    targetNodeId: "worker-a",
    assignedWorkerId: "worker-a",
    payload: {
      githubRepo: "acme/platform",
      githubIssueNumber: 7,
      githubWorkMode: "github",
    },
    artifactIds: [],
    status: "queued",
    createdAt: "2026-04-26T12:00:00Z",
    updatedAt: "2026-04-26T12:00:00Z",
    ...overrides,
  } as TaskRecord;
}

// ---------------------------------------------------------------------------
// projectStatusMarker
// ---------------------------------------------------------------------------

describe("projectStatusMarker", () => {
  it("returns null while the task is queued", () => {
    assert.equal(projectStatusMarker(makeTask({ status: "queued" })), null);
  });

  it("returns Start when the task is claimed or running", () => {
    assert.equal(projectStatusMarker(makeTask({ status: "claimed" })), "Start");
    assert.equal(projectStatusMarker(makeTask({ status: "running" })), "Start");
  });

  it("returns Done on success without a PR artifact", () => {
    assert.equal(
      projectStatusMarker(
        makeTask({
          status: "succeeded",
          result: { summary: "all good" },
        }),
      ),
      "Done",
    );
  });

  it("returns PR when the result references a github pull request", () => {
    const marker = projectStatusMarker(
      makeTask({
        status: "succeeded",
        result: {
          summary: "opened PR",
          output: {
            pullRequestUrl: "https://github.com/acme/platform/pull/42",
          },
        },
      }),
    );
    assert.equal(marker, "PR");
  });

  it("returns Block when the task fails or is canceled", () => {
    assert.equal(projectStatusMarker(makeTask({ status: "failed" })), "Block");
    assert.equal(
      projectStatusMarker(makeTask({ status: "canceled" })),
      "Block",
    );
  });
});

// ---------------------------------------------------------------------------
// projectTaskComment
// ---------------------------------------------------------------------------

describe("projectTaskComment", () => {
  it("returns null when there is no marker yet", () => {
    assert.equal(projectTaskComment(makeTask({ status: "queued" })), null);
  });

  it("renders a comment body that includes the marker and task id", () => {
    const projection = projectTaskComment(makeTask({ status: "running" }));
    assert.ok(projection);
    assert.equal(projection!.marker, "Start");
    assert.match(projection!.body, /Start/);
    assert.match(projection!.body, /task-1/);
  });

  it("includes the PR URL on a PR marker", () => {
    const projection = projectTaskComment(
      makeTask({
        status: "succeeded",
        result: {
          summary: "ready for review",
          output: {
            pullRequestUrl: "https://github.com/acme/platform/pull/42",
          },
        },
      }),
    );
    assert.ok(projection);
    assert.equal(projection!.marker, "PR");
    assert.match(
      projection!.body,
      /https:\/\/github\.com\/acme\/platform\/pull\/42/,
    );
  });

  it("includes the failure reason on a Block marker", () => {
    const projection = projectTaskComment(
      makeTask({
        status: "failed",
        error: { code: "exec_error", message: "tests failed" },
      }),
    );
    assert.ok(projection);
    assert.equal(projection!.marker, "Block");
    assert.match(projection!.body, /tests failed/);
  });

  it("truncates a very long body to the comment length limit", () => {
    const huge = "x".repeat(MAX_GITHUB_COMMENT_LENGTH * 2);
    const projection = projectTaskComment(
      makeTask({
        status: "succeeded",
        result: { summary: huge },
      }),
    );
    assert.ok(projection);
    assert.ok(projection!.body.length <= MAX_GITHUB_COMMENT_LENGTH);
    assert.match(projection!.body, /truncated/i);
  });

  it("redacts sensitive values from the rendered body", () => {
    const fixtureToken = ["ghp", "abcdef0123456789ABCDEF0123"].join("_");
    const projection = projectTaskComment(
      makeTask({
        status: "succeeded",
        result: {
          summary: "see output",
          output: {
            apiToken: fixtureToken,
            details: `token is ${fixtureToken} keep secret`,
          },
        },
      }),
    );
    assert.ok(projection);
    assert.doesNotMatch(projection!.body, /ghp_[A-Za-z0-9]+/);
    assert.match(projection!.body, /\[REDACTED\]/);
  });
});

// ---------------------------------------------------------------------------
// redactSensitive
// ---------------------------------------------------------------------------

describe("redactSensitive", () => {
  it("redacts string values whose key matches a sensitive pattern", () => {
    const out = redactSensitive({ token: "abc", apiKey: "xyz", message: "hi" });
    assert.deepEqual(out, {
      token: "[REDACTED]",
      apiKey: "[REDACTED]",
      message: "hi",
    });
  });

  it("redacts known token-like values regardless of key", () => {
    const fixtureToken = ["ghp", "abcdef0123456789ABCDEF0123"].join("_");
    const out = redactSensitive({
      details: `use ${fixtureToken} to authenticate`,
    });
    assert.equal(
      (out as { details: string }).details.includes("ghp_"),
      false,
    );
    assert.match((out as { details: string }).details, /<redacted-github-token>/);
  });

  it("#2256 A4: string values get the full broker secret redactor, commit SHAs survive", () => {
    const sk = ["sk", "live0123456789abcdefghijklmnopqrstuv"].join("-");
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const out = redactSensitive({
      details: `Authorization: Bearer abc.def.ghi\nOPENAI key ${sk}\nMY_API_KEY=supersecretvalue\ncommit ${sha}\nping telegram:-1001234567890`,
    }) as { details: string };
    assert.equal(out.details.includes("abc.def.ghi"), false);
    assert.equal(out.details.includes(sk), false);
    assert.equal(out.details.includes("supersecretvalue"), false);
    assert.equal(out.details.includes("-1001234567890"), false);
    assert.ok(out.details.includes(sha), "40-hex commit SHAs are evidence and must survive");
  });

  it("recurses into nested objects and arrays", () => {
    const out = redactSensitive({
      nested: { secret: "abc", values: [{ password: "p" }, "ok"] },
    });
    const nested = (out as { nested: Record<string, unknown> }).nested;
    assert.equal(nested.secret, "[REDACTED]");
    const values = nested.values as Array<Record<string, string> | string>;
    assert.equal((values[0] as Record<string, string>).password, "[REDACTED]");
    assert.equal(values[1], "ok");
  });

  it("returns primitives unchanged when not sensitive", () => {
    assert.equal(redactSensitive("plain"), "plain");
    assert.equal(redactSensitive(42), 42);
    assert.equal(redactSensitive(null), null);
  });
});

describe("#2256 A4 projection egress fixture", () => {
  it("redacts sk-/Bearer/KEY=value/token=/private paths in Block and Done bodies, keeps the SHA", () => {
    const text = EGRESS_LINES.join("\n");
    const block = projectTaskComment(makeTask({ status: "failed", error: { code: "exec_error", message: text } }));
    const done = projectTaskComment(makeTask({ status: "succeeded", result: { summary: text, output: { log: text } } }));
    assert.ok(block && done);
    assertEgressRedacted(block.body);
    assertEgressRedacted(done.body);
  });
});
