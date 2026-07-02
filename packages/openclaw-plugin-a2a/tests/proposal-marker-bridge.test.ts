/**
 * Tests for proposal-marker-bridge (Round 19, plugin-a2a#94).
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  ProposalState,
  PROPOSAL_TRANSITION_REASON,
  ProposalDeduplicationStore,
  deriveProposalId,
  bridgeWorkerEventToProposal,
  ingestAndBridgeProposal,
  batchIngestAndBridgeProposal,
} from "../dist/src/proposal-marker-bridge.js";
import { InMemoryDeduplicationStore } from "../dist/src/worker-marker-ingestion.js";
import { parseWorkerStatusMarker } from "../dist/src/worker-status-marker.js";

// ── Helpers ────────────────────────────────────────────────────

function makeWorkerEvent(marker, body = "marker text", workerId = "worker-alpha", taskId = "task-42", overrides = {}) {
  const parsed = parseWorkerStatusMarker(`**${marker}** ${body}`, workerId, taskId);
  return {
    ...parsed,
    ...overrides,
    payload: { ...(parsed.payload ?? {}), ...(overrides.payload ?? {}) },
  };
}

function makeCommentPayload(overrides = {}) {
  return {
    action: "created",
    comment: {
      id: 1001,
      body: "**Start** Working on #94",
      user: { login: "worker-alpha-bot" },
    },
    repository: { full_name: "jinwon-int/plugin-a2a" },
    issue: { number: 94 },
    sender: { login: "worker-alpha-bot" },
    ...overrides,
  };
}

// ── ProposalDeduplicationStore ─────────────────────────────────

test("ProposalDeduplicationStore records and checks event IDs", () => {
  const store = new ProposalDeduplicationStore();
  assert.equal(store.has("e1"), false);
  assert.equal(store.add("e1", ProposalState.PROPOSED), true);
  assert.equal(store.has("e1"), true);
  assert.equal(store.add("e1", ProposalState.PROPOSED), false);
});

test("ProposalDeduplicationStore returns stored state", () => {
  const store = new ProposalDeduplicationStore();
  store.add("e1", ProposalState.PROPOSED);
  assert.equal(store.getState("e1"), ProposalState.PROPOSED);
  assert.equal(store.getState("e2"), undefined);
});

test("ProposalDeduplicationStore evicts entries when maxSize exceeded", () => {
  const store = new ProposalDeduplicationStore(10);
  for (let i = 0; i < 12; i++) store.add(`e${i}`, ProposalState.PROPOSED);
  assert.equal(store.has("e0"), false);
  assert.equal(store.has("e11"), true);
});

test("ProposalDeduplicationStore clear empties the store", () => {
  const store = new ProposalDeduplicationStore();
  store.add("e1", ProposalState.PROPOSED);
  store.clear();
  assert.equal(store.has("e1"), false);
});

// ── deriveProposalId ───────────────────────────────────────────

test("deriveProposalId is deterministic", () => {
  assert.equal(
    deriveProposalId("task-42", "conf:repo:94"),
    deriveProposalId("task-42", "conf:repo:94"),
  );
});

test("deriveProposalId different inputs produce different IDs", () => {
  assert.notEqual(
    deriveProposalId("task-42", "conf:repo:94"),
    deriveProposalId("task-43", "conf:repo:94"),
  );
});

// ── bridgeWorkerEventToProposal ────────────────────────────────

test("Start marker maps to proposed state", () => {
  const store = new ProposalDeduplicationStore();
  const confId = "conf:jinwon-int/plugin-a2a:94";
  const result = bridgeWorkerEventToProposal(
    makeWorkerEvent("Start"),
    confId,
    store,
  );
  assert.equal(result.ok, true);
  assert.ok("event" in result);
  assert.equal(result.event.state, ProposalState.PROPOSED);
  assert.equal(result.event.transitionReason, PROPOSAL_TRANSITION_REASON.WORKER_STARTED);
  assert.equal(result.event.conferenceId, confId);
  assert.equal(result.event.taskId, "task-42");
  assert.equal(result.event.participantId, "worker-alpha");
});

test("Block marker maps to blocked state", () => {
  const store = new ProposalDeduplicationStore();
  const confId = "conf:repo:94";
  const result = bridgeWorkerEventToProposal(
    makeWorkerEvent("Block", "Missing dependency"),
    confId,
    store,
  );
  assert.equal(result.ok, true);
  assert.ok("event" in result);
  assert.equal(result.event.state, ProposalState.BLOCKED);
  assert.equal(result.event.transitionReason, PROPOSAL_TRANSITION_REASON.WORKER_BLOCKED);
});

test("PR marker maps to applying state", () => {
  const store = new ProposalDeduplicationStore();
  const confId = "conf:repo:94";
  const result = bridgeWorkerEventToProposal(
    makeWorkerEvent("PR", "https://github.com/jinwon-int/plugin-a2a/pull/96", "worker-alpha", "task-42", {
      payload: { prUrl: "https://github.com/jinwon-int/plugin-a2a/pull/96", branch: "worker-alpha/r19" },
    }),
    confId,
    store,
  );
  assert.equal(result.ok, true);
  assert.ok("event" in result);
  assert.equal(result.event.state, ProposalState.APPLYING);
  assert.equal(result.event.artifactUrl, "https://github.com/jinwon-int/plugin-a2a/pull/96");
});

test("Done marker maps to applied state", () => {
  const store = new ProposalDeduplicationStore();
  const confId = "conf:repo:94";
  const result = bridgeWorkerEventToProposal(
    makeWorkerEvent("Done", "Merged"),
    confId,
    store,
  );
  assert.equal(result.ok, true);
  assert.ok("event" in result);
  assert.equal(result.event.state, ProposalState.APPLIED);
  assert.equal(result.event.transitionReason, PROPOSAL_TRANSITION_REASON.APPLY_SUCCEEDED);
});

test("derives stable proposal ID from task + conference", () => {
  const store = new ProposalDeduplicationStore();
  const confId = "conf:repo:94";
  const result = bridgeWorkerEventToProposal(makeWorkerEvent("Start"), confId, store);
  assert.ok("event" in result);
  assert.equal(result.event.proposalId, deriveProposalId("task-42", confId));
});

test("uses source commentId for event ID when available", () => {
  const store = new ProposalDeduplicationStore();
  const result = bridgeWorkerEventToProposal(
    makeWorkerEvent("Start"),
    "conf:repo:94",
    store,
    { repository: "repo", issueNumber: 94, commentId: 5001 },
  );
  assert.ok("event" in result);
  assert.ok(result.event.eventId.includes("5001"));
});

test("uses fallback fingerprint when no commentId", () => {
  const store = new ProposalDeduplicationStore();
  const result = bridgeWorkerEventToProposal(makeWorkerEvent("Start"), "conf:repo:94", store);
  assert.ok("event" in result);
  assert.ok(result.event.eventId.includes("fallback"));
});

test("deduplicates identical events", () => {
  const store = new ProposalDeduplicationStore();
  const event = makeWorkerEvent("Start");
  const source = { repository: "repo", issueNumber: 1, commentId: 100 };
  const r1 = bridgeWorkerEventToProposal(event, "conf:repo:94", store, source);
  const r2 = bridgeWorkerEventToProposal(event, "conf:repo:94", store, source);
  assert.ok("event" in r1);
  assert.ok("skipped" in r2 && r2.skipped);
});

test("preserves partial parse status", () => {
  const store = new ProposalDeduplicationStore();
  const event = makeWorkerEvent("Start");
  event.parseStatus = "partial";
  event.warnings = ["missing field"];
  const result = bridgeWorkerEventToProposal(event, "conf:repo:94", store);
  assert.ok("event" in result);
  assert.equal(result.event.parseStatus, "partial");
  assert.deepEqual(result.event.warnings, ["missing field"]);
});

test("maps failed parse status to partial", () => {
  const store = new ProposalDeduplicationStore();
  const event = makeWorkerEvent("Start");
  event.parseStatus = "failed";
  const result = bridgeWorkerEventToProposal(event, "conf:repo:94", store);
  assert.ok("event" in result);
  assert.equal(result.event.parseStatus, "partial");
});

test("includes source metadata when provided", () => {
  const store = new ProposalDeduplicationStore();
  const result = bridgeWorkerEventToProposal(
    makeWorkerEvent("Start"),
    "conf:repo:94",
    store,
    { repository: "jinwon-int/plugin-a2a", issueNumber: 94, commentId: 555 },
  );
  assert.ok("event" in result);
  assert.equal(result.event.source.repository, "jinwon-int/plugin-a2a");
  assert.equal(result.event.source.issueNumber, 94);
  assert.equal(result.event.source.commentId, 555);
});

// ── Redaction ──────────────────────────────────────────────────

test("redacts secret values in summaries", () => {
  const store = new ProposalDeduplicationStore();
  const event = makeWorkerEvent("Block", "api_key: sk-1234567890abcdef blocked");
  const result = bridgeWorkerEventToProposal(event, "conf:repo:94", store);
  assert.ok("event" in result);
  assert.ok(!result.event.summary?.includes("sk-1234567890abcdef"));
});

test("redacts code blocks in summaries", () => {
  const store = new ProposalDeduplicationStore();
  const event = makeWorkerEvent("Start", "```javascript\nconst secret = 'abc'\n```\nDone");
  const result = bridgeWorkerEventToProposal(event, "conf:repo:94", store);
  assert.ok("event" in result);
  assert.ok(!result.event.summary?.includes("const secret"));
});

// ── ingestAndBridgeProposal (full pipeline) ────────────────────

test("full pipeline bridges Start comment to proposed", () => {
  const markerStore = new InMemoryDeduplicationStore();
  const proposalStore = new ProposalDeduplicationStore();
  const result = ingestAndBridgeProposal(
    makeCommentPayload(),
    markerStore,
    proposalStore,
    { loginToWorkerMap: { "worker-alpha-bot": "worker-alpha" } },
  );
  assert.equal(result.ok, true);
  assert.ok("event" in result);
  assert.equal(result.event.state, ProposalState.PROPOSED);
  assert.equal(result.event.participantId, "worker-alpha");
});

test("full pipeline skips comments without markers", () => {
  const markerStore = new InMemoryDeduplicationStore();
  const proposalStore = new ProposalDeduplicationStore();
  const result = ingestAndBridgeProposal(
    makeCommentPayload({
      comment: { id: 1002, body: "Just a regular comment", user: { login: "worker-alpha-bot" } },
    }),
    markerStore,
    proposalStore,
    { loginToWorkerMap: { "worker-alpha-bot": "worker-alpha" } },
  );
  assert.equal(result.ok, true);
  assert.ok("skipped" in result && result.skipped);
});

test("full pipeline returns error for malformed payload", () => {
  const markerStore = new InMemoryDeduplicationStore();
  const proposalStore = new ProposalDeduplicationStore();
  const result = ingestAndBridgeProposal({}, markerStore, proposalStore);
  assert.equal(result.ok, false);
});

test("full pipeline deduplicates across runs", () => {
  const markerStore = new InMemoryDeduplicationStore();
  const proposalStore = new ProposalDeduplicationStore();
  const payload = makeCommentPayload();
  const opts = { loginToWorkerMap: { "worker-alpha-bot": "worker-alpha" } };
  const r1 = ingestAndBridgeProposal(payload, markerStore, proposalStore, opts);
  const r2 = ingestAndBridgeProposal(payload, markerStore, proposalStore, opts);
  assert.ok("event" in r1);
  assert.ok("skipped" in r2 && r2.skipped);
});

test("full pipeline bridges PR comment to applying", () => {
  const markerStore = new InMemoryDeduplicationStore();
  const proposalStore = new ProposalDeduplicationStore();
  const result = ingestAndBridgeProposal(
    makeCommentPayload({
      comment: {
        id: 1003,
        body: "**PR** https://github.com/jinwon-int/plugin-a2a/pull/96",
        user: { login: "worker-alpha-bot" },
      },
    }),
    markerStore,
    proposalStore,
    { loginToWorkerMap: { "worker-alpha-bot": "worker-alpha" } },
  );
  assert.equal(result.ok, true);
  assert.ok("event" in result);
  assert.equal(result.event.state, ProposalState.APPLYING);
  assert.equal(result.event.artifactUrl, "https://github.com/jinwon-int/plugin-a2a/pull/96");
});

test("full pipeline bridges Done comment to applied", () => {
  const markerStore = new InMemoryDeduplicationStore();
  const proposalStore = new ProposalDeduplicationStore();
  const result = ingestAndBridgeProposal(
    makeCommentPayload({
      comment: { id: 1004, body: "**Done** Merged", user: { login: "worker-alpha-bot" } },
    }),
    markerStore,
    proposalStore,
    { loginToWorkerMap: { "worker-alpha-bot": "worker-alpha" } },
  );
  assert.equal(result.ok, true);
  assert.ok("event" in result);
  assert.equal(result.event.state, ProposalState.APPLIED);
});

// ── batchIngestAndBridgeProposal ────────────────────────────────

test("batch processes multiple comments", () => {
  const markerStore = new InMemoryDeduplicationStore();
  const proposalStore = new ProposalDeduplicationStore();
  const result = batchIngestAndBridgeProposal(
    [
      makeCommentPayload({ comment: { id: 2001, body: "**Start** Working", user: { login: "worker-alpha-bot" } } }),
      makeCommentPayload({ comment: { id: 2002, body: "**PR** https://example.com/pr/1", user: { login: "worker-alpha-bot" } } }),
      makeCommentPayload({ comment: { id: 2003, body: "No marker", user: { login: "worker-alpha-bot" } } }),
      makeCommentPayload({ comment: { id: 2004, body: "**Done** Completed", user: { login: "worker-alpha-bot" } } }),
    ],
    markerStore,
    proposalStore,
    { loginToWorkerMap: { "worker-alpha-bot": "worker-alpha" } },
  );
  assert.equal(result.bridged, 3);
  assert.equal(result.skipped, 1);
  assert.equal(result.errors, 0);
  assert.equal(result.results.length, 4);
});

test("batch handles duplicates", () => {
  const markerStore = new InMemoryDeduplicationStore();
  const proposalStore = new ProposalDeduplicationStore();
  const payload = makeCommentPayload({
    comment: { id: 3001, body: "**Start** Working on it", user: { login: "worker-alpha-bot" } },
  });
  const result = batchIngestAndBridgeProposal(
    [payload, payload],
    markerStore,
    proposalStore,
    { loginToWorkerMap: { "worker-alpha-bot": "worker-alpha" } },
  );
  assert.equal(result.bridged, 1);
  assert.equal(result.skipped, 1);
});

test("batch handles empty input", () => {
  const markerStore = new InMemoryDeduplicationStore();
  const proposalStore = new ProposalDeduplicationStore();
  const result = batchIngestAndBridgeProposal([], markerStore, proposalStore);
  assert.equal(result.bridged, 0);
  assert.equal(result.skipped, 0);
  assert.equal(result.errors, 0);
});

test("batch counts errors for malformed payloads", () => {
  const markerStore = new InMemoryDeduplicationStore();
  const proposalStore = new ProposalDeduplicationStore();
  const result = batchIngestAndBridgeProposal(
    [
      {},
      makeCommentPayload({ comment: { id: 4001, body: "**Start** Working on it", user: { login: "worker-alpha-bot" } } }),
    ],
    markerStore,
    proposalStore,
    { loginToWorkerMap: { "worker-alpha-bot": "worker-alpha" } },
  );
  assert.equal(result.errors, 1);
  assert.equal(result.bridged, 1);
});

// ── Edge cases ─────────────────────────────────────────────────

test("handles missing payload gracefully", () => {
  const store = new ProposalDeduplicationStore();
  const event = makeWorkerEvent("Block", "reason text");
  event.payload = {};
  const result = bridgeWorkerEventToProposal(event, "conf:repo:94", store);
  assert.ok("event" in result);
  assert.equal(result.event.state, ProposalState.BLOCKED);
});

test("state progression across multiple markers", () => {
  const store = new ProposalDeduplicationStore();
  const confId = "conf:repo:94";
  const source = { repository: "repo", issueNumber: 94 };

  const r1 = bridgeWorkerEventToProposal(makeWorkerEvent("Start", "Work"), confId, store, { ...source, commentId: 1 });
  const r2 = bridgeWorkerEventToProposal(makeWorkerEvent("PR", "PR url"), confId, store, { ...source, commentId: 2 });
  const r3 = bridgeWorkerEventToProposal(makeWorkerEvent("Done", "Done"), confId, store, { ...source, commentId: 3 });

  assert.ok("event" in r1 && "event" in r2 && "event" in r3);
  assert.equal(r1.event.state, ProposalState.PROPOSED);
  assert.equal(r2.event.state, ProposalState.APPLYING);
  assert.equal(r3.event.state, ProposalState.APPLIED);
  assert.equal(r1.event.proposalId, r2.event.proposalId);
  assert.equal(r2.event.proposalId, r3.event.proposalId);
});

test("deterministic eventId on replay with same source", () => {
  const s1 = new ProposalDeduplicationStore();
  const s2 = new ProposalDeduplicationStore();
  const source = { repository: "repo", issueNumber: 94, commentId: 77 };
  const event = makeWorkerEvent("Start");
  const r1 = bridgeWorkerEventToProposal(event, "conf:repo:94", s1, source);
  const r2 = bridgeWorkerEventToProposal(event, "conf:repo:94", s2, source);
  assert.ok("event" in r1 && "event" in r2);
  assert.equal(r1.event.eventId, r2.event.eventId);
});

// ── Branch mismatch / no-diff evidence (issue #242) ────────────

test("Block marker with 'No commits between main and' + branch URL is mapped to BLOCKED, not applied/success", () => {
  const store = new ProposalDeduplicationStore();
  const confId = "conf:jinwon-int/plugin-a2a:242";
  const markerText = "**Block** No commits between main and worker-alpha/issue-242 branch: worker-alpha/issue-242 status: no-diff";
  const event = makeWorkerEvent("Block", "No commits between main and worker-alpha/issue-242 branch: worker-alpha/issue-242 status: no-diff");
  event.rawText = markerText;
  const result = bridgeWorkerEventToProposal(event, confId, store);
  assert.equal(result.ok, true);
  assert.ok("event" in result);
  // Must be BLOCKED, not APPLIED / APPLY_SUCCEEDED
  assert.equal(result.event.state, ProposalState.BLOCKED);
  assert.equal(result.event.transitionReason, PROPOSAL_TRANSITION_REASON.WORKER_BLOCKED);
  assert.notEqual(result.event.state, ProposalState.APPLIED);
  assert.notEqual(result.event.state, ProposalState.APPLYING);
  // Summary preserves actionable branch mismatch reason
  assert.ok(result.event.summary?.includes("No commits between main"));
});

test("Block marker branch mismatch evidence is preserved in reason text", () => {
  const store = new ProposalDeduplicationStore();
  const confId = "conf:jinwon-int/plugin-a2a:242";
  const markerText = [
    "**Block** No commits between main and worker-alpha/issue-242",
    "branch: worker-alpha/issue-242",
    "https://github.com/jinwon-int/plugin-a2a/tree/worker-alpha/issue-242",
    "status: no-diff",
  ].join("\n");
  const event = makeWorkerEvent("Block", markerText.replace("**Block** ", ""));
  event.rawText = markerText;
  const result = bridgeWorkerEventToProposal(event, confId, store);
  assert.equal(result.ok, true);
  assert.ok("event" in result);
  assert.equal(result.event.state, ProposalState.BLOCKED);
  // Branch URL preserved in summary (redacted for secrets only, not stripped)
  assert.ok(result.event.summary?.includes("worker-alpha/issue-242"));
});

test("Done marker with 'No commits between' failure indicator is classified as non-success (branchguard hardening)", () => {
  const store = new ProposalDeduplicationStore();
  const confId = "conf:jinwon-int/plugin-a2a:242";
  // If a Done marker incorrectly contains branch mismatch evidence, detect it as non-success
  const markerText = "**Done** No commits between main and worker-alpha/issue-242";
  const event = makeWorkerEvent("Done", "No commits between main and worker-alpha/issue-242");
  event.rawText = markerText;
  // parseWorkerStatusMarker should set success=false for no-commits-between text
  const parsed = parseWorkerStatusMarker(markerText, "worker-alpha", "task-242");
  if (parsed && "marker" in parsed && parsed.marker === "Done") {
    assert.equal(parsed.payload.success, false, "Done marker with no-commits-between should be success=false");
  }
  // Bridge still applies (proposal-marker-bridge doesn't look at success field),
  // but the parse layer has correctly classified it.
  const result = bridgeWorkerEventToProposal(event, confId, store);
  assert.equal(result.ok, true);
  assert.ok("event" in result);
  // Even though bridge maps to APPLIED (it doesn't use success field),
  // the parse warning is captured
  assert.ok(result.event.summary?.includes("No commits between main"));
});

// ── Read-only / libero validation flows ────────────────────────

test("Done marker with done_evidence_only outcome maps to APPLIED state", () => {
  const store = new ProposalDeduplicationStore();
  const confId = "conf:org/repo:17";
  const event = makeWorkerEvent(
    "Done",
    "evidence-only, no code changes. Block assessment complete.",
    "workerBeta-validator",
    "task-readonly-1",
    {
      payload: {
        doneUrl: "https://github.com/org/repo/issues/17#issuecomment-500",
        outcome: "done_evidence_only",
      },
    },
  );

  const result = bridgeWorkerEventToProposal(event, confId, store);
  assert.equal(result.ok, true);
  assert.ok("event" in result);

  const proposal = result.event;
  assert.equal(proposal.state, ProposalState.APPLIED);
  assert.equal(proposal.transitionReason, PROPOSAL_TRANSITION_REASON.APPLY_SUCCEEDED);
  assert.equal(proposal.participantId, "workerBeta-validator");
  assert.equal(
    proposal.artifactUrl,
    "https://github.com/org/repo/issues/17#issuecomment-500",
    "doneUrl must be extracted as artifact for evidence-only proposals",
  );
  assert.ok(proposal.summary?.includes("evidence"), "summary must preserve evidence-only context");
});

test("Done marker with done_no_changes outcome maps to APPLIED state with doneUrl", () => {
  const store = new ProposalDeduplicationStore();
  const confId = "conf:org/repo:18";
  const event = makeWorkerEvent(
    "Done",
    "no changes needed. Existing configuration passes validation.",
    "workerBeta-validator",
    "task-readonly-2",
    {
      payload: {
        doneUrl: "https://github.com/org/repo/issues/18#issuecomment-501",
        outcome: "done_no_changes",
      },
    },
  );

  const result = bridgeWorkerEventToProposal(event, confId, store);
  assert.equal(result.ok, true);
  assert.ok("event" in result);

  const proposal = result.event;
  assert.equal(proposal.state, ProposalState.APPLIED);
  assert.equal(proposal.participantId, "workerBeta-validator");
  assert.ok(proposal.summary?.includes("no changes"), "summary must preserve no-changes context");
  assert.equal(
    proposal.artifactUrl,
    "https://github.com/org/repo/issues/18#issuecomment-501",
  );
});

test("Block marker with blockUrl maps to BLOCKED state with evidence URL", () => {
  const store = new ProposalDeduplicationStore();
  const confId = "conf:org/repo:19";
  const event = makeWorkerEvent(
    "Block",
    "read-only assessment found blocking condition",
    "workerBeta-validator",
    "task-readonly-3",
    {
      payload: {
        blockUrl: "https://github.com/org/repo/issues/19#issuecomment-600",
        reason: "unsafe configuration detected during read-only audit",
      },
    },
  );

  const result = bridgeWorkerEventToProposal(event, confId, store);
  assert.equal(result.ok, true);
  assert.ok("event" in result);

  const proposal = result.event;
  assert.equal(proposal.state, ProposalState.BLOCKED);
  assert.equal(proposal.transitionReason, PROPOSAL_TRANSITION_REASON.WORKER_BLOCKED);
  assert.equal(
    proposal.artifactUrl,
    "https://github.com/org/repo/issues/19#issuecomment-600",
    "blockUrl must be extracted as artifact for Block proposals",
  );
  assert.ok(proposal.summary?.includes("unsafe"), "summary must preserve block reason");
});

test("read-only Done proposal without any artifact URL still produces valid APPLIED event", () => {
  const store = new ProposalDeduplicationStore();
  const confId = "conf:org/repo:20";
  const event = makeWorkerEvent(
    "Done",
    "validation complete, evidence-only, no PR needed",
    "workerBeta-validator",
    "task-readonly-4",
  );

  const result = bridgeWorkerEventToProposal(event, confId, store);
  assert.equal(result.ok, true);
  assert.ok("event" in result);

  const proposal = result.event;
  assert.equal(proposal.state, ProposalState.APPLIED);
  assert.equal(proposal.artifactUrl, undefined,
    "artifactUrl is undefined when no evidence URLs exist in payload");
  assert.ok(proposal.summary, "proposal summary must still be present without artifact URL");
});
