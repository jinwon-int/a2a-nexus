/**
 * Proto-JSON A2A task (broker JSON-RPC `GetTask`) → facade input, and the
 * `CallToolResult` for a completed task (a2a-nexus #2591 design §7-2, Q3).
 *
 * Since #2606 the JSON-RPC projection carries a public-safe checkpoint
 * summary (`metadata.checkpoint`: state, checkpointId, decisionType,
 * recordedAt — never the reason text). With a well-formed summary the facade
 * classifies the wait itself: only `ambiguous_scope` is a clarification
 * (`input_required`, keyed per checkpoint, G2); every other decision type is
 * an operator decision (`working`, no `inputRequests`, G3). Without one — an
 * older broker, or a malformed summary — every `TASK_STATE_INPUT_REQUIRED`
 * fails closed to an operator wait.
 */
import { redactSecrets } from "a2a-attestation";

import { projectMcpTask, mcpToolOutcomeForTask } from "../a2a/mcp-tasks-facade.js";
import type { SpecTask } from "./broker-client.js";

type FacadeTask = Parameters<typeof projectMcpTask>[0];

/** Q3: cap on the text a completed task puts into the model's context. */
export const MCP_RESULT_TEXT_MAX_CHARS = 16_000;

export class SpecTaskShapeError extends Error {
  constructor(reason: string) {
    super(`broker task projection not understood: ${reason}`);
    this.name = "SpecTaskShapeError";
  }
}

type FacadeCheckpoint = NonNullable<FacadeTask["checkpoint"]>;

/** Placeholder checkpoint for an input-required spec task: no decision type, so the facade classifies it as an operator decision. */
function operatorWaitCheckpoint(timestamp: string): FacadeCheckpoint {
  return { state: "awaiting_operator", checkpointId: "spec-projection", recordedAt: timestamp, recordedBy: "broker" };
}

const SUMMARY_KEYS = new Set(["state", "checkpointId", "decisionType", "recordedAt"]);

/**
 * The broker's public checkpoint summary (#2606), or `undefined` if it is
 * absent or not exactly the expected shape. Unknown keys are refused rather
 * than ignored, so a projection that starts carrying more than the summary is
 * noticed instead of silently trusted.
 */
export function checkpointFromSpecSummary(value: unknown): FacadeCheckpoint | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const summary = value as Record<string, unknown>;
  if (Object.keys(summary).some((key) => !SUMMARY_KEYS.has(key))) return undefined;
  if (summary.state !== "awaiting_operator") return undefined;
  if (typeof summary.checkpointId !== "string" || typeof summary.recordedAt !== "string") return undefined;
  if (summary.decisionType !== undefined && typeof summary.decisionType !== "string") return undefined;
  return {
    state: "awaiting_operator",
    checkpointId: summary.checkpointId,
    recordedAt: summary.recordedAt,
    recordedBy: "broker",
    ...(summary.decisionType ? { decisionType: summary.decisionType as FacadeCheckpoint["decisionType"] } : {}),
  };
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value ? value : undefined;
}

export function facadeTaskFromSpec(spec: SpecTask): FacadeTask {
  const timestamp = spec.status.timestamp ?? stringField(spec.metadata, "updatedAt");
  const createdAt = stringField(spec.metadata, "createdAt") ?? timestamp;
  const updatedAt = stringField(spec.metadata, "updatedAt") ?? timestamp;
  if (!timestamp || !createdAt || !updatedAt) throw new SpecTaskShapeError("missing timestamps");
  const base = { id: spec.id, createdAt, updatedAt };
  switch (spec.status.state) {
    case "TASK_STATE_SUBMITTED":
      return { ...base, status: "queued" };
    case "TASK_STATE_WORKING":
      return { ...base, status: "running" };
    case "TASK_STATE_INPUT_REQUIRED":
      return { ...base, status: "running", checkpoint: checkpointFromSpecSummary(spec.metadata?.checkpoint) ?? operatorWaitCheckpoint(timestamp) };
    case "TASK_STATE_AUTH_REQUIRED":
      return { ...base, status: "blocked" };
    case "TASK_STATE_COMPLETED":
      return { ...base, status: "succeeded" };
    case "TASK_STATE_FAILED":
      return { ...base, status: "failed" };
    case "TASK_STATE_CANCELED":
      return { ...base, status: "canceled" };
    case "TASK_STATE_REJECTED":
      return {
        ...base,
        status: "canceled",
        approvalOutcome: { status: "rejected", approvalId: "spec-projection", decidedAt: timestamp, decidedBy: "operator" },
      };
    default:
      // Unknown or UNSPECIFIED state: fail closed rather than guess a status.
      throw new SpecTaskShapeError("unknown task state");
  }
}

function textParts(parts: unknown): string[] {
  if (!Array.isArray(parts)) return [];
  return parts.flatMap((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? [(part as { text: string }).text] : []));
}

/** Caps after redaction, so a cut never splits a redaction marker back into secret text. */
export function capResultText(text: string, max = MCP_RESULT_TEXT_MAX_CHARS): string {
  if (text.length <= max) return text;
  const omitted = text.length - max;
  return `${text.slice(0, max)}\n[truncated: ${omitted} characters omitted]`;
}

export interface McpCallToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
}

/**
 * Q3: the `CallToolResult` of a completed task. It reuses the broker's own
 * public projection (status message and artifact text parts from
 * `projectSpecTask`), runs the shared egress redactor over it, and caps it.
 * Non-text parts (urls, data) are referenced by artifact id only.
 */
export function callToolResultForSpec(spec: SpecTask): McpCallToolResult | undefined {
  const outcome = mcpToolOutcomeForTask(facadeTaskFromSpec(spec));
  if (!outcome) return undefined;
  const sections: string[] = [];
  if (outcome.isError) sections.push(outcome.reason);
  sections.push(...textParts(spec.status.message?.parts));
  for (const artifact of spec.artifacts ?? []) {
    const texts = textParts(artifact.parts);
    if (texts.length) sections.push(...texts);
    else if (typeof artifact.artifactId === "string") sections.push(`[artifact ${artifact.artifactId}]`);
  }
  const text = capResultText(redactSecrets(sections.join("\n\n")));
  return { content: [{ type: "text", text }], isError: outcome.isError };
}
