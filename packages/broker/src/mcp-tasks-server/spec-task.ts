/**
 * Proto-JSON A2A task (broker JSON-RPC `GetTask`) → facade input, and the
 * `CallToolResult` for a completed task (a2a-nexus #2591 design §7-2, Q3).
 *
 * The JSON-RPC projection carries the A2A state but no checkpoint detail
 * (id, decision type, recordedAt) and no approval record. So every
 * `TASK_STATE_INPUT_REQUIRED` is treated as an operator-decision wait: the
 * facade then shows it as `working` with no `inputRequests` (G3), and the
 * server never offers a clarification it cannot key safely (G2). Clarification
 * over MCP needs a broker projection change and is out of scope here.
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

/** Placeholder checkpoint for an input-required spec task: no decision type, so the facade classifies it as an operator decision. */
function operatorWaitCheckpoint(timestamp: string): NonNullable<FacadeTask["checkpoint"]> {
  return { state: "awaiting_operator", checkpointId: "spec-projection", recordedAt: timestamp, recordedBy: "broker" };
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
      return { ...base, status: "running", checkpoint: operatorWaitCheckpoint(timestamp) };
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
