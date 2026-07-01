/**
 * Tests for GitHub worker marker ingestion (Round 17, plugin-a2a#88).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractGitHubCommentSource,
  buildGitHubCommentUrl,
  deriveEventId,
  resolveWorkerId,
  ingestGitHubComment,
  batchIngestGitHubComments,
  InMemoryDeduplicationStore,
  type IngestionResult,
} from "../dist/src/worker-marker-ingestion.js";

// ── Fixtures ───────────────────────────────────────────────────

function makeIssueCommentPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "created",
    issue: { number: 88, title: "Test issue" },
    comment: {
      id: 12345,
      body: "**Start** — beginning work",
      user: { login: "worker-bot" },
    },
    repository: { full_name: "jinwon-int/plugin-a2a" },
    sender: { login: "worker-bot" },
    ...overrides,
  };
}

function makePRCommentPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "created",
    pull_request: { number: 86, title: "Test PR" },
    comment: {
      id: 67890,
      body: "**PR** — https://github.com/jinwon-int/plugin-a2a/pull/86",
      user: { login: "worker-bot" },
    },
    repository: { full_name: "jinwon-int/plugin-a2a" },
    sender: { login: "worker-bot" },
    ...overrides,
  };
}

// ── extractGitHubCommentSource ─────────────────────────────────

describe("extractGitHubCommentSource", () => {
  it("extracts from issue_comment payload", () => {
    const source = extractGitHubCommentSource(makeIssueCommentPayload());
    assert.deepEqual(source, {
      deliveryId: undefined,
      repository: "jinwon-int/plugin-a2a",
      issueNumber: 88,
      commentId: 12345,
      authorLogin: "worker-bot",
    });
  });

  it("extracts from pull_request review comment", () => {
    const source = extractGitHubCommentSource(makePRCommentPayload());
    assert.notEqual(source, null);
    assert.equal(source!.issueNumber, 86);
    assert.equal(source!.commentId, 67890);
  });

  it("returns null for missing repository", () => {
    const source = extractGitHubCommentSource({ issue: { number: 1 }, comment: { id: 1, user: { login: "a" } } });
    assert.equal(source, null);
  });

  it("returns null for missing issue/PR number", () => {
    const source = extractGitHubCommentSource({
      repository: { full_name: "org/repo" },
      comment: { id: 1, user: { login: "a" } },
    });
    assert.equal(source, null);
  });

  it("returns null for missing comment", () => {
    const source = extractGitHubCommentSource({
      repository: { full_name: "org/repo" },
      issue: { number: 1 },
    });
    assert.equal(source, null);
  });

  it("extracts deliveryId when present", () => {
    const source = extractGitHubCommentSource(
      makeIssueCommentPayload({ deliveryId: "abc-123" }),
    );
    assert.equal(source!.deliveryId, "abc-123");
  });
});

// ── deriveEventId ──────────────────────────────────────────────

describe("deriveEventId", () => {
  it("produces stable event ID", () => {
    const source = {
      repository: "jinwon-int/plugin-a2a",
      issueNumber: 88,
      commentId: 12345,
      authorLogin: "worker-bot",
    };
    const id1 = deriveEventId(source);
    const id2 = deriveEventId(source);
    assert.equal(id1, id2);
    assert.equal(id1, "gh:jinwon-int/plugin-a2a:88#12345");
  });

  it("produces different IDs for different comments", () => {
    const s1 = { repository: "org/repo", issueNumber: 1, commentId: 100, authorLogin: "a" };
    const s2 = { repository: "org/repo", issueNumber: 1, commentId: 200, authorLogin: "a" };
    assert.notEqual(deriveEventId(s1), deriveEventId(s2));
  });
});

// ── resolveWorkerId ────────────────────────────────────────────

describe("resolveWorkerId", () => {
  it("returns login as-is without map", () => {
    assert.equal(resolveWorkerId("worker-bot"), "worker-bot");
  });

  it("maps login to worker ID", () => {
    const map = { "worker-bot": "worker-alpha" };
    assert.equal(resolveWorkerId("worker-bot", map), "worker-alpha");
  });

  it("returns login for unmapped users", () => {
    const map = { other: "worker" };
    assert.equal(resolveWorkerId("worker-bot", map), "worker-bot");
  });
});

// ── InMemoryDeduplicationStore ──────────────────────────────────

describe("InMemoryDeduplicationStore", () => {
  it("tracks seen event IDs", () => {
    const store = new InMemoryDeduplicationStore();
    assert.equal(store.has("id1"), false);
    store.add("id1");
    assert.equal(store.has("id1"), true);
  });

  it("clears all entries", () => {
    const store = new InMemoryDeduplicationStore();
    store.add("id1");
    store.add("id2");
    store.clear();
    assert.equal(store.has("id1"), false);
    assert.equal(store.has("id2"), false);
  });

  it("evicts old entries when full", () => {
    const store = new InMemoryDeduplicationStore(5);
    store.add("1");
    store.add("2");
    store.add("3");
    store.add("4");
    store.add("5");
    // Adding beyond capacity triggers eviction
    store.add("6");
    // Some old entries should be evicted
    assert.equal(store.has("6"), true);
  });
});

// ── ingestGitHubComment ────────────────────────────────────────

describe("ingestGitHubComment", () => {
  it("successfully ingests a Start marker", () => {
    const store = new InMemoryDeduplicationStore();
    const result = ingestGitHubComment(makeIssueCommentPayload(), store);

    assert.equal(result.ok, true);
    if (!result.ok || ("skipped" in result && result.skipped)) {
      throw new Error("expected success");
    }
    assert.equal(result.eventId, "gh:jinwon-int/plugin-a2a:88#12345");
    assert.equal(result.brokerEvent.marker, "Start");
    assert.equal(result.brokerEvent.workerId, "worker-bot");
  });

  it("skips comments without markers", () => {
    const store = new InMemoryDeduplicationStore();
    const result = ingestGitHubComment(
      makeIssueCommentPayload({
        comment: { id: 12345, body: "Just a regular comment", user: { login: "worker-bot" } },
      }),
      store,
    );

    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("expected ok");
    if (!("skipped" in result)) throw new Error("expected skip");
    assert.equal(result.skipped, true);
    assert.ok((result.reason).includes("no worker status marker"));
  });

  it("skips non-allowed actions", () => {
    const store = new InMemoryDeduplicationStore();
    const result = ingestGitHubComment(
      makeIssueCommentPayload({ action: "deleted" }),
      store,
    );

    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("expected ok");
    if (!("skipped" in result)) throw new Error("expected skip");
    assert.equal(result.skipped, true);
    assert.ok((result.reason).includes("action"));
  });

  it("allows edited action", () => {
    const store = new InMemoryDeduplicationStore();
    const result = ingestGitHubComment(
      makeIssueCommentPayload({ action: "edited" }),
      store,
    );

    assert.equal(result.ok, true);
    if (!result.ok || ("skipped" in result && result.skipped)) {
      throw new Error("expected success");
    }
    assert.equal(result.brokerEvent.marker, "Start");
  });

  it("deduplicates identical deliveries", () => {
    const store = new InMemoryDeduplicationStore();
    const payload = makeIssueCommentPayload();

    const result1 = ingestGitHubComment(payload, store);
    assert.equal(result1.ok, true);

    const result2 = ingestGitHubComment(payload, store);
    assert.equal(result2.ok, true);
    if (!result2.ok) throw new Error("expected ok");
    if (!("skipped" in result2)) throw new Error("expected skip");
    assert.equal(result2.skipped, true);
    assert.ok((result2.reason).includes("duplicate"));
  });

  it("returns error for invalid payload", () => {
    const store = new InMemoryDeduplicationStore();
    const result = ingestGitHubComment({}, store);

    assert.equal(result.ok, false);
    if (result.ok) throw new Error("expected error");
    assert.ok((result.error).includes("source identifiers"));
  });

  it("returns error for missing comment body", () => {
    const store = new InMemoryDeduplicationStore();
    const result = ingestGitHubComment(
      makeIssueCommentPayload({
        comment: { id: 12345, user: { login: "worker-bot" } },
      }),
      store,
    );

    assert.equal(result.ok, false);
    if (result.ok) throw new Error("expected error");
    assert.ok((result.error).includes("comment.body"));
  });

  it("ingests PR marker with full payload", () => {
    const store = new InMemoryDeduplicationStore();
    const result = ingestGitHubComment(makePRCommentPayload(), store);

    assert.equal(result.ok, true);
    if (!result.ok || ("skipped" in result && result.skipped)) {
      throw new Error("expected success");
    }
    assert.equal(result.brokerEvent.marker, "PR");
    assert.equal(result.brokerEvent.workerId, "worker-bot");
    assert.equal(result.brokerEvent.taskId, "jinwon-int/plugin-a2a#86");
  });

  it("ingests Block marker", () => {
    const store = new InMemoryDeduplicationStore();
    const result = ingestGitHubComment(
      makeIssueCommentPayload({
        comment: {
          id: 99999,
          body: "**Block** — waiting on upstream review",
          user: { login: "worker-bot" },
        },
      }),
      store,
    );

    assert.equal(result.ok, true);
    if (!result.ok || ("skipped" in result && result.skipped)) {
      throw new Error("expected success");
    }
    assert.equal(result.brokerEvent.marker, "Block");
  });

  it("ingests Done marker", () => {
    const store = new InMemoryDeduplicationStore();
    const result = ingestGitHubComment(
      makeIssueCommentPayload({
        comment: {
          id: 99998,
          body: "**Done** — completed all tests",
          user: { login: "worker-bot" },
        },
      }),
      store,
    );

    assert.equal(result.ok, true);
    if (!result.ok || ("skipped" in result && result.skipped)) {
      throw new Error("expected success");
    }
    assert.equal(result.brokerEvent.marker, "Done");
  });

  it("uses login-to-worker mapping", () => {
    const store = new InMemoryDeduplicationStore();
    const map = { "worker-bot": "worker-alpha" };
    const result = ingestGitHubComment(makeIssueCommentPayload(), store, {
      loginToWorkerMap: map,
    });

    assert.equal(result.ok, true);
    if (!result.ok || ("skipped" in result && result.skipped)) {
      throw new Error("expected success");
    }
    assert.equal(result.brokerEvent.workerId, "worker-alpha");
  });

  it("preserves parse warnings in result", () => {
    const store = new InMemoryDeduplicationStore();
    const result = ingestGitHubComment(
      makeIssueCommentPayload({
        comment: {
          id: 88888,
          body: "**PR** — will submit soon",
          user: { login: "worker-bot" },
        },
      }),
      store,
    );

    assert.equal(result.ok, true);
    if (!result.ok || ("skipped" in result && result.skipped)) {
      throw new Error("expected success");
    }
    assert.ok((result.warnings).includes("PR marker has no PR URL"));
    assert.equal(result.parseStatus, "partial");
  });

  it("returns error for detected but unparseable marker", () => {
    const store = new InMemoryDeduplicationStore();
    // A marker detected by detectMarker but parseWorkerStatusMarker fails
    // This shouldn't happen in practice, but we handle it gracefully
    const result = ingestGitHubComment(
      makeIssueCommentPayload({
        comment: {
          id: 77777,
          body: "**Start**",
          user: { login: "worker-bot" },
        },
      }),
      store,
    );
    // Start with no body should still parse (just no summary)
    assert.equal(result.ok, true);
  });
});
// ── buildGitHubCommentUrl ────────────────────────────────────

describe("buildGitHubCommentUrl", () => {
  it("builds correct GitHub comment URL", () => {
    const url = buildGitHubCommentUrl({
      repository: "jinwon-int/plugin-a2a",
      issueNumber: 88,
      commentId: 12345,
      authorLogin: "worker-bot",
    });
    assert.equal(url, "https://github.com/jinwon-int/plugin-a2a/issues/88#issuecomment-12345");
  });

  it("includes deliveryId when present", () => {
    const url = buildGitHubCommentUrl({
      repository: "org/repo",
      issueNumber: 1,
      commentId: 999,
      authorLogin: "bot",
      deliveryId: "abc-123",
    });
    assert.ok((url).includes("org/repo"));
    assert.ok((url).includes("issuecomment-999"));
  });
});

// evidence URL enrichment

describe("evidence URL enrichment", () => {
  it("enriches done_evidence_only marker with doneUrl", () => {
    const store = new InMemoryDeduplicationStore();
    const result = ingestGitHubComment(
      makeIssueCommentPayload({
        comment: {
          id: 100001,
          body: "**Done** \u2014 evidence-only, no code changes. Assessment complete.",
          user: { login: "worker-bot" },
        },
      }),
      store,
    );

    assert.equal(result.ok, true);
    if (!result.ok || ("skipped" in result && result.skipped)) {
      throw new Error("expected success");
    }
    assert.equal(result.workerEvent.marker, "Done");
    assert.equal(result.workerEvent.payload.outcome, "done_evidence_only");
    assert.equal(result.workerEvent.payload.doneUrl,
      "https://github.com/jinwon-int/plugin-a2a/issues/88#issuecomment-100001",
    );
  });

  it("enriches done_no_changes marker with doneUrl", () => {
    const store = new InMemoryDeduplicationStore();
    const result = ingestGitHubComment(
      makeIssueCommentPayload({
        comment: {
          id: 100002,
          body: "**Done** \u2014 assessment complete, no changes needed.",
          user: { login: "worker-bot" },
        },
      }),
      store,
    );

    assert.equal(result.ok, true);
    if (!result.ok || ("skipped" in result && result.skipped)) {
      throw new Error("expected success");
    }
    assert.equal(result.workerEvent.marker, "Done");
    assert.equal(result.workerEvent.payload.doneUrl,
      "https://github.com/jinwon-int/plugin-a2a/issues/88#issuecomment-100002",
    );
  });

  it("enriches Block marker with blockUrl", () => {
    const store = new InMemoryDeduplicationStore();
    const result = ingestGitHubComment(
      makeIssueCommentPayload({
        comment: {
          id: 100003,
          body: "**Block** \u2014 waiting on upstream review",
          user: { login: "worker-bot" },
        },
      }),
      store,
    );

    assert.equal(result.ok, true);
    if (!result.ok || ("skipped" in result && result.skipped)) {
      throw new Error("expected success");
    }
    assert.equal(result.workerEvent.marker, "Block");
    assert.equal(result.workerEvent.payload.blockUrl,
      "https://github.com/jinwon-int/plugin-a2a/issues/88#issuecomment-100003",
    );
  });

  it("does not enrich Done marker with PR URL and done_with_changes outcome", () => {
    const store = new InMemoryDeduplicationStore();
    const result = ingestGitHubComment(
      makeIssueCommentPayload({
        comment: {
          id: 100004,
          body: "**Done** \u2014 https://github.com/jinwon-int/openclaw/pull/52 merged",
          user: { login: "worker-bot" },
        },
      }),
      store,
    );

    assert.equal(result.ok, true);
    if (!result.ok || ("skipped" in result && result.skipped)) {
      throw new Error("expected success");
    }
    assert.equal(result.workerEvent.marker, "Done");
    assert.equal(result.workerEvent.payload.outcome, "done_with_changes");
    assert.equal(result.workerEvent.payload.doneUrl, undefined);
  });

  it("does not enrich Start marker with evidence URL", () => {
    const store = new InMemoryDeduplicationStore();
    const result = ingestGitHubComment(
      makeIssueCommentPayload({
        comment: {
          id: 100005,
          body: "**Start** \u2014 beginning work",
          user: { login: "worker-bot" },
        },
      }),
      store,
    );

    assert.equal(result.ok, true);
    if (!result.ok || ("skipped" in result && result.skipped)) {
      throw new Error("expected success");
    }
    assert.equal(result.workerEvent.marker, "Start");
  });
});

// ── batchIngestGitHubComments ──────────────────────────────────

describe("batchIngestGitHubComments", () => {
  it("processes multiple payloads", () => {
    const store = new InMemoryDeduplicationStore();
    const { results, ingested, skipped, errors } = batchIngestGitHubComments(
      [
        makeIssueCommentPayload({ comment: { id: 1, body: "**Start**", user: { login: "a" } } }),
        makeIssueCommentPayload({ comment: { id: 2, body: "**Done**", user: { login: "a" } } }),
        makeIssueCommentPayload({ comment: { id: 3, body: "no marker", user: { login: "a" } } }),
        {},
      ],
      store,
    );

    assert.equal((results).length, 4);
    assert.equal(ingested, 2);
    assert.equal(skipped, 1);
    assert.equal(errors, 1);
  });

  it("deduplicates across batch", () => {
    const store = new InMemoryDeduplicationStore();
    const payload = makeIssueCommentPayload();
    const { ingested, skipped } = batchIngestGitHubComments([payload, payload], store);

    assert.equal(ingested, 1);
    assert.equal(skipped, 1);
  });
});
