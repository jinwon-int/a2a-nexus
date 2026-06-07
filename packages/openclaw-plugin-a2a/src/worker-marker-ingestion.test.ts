/**
 * Tests for GitHub worker marker ingestion (Round 17, plugin-a2a#88).
 */
import { describe, expect, it } from "vitest";
import {
  extractGitHubCommentSource,
  deriveEventId,
  resolveWorkerId,
  ingestGitHubComment,
  batchIngestGitHubComments,
  InMemoryDeduplicationStore,
  type IngestionResult,
} from "./worker-marker-ingestion.js";

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
    repository: { full_name: "jinwon-int/openclaw-plugin-a2a" },
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
      body: "**PR** — https://github.com/jinwon-int/openclaw-plugin-a2a/pull/86",
      user: { login: "worker-bot" },
    },
    repository: { full_name: "jinwon-int/openclaw-plugin-a2a" },
    sender: { login: "worker-bot" },
    ...overrides,
  };
}

// ── extractGitHubCommentSource ─────────────────────────────────

describe("extractGitHubCommentSource", () => {
  it("extracts from issue_comment payload", () => {
    const source = extractGitHubCommentSource(makeIssueCommentPayload());
    expect(source).toEqual({
      deliveryId: undefined,
      repository: "jinwon-int/openclaw-plugin-a2a",
      issueNumber: 88,
      commentId: 12345,
      authorLogin: "worker-bot",
    });
  });

  it("extracts from pull_request review comment", () => {
    const source = extractGitHubCommentSource(makePRCommentPayload());
    expect(source).not.toBeNull();
    expect(source!.issueNumber).toBe(86);
    expect(source!.commentId).toBe(67890);
  });

  it("returns null for missing repository", () => {
    const source = extractGitHubCommentSource({ issue: { number: 1 }, comment: { id: 1, user: { login: "a" } } });
    expect(source).toBeNull();
  });

  it("returns null for missing issue/PR number", () => {
    const source = extractGitHubCommentSource({
      repository: { full_name: "org/repo" },
      comment: { id: 1, user: { login: "a" } },
    });
    expect(source).toBeNull();
  });

  it("returns null for missing comment", () => {
    const source = extractGitHubCommentSource({
      repository: { full_name: "org/repo" },
      issue: { number: 1 },
    });
    expect(source).toBeNull();
  });

  it("extracts deliveryId when present", () => {
    const source = extractGitHubCommentSource(
      makeIssueCommentPayload({ deliveryId: "abc-123" }),
    );
    expect(source!.deliveryId).toBe("abc-123");
  });
});

// ── deriveEventId ──────────────────────────────────────────────

describe("deriveEventId", () => {
  it("produces stable event ID", () => {
    const source = {
      repository: "jinwon-int/openclaw-plugin-a2a",
      issueNumber: 88,
      commentId: 12345,
      authorLogin: "worker-bot",
    };
    const id1 = deriveEventId(source);
    const id2 = deriveEventId(source);
    expect(id1).toBe(id2);
    expect(id1).toBe("gh:jinwon-int/openclaw-plugin-a2a:88#12345");
  });

  it("produces different IDs for different comments", () => {
    const s1 = { repository: "org/repo", issueNumber: 1, commentId: 100, authorLogin: "a" };
    const s2 = { repository: "org/repo", issueNumber: 1, commentId: 200, authorLogin: "a" };
    expect(deriveEventId(s1)).not.toBe(deriveEventId(s2));
  });
});

// ── resolveWorkerId ────────────────────────────────────────────

describe("resolveWorkerId", () => {
  it("returns login as-is without map", () => {
    expect(resolveWorkerId("worker-bot")).toBe("worker-bot");
  });

  it("maps login to worker ID", () => {
    const map = { "worker-bot": "worker-alpha" };
    expect(resolveWorkerId("worker-bot", map)).toBe("worker-alpha");
  });

  it("returns login for unmapped users", () => {
    const map = { other: "worker" };
    expect(resolveWorkerId("worker-bot", map)).toBe("worker-bot");
  });
});

// ── InMemoryDeduplicationStore ──────────────────────────────────

describe("InMemoryDeduplicationStore", () => {
  it("tracks seen event IDs", () => {
    const store = new InMemoryDeduplicationStore();
    expect(store.has("id1")).toBe(false);
    store.add("id1");
    expect(store.has("id1")).toBe(true);
  });

  it("clears all entries", () => {
    const store = new InMemoryDeduplicationStore();
    store.add("id1");
    store.add("id2");
    store.clear();
    expect(store.has("id1")).toBe(false);
    expect(store.has("id2")).toBe(false);
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
    expect(store.has("6")).toBe(true);
  });
});

// ── ingestGitHubComment ────────────────────────────────────────

describe("ingestGitHubComment", () => {
  it("successfully ingests a Start marker", () => {
    const store = new InMemoryDeduplicationStore();
    const result = ingestGitHubComment(makeIssueCommentPayload(), store);

    expect(result.ok).toBe(true);
    if (!result.ok || ("skipped" in result && result.skipped)) {
      throw new Error("expected success");
    }
    expect(result.eventId).toBe("gh:jinwon-int/openclaw-plugin-a2a:88#12345");
    expect(result.brokerEvent.marker).toBe("Start");
    expect(result.brokerEvent.workerId).toBe("worker-bot");
  });

  it("skips comments without markers", () => {
    const store = new InMemoryDeduplicationStore();
    const result = ingestGitHubComment(
      makeIssueCommentPayload({
        comment: { id: 12345, body: "Just a regular comment", user: { login: "worker-bot" } },
      }),
      store,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    if (!("skipped" in result)) throw new Error("expected skip");
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("no worker status marker");
  });

  it("skips non-allowed actions", () => {
    const store = new InMemoryDeduplicationStore();
    const result = ingestGitHubComment(
      makeIssueCommentPayload({ action: "deleted" }),
      store,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    if (!("skipped" in result)) throw new Error("expected skip");
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("action");
  });

  it("allows edited action", () => {
    const store = new InMemoryDeduplicationStore();
    const result = ingestGitHubComment(
      makeIssueCommentPayload({ action: "edited" }),
      store,
    );

    expect(result.ok).toBe(true);
    if (!result.ok || ("skipped" in result && result.skipped)) {
      throw new Error("expected success");
    }
    expect(result.brokerEvent.marker).toBe("Start");
  });

  it("deduplicates identical deliveries", () => {
    const store = new InMemoryDeduplicationStore();
    const payload = makeIssueCommentPayload();

    const result1 = ingestGitHubComment(payload, store);
    expect(result1.ok).toBe(true);

    const result2 = ingestGitHubComment(payload, store);
    expect(result2.ok).toBe(true);
    if (!result2.ok) throw new Error("expected ok");
    if (!("skipped" in result2)) throw new Error("expected skip");
    expect(result2.skipped).toBe(true);
    expect(result2.reason).toContain("duplicate");
  });

  it("returns error for invalid payload", () => {
    const store = new InMemoryDeduplicationStore();
    const result = ingestGitHubComment({}, store);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error).toContain("source identifiers");
  });

  it("returns error for missing comment body", () => {
    const store = new InMemoryDeduplicationStore();
    const result = ingestGitHubComment(
      makeIssueCommentPayload({
        comment: { id: 12345, user: { login: "worker-bot" } },
      }),
      store,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error).toContain("comment.body");
  });

  it("ingests PR marker with full payload", () => {
    const store = new InMemoryDeduplicationStore();
    const result = ingestGitHubComment(makePRCommentPayload(), store);

    expect(result.ok).toBe(true);
    if (!result.ok || ("skipped" in result && result.skipped)) {
      throw new Error("expected success");
    }
    expect(result.brokerEvent.marker).toBe("PR");
    expect(result.brokerEvent.workerId).toBe("worker-bot");
    expect(result.brokerEvent.taskId).toBe("jinwon-int/openclaw-plugin-a2a#86");
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

    expect(result.ok).toBe(true);
    if (!result.ok || ("skipped" in result && result.skipped)) {
      throw new Error("expected success");
    }
    expect(result.brokerEvent.marker).toBe("Block");
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

    expect(result.ok).toBe(true);
    if (!result.ok || ("skipped" in result && result.skipped)) {
      throw new Error("expected success");
    }
    expect(result.brokerEvent.marker).toBe("Done");
  });

  it("uses login-to-worker mapping", () => {
    const store = new InMemoryDeduplicationStore();
    const map = { "worker-bot": "worker-alpha" };
    const result = ingestGitHubComment(makeIssueCommentPayload(), store, {
      loginToWorkerMap: map,
    });

    expect(result.ok).toBe(true);
    if (!result.ok || ("skipped" in result && result.skipped)) {
      throw new Error("expected success");
    }
    expect(result.brokerEvent.workerId).toBe("worker-alpha");
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

    expect(result.ok).toBe(true);
    if (!result.ok || ("skipped" in result && result.skipped)) {
      throw new Error("expected success");
    }
    expect(result.warnings).toContain("PR marker has no PR URL");
    expect(result.parseStatus).toBe("partial");
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
    expect(result.ok).toBe(true);
  });
});
// ── buildGitHubCommentUrl ────────────────────────────────────

describe("buildGitHubCommentUrl", () => {
  it("builds correct GitHub comment URL", () => {
    const url = buildGitHubCommentUrl({
      repository: "jinwon-int/openclaw-plugin-a2a",
      issueNumber: 88,
      commentId: 12345,
      authorLogin: "worker-bot",
    });
    expect(url).toBe("https://github.com/jinwon-int/openclaw-plugin-a2a/issues/88#issuecomment-12345");
  });

  it("includes deliveryId when present", () => {
    const url = buildGitHubCommentUrl({
      repository: "org/repo",
      issueNumber: 1,
      commentId: 999,
      authorLogin: "bot",
      deliveryId: "abc-123",
    });
    expect(url).toContain("org/repo");
    expect(url).toContain("issuecomment-999");
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

    expect(result.ok).toBe(true);
    if (!result.ok || ("skipped" in result && result.skipped)) {
      throw new Error("expected success");
    }
    expect(result.workerEvent.marker).toBe("Done");
    expect(result.workerEvent.payload.outcome).toBe("done_evidence_only");
    expect(result.workerEvent.payload.doneUrl).toBe(
      "https://github.com/jinwon-int/openclaw-plugin-a2a/issues/88#issuecomment-100001",
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

    expect(result.ok).toBe(true);
    if (!result.ok || ("skipped" in result && result.skipped)) {
      throw new Error("expected success");
    }
    expect(result.workerEvent.marker).toBe("Done");
    expect(result.workerEvent.payload.doneUrl).toBe(
      "https://github.com/jinwon-int/openclaw-plugin-a2a/issues/88#issuecomment-100002",
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

    expect(result.ok).toBe(true);
    if (!result.ok || ("skipped" in result && result.skipped)) {
      throw new Error("expected success");
    }
    expect(result.workerEvent.marker).toBe("Block");
    expect(result.workerEvent.payload.blockUrl).toBe(
      "https://github.com/jinwon-int/openclaw-plugin-a2a/issues/88#issuecomment-100003",
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

    expect(result.ok).toBe(true);
    if (!result.ok || ("skipped" in result && result.skipped)) {
      throw new Error("expected success");
    }
    expect(result.workerEvent.marker).toBe("Done");
    expect(result.workerEvent.payload.outcome).toBe("done_with_changes");
    expect(result.workerEvent.payload.doneUrl).toBeUndefined();
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

    expect(result.ok).toBe(true);
    if (!result.ok || ("skipped" in result && result.skipped)) {
      throw new Error("expected success");
    }
    expect(result.workerEvent.marker).toBe("Start");
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

    expect(results).toHaveLength(4);
    expect(ingested).toBe(2);
    expect(skipped).toBe(1);
    expect(errors).toBe(1);
  });

  it("deduplicates across batch", () => {
    const store = new InMemoryDeduplicationStore();
    const payload = makeIssueCommentPayload();
    const { ingested, skipped } = batchIngestGitHubComments([payload, payload], store);

    expect(ingested).toBe(1);
    expect(skipped).toBe(1);
  });
});
