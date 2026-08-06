#!/usr/bin/env node
/**
 * NCLEX content PR evaluation preset — `nclex_content_pr_v1` (#1724).
 *
 * Lets any of the 12 fleet nodes author NCLEX content PRs while a formal A2A
 * team (T1 or T2, never the author's) performs exact-head verification and
 * evaluation, then projects merge-ready evidence back to GitHub.
 *
 * Boundaries (fail-closed by construction):
 * - pure and offline: no network, no GitHub/provider/broker calls — this
 *   module only computes routing, readiness, and comment projections;
 * - reviewers never touch the branch; the broker/finalizer judges readiness,
 *   and a separate GitHub-privileged account merges without bypassing branch
 *   protection;
 * - restricted reference material is never carried: only IDs, SHA-256, and
 *   page/section citations appear in any artifact or comment.
 *
 * Reuses the #1518 contracts: frozen intentHash, exact headSha/diffHash
 * binding, signed review receipts, and the bounded budget defaults
 * (maxCorrectionGenerations 1, maxReviewerRuns 2).
 */
import { TEAM_BROKER_INVARIANT, hasText } from "./a2a-routing-shared.mjs";

export const NCLEX_CONTENT_PR_PRESET_V1 = Object.freeze({
  presetId: "nclex_content_pr_v1",
  version: 1,
  lanes: Object.freeze([
    Object.freeze({
      kind: "content_clinical",
      brief:
        "임상 정확성, NCJMM, 우선순위·위임·안전, 오답 변별력을 검증한다. 근거가 결론을 지지하지 않으면 BLOCK.",
    }),
    Object.freeze({
      kind: "evidence_adversarial",
      brief:
        "근거-주장 정합성, 라이선스·유사도, 단서 누출, 응시자 화면·렌더링, 게이트 재현을 적대적으로 검증한다.",
    }),
  ]),
  budget: Object.freeze({ maxCorrectionGenerations: 1, maxReviewerRuns: 2 }),
  quorum: Object.freeze({ normal: 2, highRisk: 3 }),
  sideEffectPolicy: "finalizer-only",
});

const SHA40 = /^[0-9a-f]{40}$/;
const SHA64 = /^[0-9a-f]{64}$/;
const RISK_LEVELS = new Set(["normal", "high-risk"]);
const TEAMS = new Set(["T1", "T2"]);

/** Structured preset failure: code + bounded detail, never a stack string. */
export class NclexPresetError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "NclexPresetError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, details) {
  throw new NclexPresetError(code, message, details);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validate the preset input. Fail-closed: every required field must be
 * present and well-formed, because receipts bind to these values.
 */
export function validatePresetInput(input) {
  if (!isPlainObject(input)) fail("input_invalid", "preset input must be an object");
  const missing = [];
  for (const field of [
    "repo",
    "prNumber",
    "baseSha",
    "headSha",
    "diffHash",
    "intentHash",
    "authorNodeId",
    "caseIds",
    "sourcePacketId",
    "refsManifestSha256",
    "risk",
  ]) {
    if (input[field] === undefined || input[field] === null || input[field] === "") missing.push(field);
  }
  if (missing.length) fail("input_missing_fields", `missing required fields: ${missing.join(", ")}`, { missing });

  if (!hasText(input.repo) || !/^[\w.-]+\/[\w.-]+$/.test(input.repo.trim())) {
    fail("input_invalid", "repo must have the form owner/name");
  }
  if (!Number.isSafeInteger(input.prNumber) || input.prNumber <= 0) {
    fail("input_invalid", "prNumber must be a positive integer");
  }
  for (const [field, pattern] of [
    ["baseSha", SHA40],
    ["headSha", SHA40],
  ]) {
    if (!pattern.test(String(input[field]))) fail("input_invalid", `${field} must be a 40-char hex SHA`);
  }
  for (const field of ["diffHash", "intentHash"]) {
    if (!hasText(String(input[field]))) fail("input_invalid", `${field} must be a non-empty string`);
  }
  if (!SHA64.test(String(input.refsManifestSha256))) {
    fail("refs_manifest_invalid", "refsManifestSha256 must be a 64-char lowercase sha256 hex");
  }
  if (!hasText(input.authorNodeId)) fail("input_invalid", "authorNodeId must be a non-empty string");
  if (!Array.isArray(input.caseIds) || input.caseIds.length === 0 || !input.caseIds.every((id) => hasText(String(id)))) {
    fail("input_invalid", "caseIds must be a non-empty array of non-empty strings");
  }
  if (!hasText(String(input.sourcePacketId))) fail("input_invalid", "sourcePacketId must be a non-empty string");
  if (!RISK_LEVELS.has(input.risk)) {
    fail("input_invalid", `risk must be one of ${[...RISK_LEVELS].join("|")}`);
  }
  const coAuthors = input.coAuthorNodeIds ?? [];
  if (!Array.isArray(coAuthors) || !coAuthors.every((id) => hasText(String(id)))) {
    fail("input_invalid", "coAuthorNodeIds must be an array of non-empty strings when present");
  }
  return {
    repo: input.repo.trim(),
    prNumber: input.prNumber,
    baseSha: String(input.baseSha).toLowerCase(),
    headSha: String(input.headSha).toLowerCase(),
    diffHash: String(input.diffHash).trim(),
    intentHash: String(input.intentHash).trim(),
    authorNodeId: input.authorNodeId.trim(),
    coAuthorNodeIds: coAuthors.map((id) => String(id).trim()),
    caseIds: input.caseIds.map((id) => String(id).trim()),
    sourcePacketId: String(input.sourcePacketId).trim(),
    refsManifestSha256: String(input.refsManifestSha256).toLowerCase(),
    risk: input.risk,
  };
}

/**
 * Route an evaluation: pick the broker of record, the reviewer team, and the
 * concrete reviewer lanes. Recusal is enforced by construction: the author
 * and declared co-authors can never appear in a reviewer lane.
 *
 * registry: [{ nodeId, team: "T1"|"T2", formalReviewEligible: boolean }]
 * Returns { brokerOfRecord, reviewerTeam, quorum, lanes:[{laneId, kind, reviewerNodeId, brief}] }.
 */
export function routeEvaluation({ input: rawInput, registry }) {
  const input = validatePresetInput(rawInput);
  if (!Array.isArray(registry)) fail("registry_invalid", "registry must be an array");

  const teamOf = new Map();
  const eligibleByTeam = { T1: [], T2: [] };
  for (const row of registry) {
    if (!isPlainObject(row) || !hasText(String(row.nodeId)) || !TEAMS.has(row.team)) continue;
    teamOf.set(String(row.nodeId).trim(), row.team);
    if (row.formalReviewEligible === true) eligibleByTeam[row.team].push(String(row.nodeId).trim());
  }

  const recused = new Set([input.authorNodeId, ...input.coAuthorNodeIds]);
  const authorTeam = teamOf.get(input.authorNodeId); // undefined → unassigned author
  const reviewerTeam = authorTeam === "T1" ? "T2" : authorTeam === "T2" ? "T1" : null;
  const quorum = input.risk === "high-risk" ? NCLEX_CONTENT_PR_PRESET_V1.quorum.highRisk : NCLEX_CONTENT_PR_PRESET_V1.quorum.normal;

  const pickFrom = (team, excluded) => eligibleByTeam[team].filter((nodeId) => !excluded.has(nodeId));

  let lanes = [];
  let chosenTeam = reviewerTeam;
  if (chosenTeam) {
    lanes = pickFrom(chosenTeam, recused).slice(0, quorum);
  } else {
    // Unassigned author: choose the team that can field the quorum after recusal.
    chosenTeam = ["T1", "T2"].find((team) => pickFrom(team, recused).length >= quorum) ?? null;
    if (chosenTeam) lanes = pickFrom(chosenTeam, recused).slice(0, quorum);
  }

  // High-risk or an understaffed team expands cross-team before failing.
  if (lanes.length < quorum) {
    const otherTeam = chosenTeam === "T1" ? "T2" : "T1";
    const expanded = [...lanes, ...pickFrom(otherTeam, new Set([...recused, ...lanes]))];
    lanes = expanded.slice(0, quorum);
    if (lanes.length >= quorum) chosenTeam = "cross-team";
  }
  if (lanes.length < quorum) {
    fail("insufficient_reviewers", `cannot field ${quorum} independent reviewers after author recusal`, {
      quorum,
      fielded: lanes.length,
    });
  }
  if (lanes.some((nodeId) => recused.has(nodeId))) {
    // Defensive invariant: recusal must hold by construction.
    fail("recusal_violation", "a recused author/co-author reached a reviewer lane");
  }
  if (new Set(lanes).size !== lanes.length) {
    fail("reviewer_duplicate", "reviewer lanes must be distinct workers");
  }

  const brokerOfRecord =
    chosenTeam === "cross-team"
      ? TEAM_BROKER_INVARIANT.team1
      : chosenTeam === "T1"
        ? TEAM_BROKER_INVARIANT.team1
        : TEAM_BROKER_INVARIANT.team2;

  const laneKinds = NCLEX_CONTENT_PR_PRESET_V1.lanes;
  return {
    brokerOfRecord,
    reviewerTeam: chosenTeam,
    quorum,
    lanes: lanes.map((nodeId, index) => ({
      laneId: `${input.repo}#${input.prNumber}-${laneKinds[index % laneKinds.length].kind}-${nodeId}`,
      kind: laneKinds[index % laneKinds.length].kind,
      reviewerNodeId: nodeId,
      brief: laneKinds[index % laneKinds.length].brief,
    })),
  };
}

/**
 * A signed receipt counts toward merge readiness only for the exact head it
 * was issued against; any head change makes prior receipts stale.
 */
export function classifyReceipts({ receipts, currentHeadSha }) {
  if (!Array.isArray(receipts)) fail("receipts_invalid", "receipts must be an array");
  const head = String(currentHeadSha ?? "").toLowerCase();
  const fresh = [];
  const stale = [];
  for (const receipt of receipts) {
    if (!isPlainObject(receipt) || !SHA40.test(String(receipt.headSha ?? ""))) {
      fail("receipt_invalid", "every receipt must carry a 40-char headSha");
    }
    (String(receipt.headSha).toLowerCase() === head ? fresh : stale).push(receipt);
  }
  return { fresh, stale };
}

/**
 * Merge-ready read model. Ready requires: GitHub gate green, enough fresh
 * signed PASS receipts on the exact head (2 normal / 3 high-risk), zero
 * blocking findings, an author-distinct GitHub approval, and no merge
 * conflict. Returns { ready, reasons } — never throws on ordinary input.
 */
export function evaluateMergeReadiness({
  gateGreen,
  currentHeadSha,
  receipts,
  blockingFindings = 0,
  authorDistinctApproval = false,
  mergeConflict = false,
  risk = "normal",
}) {
  const quorum = risk === "high-risk" ? NCLEX_CONTENT_PR_PRESET_V1.quorum.highRisk : NCLEX_CONTENT_PR_PRESET_V1.quorum.normal;
  const reasons = [];
  const { fresh, stale } = classifyReceipts({ receipts: receipts ?? [], currentHeadSha });
  const freshPasses = fresh.filter((receipt) => receipt.verdict === "PASS" && receipt.signed === true);

  if (gateGreen !== true) reasons.push("github_gate_not_green");
  if (freshPasses.length < quorum) {
    reasons.push(`insufficient_fresh_signed_pass:${freshPasses.length}/${quorum}`);
  }
  if (stale.length > 0) reasons.push(`stale_receipts_excluded:${stale.length}`);
  if (blockingFindings > 0) reasons.push(`blocking_findings:${blockingFindings}`);
  if (authorDistinctApproval !== true) reasons.push("author_distinct_approval_missing");
  if (mergeConflict === true) reasons.push("merge_conflict_present");

  return {
    ready: reasons.length === 0,
    quorum,
    freshPassCount: freshPasses.length,
    staleReceiptCount: stale.length,
    reasons,
  };
}

/**
 * Body-free one-line GitHub comment projection. Fixed shape only — no prompt,
 * no chain-of-thought, no restricted reference content.
 */
export function formatEvaluationComment({ nodeId, team, lane, headSha, verdict, receiptId }) {
  if (!hasText(String(nodeId)) || !TEAMS.has(team) || !hasText(String(lane))) {
    fail("comment_invalid", "nodeId/team/lane are required for the evaluation projection");
  }
  if (!SHA40.test(String(headSha))) fail("comment_invalid", "head must be a 40-char SHA");
  if (verdict !== "PASS" && verdict !== "BLOCK") fail("comment_invalid", "verdict must be PASS or BLOCK");
  if (!hasText(String(receiptId))) fail("comment_invalid", "receipt id is required");
  return `EVALUATION node=${String(nodeId).trim()} team=${team} lane=${String(lane).trim()} head=${String(headSha).toLowerCase()} verdict=${verdict} receipt=${String(receiptId).trim()}`;
}
