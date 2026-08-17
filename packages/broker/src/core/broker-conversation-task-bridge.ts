// Trusted Conversation Plane — C3 slice 1: the task↔conversation bridge
// (spec: docs/specs/trusted-conversation-plane/spec.md, frozen #1861; track
// #1863). Two directions:
//
// 1. Task result → bounded conversation reply. A terminal (or checkpointed)
//    task result projects as ONE reply message via the normal accept path, so
//    every envelope rule applies (redaction gate, byte budgets, turn budget,
//    digest-first audit, idempotency). The projection is deterministic: the
//    messageId/idempotencyKey derive from (taskId, status), so re-projecting
//    converges instead of duplicating.
// 2. Conversation reply → input-required resume. When an accepted reply
//    references a task (taskId or referenceTaskIds) whose checkpoint is
//    awaiting_operator (the A2A 1.0 input-required projection), the checkpoint
//    resumes exactly once — duplicate replies converge at the envelope layer
//    BEFORE reaching this bridge, and resumeTask itself is idempotent when the
//    checkpoint is already cleared, so there is no double resume.
//
// The envelope's taskId presence remains the single task-turn/message-turn
// distinction (spec §field rules): bridge replies carry taskId; pure message
// turns do not touch task lifecycle.

import { BrokerError } from "./broker-error.js";
import type { A2AConversationState } from "./broker-conversation.js";

export const TASK_RESULT_REPLY_MAX_BYTES = 2048;

export interface BridgeTaskLike {
  id: string;
  status: string;
  claimedBy?: string;
  result?: { summary?: string; note?: string; artifactIds?: string[] };
}

export interface TaskResultReplyEnvelope {
  messageId: string;
  kind: "reply";
  sender: { kind: "worker"; id: string; homeBrokerId: string };
  recipients: Array<{ kind: string; id: string; homeBrokerId: string }>;
  taskId: string;
  idempotencyKey: string;
  content: { text: string };
}

function boundText(value: string, max: number): string {
  const flat = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ");
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Build the deterministic bounded reply envelope for a task result. The
 * envelope is shaped for acceptBrokerConversationMessage — the caller does NOT
 * bypass any accept-time gate.
 */
export function buildTaskResultReplyEnvelope(
  conversation: A2AConversationState,
  task: BridgeTaskLike,
  options: {
    /** Defaults to the conversation's root sender. */
    recipients?: Array<{ kind: string; id: string; homeBrokerId: string }>;
  } = {},
): TaskResultReplyEnvelope {
  if (!task.claimedBy) {
    throw new BrokerError("bad_request", `task ${task.id} has no worker to project a reply from`);
  }
  const lines = [
    `task=${task.id}`,
    `status=${task.status}`,
  ];
  if (task.result?.summary) lines.push(`summary=${boundText(task.result.summary, 512)}`);
  if (task.result?.note) lines.push(`note=${boundText(task.result.note, 512)}`);
  if (task.result?.artifactIds?.length) {
    lines.push(`artifacts=${task.result.artifactIds.slice(0, 8).join(",")}`);
  }
  // Hard byte cap on the projection — the envelope byte budget is the outer
  // guard; this keeps task-turn replies categorically small.
  const text = boundText(lines.join("\n"), TASK_RESULT_REPLY_MAX_BYTES);
  return {
    messageId: `task-${task.id}-result-${task.status}`,
    kind: "reply",
    sender: { kind: "worker", id: task.claimedBy, homeBrokerId: conversation.homeBrokerId },
    recipients: options.recipients ?? [{ ...parseParticipantKey(conversation, 0) }],
    taskId: task.id,
    idempotencyKey: `taskresult:${task.id}:${task.status}`,
    content: { text },
  };
}

function parseParticipantKey(conversation: A2AConversationState, index: number): { kind: string; id: string; homeBrokerId: string } {
  // participants[] entries are "kind:id:homeBrokerId"; the root sender is the
  // first participant recorded by openBrokerConversation.
  const key = conversation.participants[index];
  if (!key) throw new BrokerError("bad_request", "conversation has no participants to address a reply to");
  const parts = key.split(":");
  if (parts.length !== 3) throw new BrokerError("bad_request", `conversation participant key malformed: ${key}`);
  return { kind: parts[0], id: parts[1], homeBrokerId: parts[2] };
}

/** Kinds that may resume an awaiting_operator checkpoint (spec: reply turns). */
export const RESUMING_MESSAGE_KINDS: ReadonlySet<string> = new Set(["reply", "clarification", "decision"]);

export function taskReferencesOf(message: { taskId?: string; referenceTaskIds?: string[] }): string[] {
  const refs = new Set<string>();
  if (message.taskId) refs.add(message.taskId);
  for (const ref of message.referenceTaskIds ?? []) refs.add(ref);
  return [...refs];
}
