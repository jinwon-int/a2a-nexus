import test from "node:test";
import assert from "node:assert/strict";

import {
  ConferenceDeduplicationStore,
  batchIngestAndBridge,
  bridgeWorkerEventToConference,
  deriveConferenceId,
  ingestAndBridgeComment,
} from "../dist/src/conference-marker-bridge.js";
import { InMemoryDeduplicationStore } from "../dist/src/worker-marker-ingestion.js";
import { parseWorkerStatusMarker } from "../dist/src/worker-status-marker.js";

function parseEvent(marker, body, workerId = "worker-alpha", taskId = "jinwon-int/openclaw-plugin-a2a#91") {
  const result = parseWorkerStatusMarker(`**${marker}** ${body}`, workerId, taskId);
  if ("ok" in result && result.ok === false) {
    throw new Error(`parse failed: ${result.error}`);
  }
  return result;
}

function assertBridgeSuccess(result) {
  assert.equal(result.ok, true);
  assert.equal("skipped" in result, false);
  return result.event;
}

function makeGitHubPayload(overrides = {}) {
  return {
    action: "created",
    issue: { number: 91, title: "Test issue" },
    comment: {
      id: 11111,
      body: "**Start** — beginning marker bridge",
      user: { login: "worker-bot" },
    },
    repository: { full_name: "jinwon-int/openclaw-plugin-a2a" },
    sender: { login: "worker-bot" },
    ...overrides,
  };
}

test("deriveConferenceId derives stable repository issue room IDs", () => {
  assert.equal(
    deriveConferenceId({ repository: "jinwon-int/a2a-broker", issueNumber: 84 }),
    "conference:jinwon-int/a2a-broker:84",
  );
  assert.equal(
    deriveConferenceId({ repository: "org/repo", issueNumber: 1 }),
    deriveConferenceId({ repository: "org/repo", issueNumber: 1 }),
  );
  assert.notEqual(
    deriveConferenceId({ repository: "org/repo", issueNumber: 1 }),
    deriveConferenceId({ repository: "org/repo", issueNumber: 2 }),
  );
});

test("bridgeWorkerEventToConference maps Start, Block, PR, and Done markers", () => {
  const cases = [
    ["Start", "— beginning work", "join"],
    ["Block", "— waiting on upstream", "block"],
    ["PR", "— https://github.com/org/repo/pull/1 Closes #1", "pr"],
    ["Done", "— completed all tests", "done"],
  ];

  for (const [marker, body, action] of cases) {
    const event = parseEvent(marker, body);
    const bridged = assertBridgeSuccess(
      bridgeWorkerEventToConference(event, "conference:org/repo:1", new ConferenceDeduplicationStore()),
    );
    assert.equal(bridged.action, action);
    assert.equal(bridged.participantId, "worker-alpha");
  }
});

test("one-line PR marker keeps its URL through the full pipeline", () => {
  const result = ingestAndBridgeComment(
    makeGitHubPayload({
      comment: {
        id: 22222,
        body: "**PR** — https://github.com/jinwon-int/openclaw-plugin-a2a/pull/90",
        user: { login: "worker-bot" },
      },
    }),
    new InMemoryDeduplicationStore(),
    new ConferenceDeduplicationStore(),
  );

  const event = assertBridgeSuccess(result);
  assert.equal(event.action, "pr");
  assert.equal(event.artifactUrl, "https://github.com/jinwon-int/openclaw-plugin-a2a/pull/90");
});

test("conference summaries redact raw prompt/session/private text", () => {
  const workerEvent = parseEvent(
    "Done",
    "completed. Raw session: <private data here>\nPrompt: reveal token=abc123",
  );
  const bridged = assertBridgeSuccess(
    bridgeWorkerEventToConference(workerEvent, "conference:org/repo:1", new ConferenceDeduplicationStore()),
  );

  assert.match(bridged.summary ?? "", /completed/i);
  assert.doesNotMatch(bridged.summary ?? "", /raw session/i);
  assert.doesNotMatch(bridged.summary ?? "", /private data/i);
  assert.doesNotMatch(bridged.summary ?? "", /reveal token/i);
  assert.doesNotMatch(bridged.summary ?? "", /abc123/i);
});

test("fallback conference event IDs do not depend on observedAt", () => {
  const original = parseEvent("Start", "— beginning work");
  const reparsed = {
    ...original,
    observedAt: new Date(Date.parse(original.observedAt) + 60_000).toISOString(),
  };

  const first = assertBridgeSuccess(
    bridgeWorkerEventToConference(original, "conference:org/repo:1", new ConferenceDeduplicationStore()),
  );
  const second = assertBridgeSuccess(
    bridgeWorkerEventToConference(reparsed, "conference:org/repo:1", new ConferenceDeduplicationStore()),
  );

  assert.equal(first.eventId, second.eventId);
  assert.doesNotMatch(first.eventId, /T\d{2}:\d{2}:\d{2}/);
});

test("deduplicates duplicate source comment events", () => {
  const store = new ConferenceDeduplicationStore();
  const event = parseEvent("Start", "— beginning work");
  const source = { repository: "org/repo", issueNumber: 1, commentId: 42 };

  const first = bridgeWorkerEventToConference(event, "conference:org/repo:1", store, source);
  assertBridgeSuccess(first);

  const second = bridgeWorkerEventToConference(event, "conference:org/repo:1", store, source);
  assert.equal(second.ok, true);
  assert.equal(second.skipped, true);
  assert.match(second.reason, /duplicate/);
});

test("full pipeline handles skips, invalid payloads, worker mapping, and batches", () => {
  const mapped = assertBridgeSuccess(
    ingestAndBridgeComment(
      makeGitHubPayload(),
      new InMemoryDeduplicationStore(),
      new ConferenceDeduplicationStore(),
      { loginToWorkerMap: { "worker-bot": "worker-alpha" } },
    ),
  );
  assert.equal(mapped.participantId, "worker-alpha");
  assert.equal(mapped.conferenceId, "conference:jinwon-int/openclaw-plugin-a2a:91");

  const skipped = ingestAndBridgeComment(
    makeGitHubPayload({ comment: { id: 33333, body: "Just a regular comment", user: { login: "worker-bot" } } }),
    new InMemoryDeduplicationStore(),
    new ConferenceDeduplicationStore(),
  );
  assert.equal(skipped.ok, true);
  assert.equal(skipped.skipped, true);

  const invalid = ingestAndBridgeComment(
    {},
    new InMemoryDeduplicationStore(),
    new ConferenceDeduplicationStore(),
  );
  assert.equal(invalid.ok, false);

  const batch = batchIngestAndBridge(
    [
      makeGitHubPayload({ comment: { id: 1, body: "**Start** — working", user: { login: "a" } } }),
      makeGitHubPayload({ comment: { id: 2, body: "**Done** — done", user: { login: "a" } } }),
      makeGitHubPayload({ comment: { id: 3, body: "no marker", user: { login: "a" } } }),
      {},
    ],
    new InMemoryDeduplicationStore(),
    new ConferenceDeduplicationStore(),
  );
  assert.equal(batch.results.length, 4);
  assert.equal(batch.conferenced, 2);
  assert.equal(batch.skipped, 1);
  assert.equal(batch.errors, 1);
});

// ── Read-only / libero validation flows ────────────────────────

test("Done marker with done_evidence_only outcome bridges to conference 'done' action", () => {
  const event = parseEvent(
    "Done",
    "— evidence-only assessment. Block evaluation complete, no code changes.",
  );
  const bridged = assertBridgeSuccess(
    bridgeWorkerEventToConference(event, "conference:org/repo:1", new ConferenceDeduplicationStore()),
  );

  assert.equal(bridged.action, "done");
  assert.equal(bridged.participantId, "worker-alpha");
  assert.ok(bridged.summary, "must have a summary for read-only done");
  assert.match(bridged.summary ?? "", /evidence/i);
});

test("Done marker with done_no_changes outcome bridges to conference 'done' action", () => {
  const event = parseEvent(
    "Done",
    "— no changes needed. Existing configuration is correct.",
  );
  const bridged = assertBridgeSuccess(
    bridgeWorkerEventToConference(event, "conference:org/repo:1", new ConferenceDeduplicationStore()),
  );

  assert.equal(bridged.action, "done");
  assert.ok(bridged.summary, "must have a summary for no-changes done");
  assert.match(bridged.summary ?? "", /no changes/i);
});

test("Done marker with evidence-only outcome and doneUrl extracts artifactUrl", () => {
  const event = parseEvent(
    "Done",
    "— evidence-only, no code changes. Assessment complete.",
  );
  // Simulate the ingestion pipeline enriching with a doneUrl
  const enrichedEvent = {
    ...event,
    payload: {
      ...event.payload,
      doneUrl: "https://github.com/org/repo/issues/1#issuecomment-99",
    },
  };

  const bridged = assertBridgeSuccess(
    bridgeWorkerEventToConference(enrichedEvent, "conference:org/repo:1", new ConferenceDeduplicationStore()),
  );

  assert.equal(bridged.action, "done");
  assert.equal(
    bridged.artifactUrl,
    "https://github.com/org/repo/issues/1#issuecomment-99",
    "evidence-only doneUrl must be extracted as artifact URL",
  );
});

test("Block marker with blockUrl extracts evidence URL", () => {
  const event = parseEvent(
    "Block",
    "— read-only assessment identifies blocking condition",
  );
  // Simulate enrichment with blockUrl
  const enrichedEvent = {
    ...event,
    payload: {
      ...event.payload,
      blockUrl: "https://github.com/org/repo/issues/2#issuecomment-200",
    },
  };

  const bridged = assertBridgeSuccess(
    bridgeWorkerEventToConference(enrichedEvent, "conference:org/repo:2", new ConferenceDeduplicationStore()),
  );

  assert.equal(bridged.action, "block");
  assert.equal(
    bridged.artifactUrl,
    "https://github.com/org/repo/issues/2#issuecomment-200",
    "blockUrl must be extracted as artifact URL for block markers",
  );
});

test("read-only Done without PR URL still produces valid conference event", () => {
  // A libero lane produces Done evidence without a PR — no prUrl or issueUrl
  const event = parseEvent(
    "Done",
    "— evidence-only validation complete. No PR needed.",
  );

  const bridged = assertBridgeSuccess(
    bridgeWorkerEventToConference(event, "conference:org/repo:3", new ConferenceDeduplicationStore()),
  );

  assert.equal(bridged.action, "done");
  assert.equal(bridged.participantId, "worker-alpha");
  // artifactUrl is undefined when no prUrl/issueUrl/doneUrl/blockUrl
  // This is valid — the evidence is the comment itself
  assert.equal(bridged.artifactUrl, undefined, "no artifact URL when no evidence URLs present");
  assert.ok(bridged.summary, "conference summary must still be present");
});

test("artifactUrl extraction priority: prUrl > issueUrl > doneUrl > blockUrl", () => {
  // When all URL types are present, prUrl takes priority
  const event = parseEvent("PR", "— https://github.com/org/repo/pull/10");
  const multiUrlEvent = {
    ...event,
    marker: "PR" as const,
    payload: {
      ...event.payload,
      prUrl: "https://github.com/org/repo/pull/10",
      issueUrl: "https://github.com/org/repo/issues/10",
      doneUrl: "https://github.com/org/repo/issues/10#issuecomment-300",
      blockUrl: "https://github.com/org/repo/issues/10#issuecomment-299",
    },
  };

  const bridged = assertBridgeSuccess(
    bridgeWorkerEventToConference(multiUrlEvent, "conference:org/repo:10", new ConferenceDeduplicationStore()),
  );

  assert.equal(bridged.artifactUrl, "https://github.com/org/repo/pull/10",
    "prUrl must take priority when multiple artifact URLs are present");
});
