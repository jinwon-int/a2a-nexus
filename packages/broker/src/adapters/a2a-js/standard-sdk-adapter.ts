import type { AgentCard } from "../../a2a/agent-card.js";

export interface A2AJsWorkerRegistration {
  nodeId: string;
  displayName: string;
  role: "analyst" | "hub" | "operator" | "live-trader";
  workerMode: "external-sdk";
  runtimeFlavor: "a2a-js";
  capabilities: {
    canAnalyze: boolean;
    canProposePatch: boolean;
    canStream: boolean;
    canReceivePushNotifications: boolean;
  };
  metadata: {
    adapter: "a2a-js";
    agentCardUrl: string;
    protocolVersion: string;
    sdk: "a2aproject/a2a-js";
  };
}

export type A2AJsTaskState = "pending" | "submitted" | "working" | "input-required" | "completed" | "failed" | "canceled" | "unknown";

export interface BrokerTerminalEvidenceDraft {
  outcome: "done" | "blocked" | "failed" | "canceled" | "running";
  terminal: boolean;
  reason: string;
}

function publicSafeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "external-a2a-js-worker";
}

export function mapAgentCardToWorkerRegistration(card: AgentCard, options: { nodeIdPrefix?: string } = {}): A2AJsWorkerRegistration {
  const prefix = options.nodeIdPrefix ?? "a2a-js";
  const firstJsonRpc = card.supportedInterfaces.find((iface) => iface.protocolBinding === "JSONRPC");
  return {
    nodeId: `${prefix}-${publicSafeId(card.name)}`,
    displayName: card.name,
    role: "analyst",
    workerMode: "external-sdk",
    runtimeFlavor: "a2a-js",
    capabilities: {
      canAnalyze: card.skills.some((skill) => /analy[sz]e|research|task/i.test(`${skill.id} ${skill.name} ${skill.description}`)),
      canProposePatch: card.skills.some((skill) => /patch|code|change/i.test(`${skill.id} ${skill.name} ${skill.description}`)),
      canStream: Boolean(card.capabilities.streaming),
      canReceivePushNotifications: Boolean(card.capabilities.pushNotifications),
    },
    metadata: {
      adapter: "a2a-js",
      agentCardUrl: firstJsonRpc?.url ?? card.url,
      protocolVersion: card.protocolVersion,
      sdk: "a2aproject/a2a-js",
    },
  };
}

export function mapA2AJsTaskStateToBrokerEvidence(state: A2AJsTaskState): BrokerTerminalEvidenceDraft {
  switch (state) {
    case "completed": return { outcome: "done", terminal: true, reason: "a2a-js task completed" };
    case "failed": return { outcome: "failed", terminal: true, reason: "a2a-js task failed" };
    case "canceled": return { outcome: "canceled", terminal: true, reason: "a2a-js task canceled" };
    case "input-required": return { outcome: "blocked", terminal: true, reason: "a2a-js task requires input" };
    case "pending":
    case "submitted":
    case "working": return { outcome: "running", terminal: false, reason: `a2a-js task ${state}` };
    default: return { outcome: "blocked", terminal: true, reason: "a2a-js task state is unknown" };
  }
}
