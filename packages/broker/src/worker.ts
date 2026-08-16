import { validateDockerRunnerExtraMountsReadiness } from "./workers/docker-runner-mounts-preflight.js";
import {
  buildWorkerMetadata,
  withAnalysisProbeMetadata,
  probeAnalysisArtifactReadiness,
  optionalTrimmed,
  parseBooleanEnv,
} from "./workers/worker-metadata.js";
import {
  applyWorkerRuntimeProfile,
  parsePartyKind,
  parsePartyRole,
  parsePositiveInt,
  parseWorkerCapabilities,
  parseWorkerMode,
  parseWorkerRuntimeProfile,
  requiredEnv,
} from "./workers/worker-env.js";
import {
  parseWorkerHttpSignatureConfig,
  parseBrokerIdEnv,
} from "./workers/worker-http-signature.js";
import type { WorkerA2AHttpSignatureConfig } from "./workers/worker-http-signature.js";
import {
  createWorkerHandlerFromEnv,
  DEFAULT_HANDLER_TIMEOUT_MS,
  type WorkerTaskHandler,
} from "./workers/task-handler-factories.js";
import type {
  A2APartyKind,
  RegisterWorkerRequest,
} from "./core/types.js";

// Slice 6-8 re-exports: the extracted clusters keep their public surface on
// ./worker.js so every existing consumer (tests, default-agent, workers/*)
// imports unchanged.
export type { WorkerRuntimeProfile } from "./workers/worker-metadata.js";
export type { WorkerHandlerOutcome } from "./workers/external-handler.js";
export { classifyHandlerFailure, HandlerSpawnError } from "./workers/external-handler.js";
export type { HomeBrokerLease } from "./workers/external-handler.js";
export {
  A2ABrokerWorker,
  BrokerApiError,
  MAX_RECONNECT_DELAY_MS,
  computeReconnectDelayMs,
  isBrokerConnectionError,
  validateTaskCompletionEvidence,
} from "./workers/broker-worker-client.js";
import { A2ABrokerWorker } from "./workers/broker-worker-client.js";
export { buildSubagentDirectiveEnv, buildDynamicSubagentRuntime, resolveActiveFanoutFlagKey, FANOUT_FLAG_ENV_KEYS } from "./workers/subagent-runtime.js";
export { createBuiltinWorkerHandler, createExternalWorkerHandler } from "./workers/task-handler-factories.js";
export type { BuiltinWorkerHandlerKind, ExternalWorkerHandlerConfig, WorkerTaskHandler } from "./workers/task-handler-factories.js";
export { probeAnalysisArtifactReadiness } from "./workers/worker-metadata.js";
export type { WorkerA2AHttpSignatureConfig } from "./workers/worker-http-signature.js";
export type { AnalysisArtifactProbe } from "./workers/worker-metadata.js";
export type { DynamicSubagentRuntimeOptions, DynamicSubagentRuntime, FanoutFlagKey } from "./workers/subagent-runtime.js";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_USER_AGENT = "a2a-broker-worker/0.1";
export type FetchLike = typeof fetch;

export interface BrokerWorkerConfig {
  brokerUrl: string;
  edgeSecret?: string;
  homeBrokerId?: string;
  homeBrokerLeaseFile?: string;
  worker: RegisterWorkerRequest;
  requesterKind: A2APartyKind;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  handlerTimeoutMs: number;
  /** Per-request HTTP timeout for broker calls; bounds a hung connection. */
  requestTimeoutMs?: number;
  /** Optional per-worker A2A HTTP Signature config for broker control-plane requests. */
  httpSignature?: WorkerA2AHttpSignatureConfig;
  /**
   * When not explicitly disabled (default on), the worker probes its assigned-task
   * poll path once at startup and fails startup loudly if it is unreachable or
   * unauthorized. This catches the failure mode where register/heartbeat succeed
   * but `GET /tasks?assignedWorkerId=&status=queued` is blocked, leaving the
   * worker silently idle.
   */
  pollReadinessProbe?: boolean;
  userAgent: string;
  handler: WorkerTaskHandler;
}

export function createWorkerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BrokerWorkerConfig {
  validateDockerRunnerExtraMountsReadiness(env);

  const brokerUrl = requiredEnv(env, ["BROKER_URL", "A2A_BROKER_URL"]);
  const workerId = requiredEnv(env, ["WORKER_ID", "A2A_WORKER_ID", "NODE_ID"]);
  const role = parsePartyRole(env.WORKER_ROLE ?? env.A2A_WORKER_ROLE ?? "analyst");
  const requesterKind = parsePartyKind(env.WORKER_REQUESTER_KIND ?? env.A2A_WORKER_REQUESTER_KIND ?? "node");
  const runtimeProfile = parseWorkerRuntimeProfile(env.WORKER_PROFILE ?? env.A2A_WORKER_PROFILE);
  const handlerTimeoutMs = parsePositiveInt(
    env.WORKER_HANDLER_TIMEOUT_MS ?? env.A2A_WORKER_HANDLER_TIMEOUT_MS,
    DEFAULT_HANDLER_TIMEOUT_MS,
    "WORKER_HANDLER_TIMEOUT_MS",
  );

  const baseCapabilities = applyWorkerRuntimeProfile(parseWorkerCapabilities(env, role), runtimeProfile);
  // Gate the advertisement: never publish canAnalyze=true before the selected
  // handler artifact is verified (#1597). A failed probe flips the capability
  // to false and the reason survives in metadata for the broker projection.
  const analysisProbe = probeAnalysisArtifactReadiness(env, baseCapabilities.canAnalyze === true);
  const capabilities =
    baseCapabilities.canAnalyze && analysisProbe.probed && !analysisProbe.ready
      ? { ...baseCapabilities, canAnalyze: false }
      : baseCapabilities;

  const worker: RegisterWorkerRequest = {
    nodeId: workerId,
    role,
    displayName: optionalTrimmed(env.WORKER_DISPLAY_NAME ?? env.A2A_WORKER_DISPLAY_NAME),
    brokerUrl: optionalTrimmed(env.WORKER_PUBLIC_URL ?? env.A2A_WORKER_PUBLIC_URL),
    capabilities,
    workerMode: parseWorkerMode(env.WORKER_MODE ?? env.A2A_WORKER_MODE),
    metadata: withAnalysisProbeMetadata(buildWorkerMetadata(env, runtimeProfile), analysisProbe, env),
  };

  return {
    brokerUrl,
    edgeSecret: optionalTrimmed(
      env.BROKER_EDGE_SECRET ?? env.A2A_BROKER_EDGE_SECRET ?? env.EDGE_SECRET ?? env.A2A_EDGE_SECRET,
    ),
    homeBrokerId: parseBrokerIdEnv(env.A2A_HOME_BROKER_ID ?? env.HOME_BROKER_ID, "A2A_HOME_BROKER_ID"),
    homeBrokerLeaseFile: optionalTrimmed(env.A2A_HOME_BROKER_LEASE_FILE ?? env.HOME_BROKER_LEASE_FILE),
    worker,
    requesterKind,
    pollIntervalMs: parsePositiveInt(
      env.WORKER_POLL_INTERVAL_MS ?? env.A2A_WORKER_POLL_INTERVAL_MS,
      DEFAULT_POLL_INTERVAL_MS,
      "WORKER_POLL_INTERVAL_MS",
    ),
    heartbeatIntervalMs: parsePositiveInt(
      env.WORKER_HEARTBEAT_INTERVAL_MS ?? env.A2A_WORKER_HEARTBEAT_INTERVAL_MS,
      DEFAULT_HEARTBEAT_INTERVAL_MS,
      "WORKER_HEARTBEAT_INTERVAL_MS",
    ),
    handlerTimeoutMs,
    requestTimeoutMs: parsePositiveInt(
      env.WORKER_REQUEST_TIMEOUT_MS ?? env.A2A_WORKER_REQUEST_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
      "WORKER_REQUEST_TIMEOUT_MS",
    ),
    httpSignature: parseWorkerHttpSignatureConfig(env),
    pollReadinessProbe: parseBooleanEnv(
      env.WORKER_POLL_READINESS_PROBE ?? env.A2A_WORKER_POLL_READINESS_PROBE,
      true,
    ),
    userAgent: optionalTrimmed(env.WORKER_USER_AGENT ?? env.A2A_WORKER_USER_AGENT) ?? DEFAULT_USER_AGENT,
    handler: createWorkerHandlerFromEnv(env, handlerTimeoutMs, runtimeProfile),
  };
}

export async function startWorkerFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const worker = new A2ABrokerWorker(createWorkerConfigFromEnv(env));
  const shutdown = async (signal: string) => {
    console.log(`[worker:${worker.workerId}] received ${signal}, shutting down`);
    await worker.stop();
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  await worker.run();
}


if (import.meta.url === new URL(process.argv[1] ?? "", "file://").href) {
  startWorkerFromEnv().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
