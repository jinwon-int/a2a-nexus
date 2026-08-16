import { validateDockerRunnerExtraMountsReadiness } from "./workers/docker-runner-mounts-preflight.js";
import {
  buildSubagentDirectiveEnv,
  buildDynamicSubagentRuntime,
  resolveActiveFanoutFlagKey,
  FANOUT_FLAG_ENV_KEYS,
} from "./workers/subagent-runtime.js";
import {
  finalizeSubagentEvidence,
  type RuntimeSubagentEvidenceContext,
} from "./workers/subagent-evidence.js";
import {
  buildWorkerMetadata,
  withAnalysisProbeMetadata,
  probeAnalysisArtifactReadiness,
  optionalTrimmed,
  parseBooleanEnv,
} from "./workers/worker-metadata.js";
import {
  handlerExitNonzeroError,
  runExternalHandler,
  normalizeExternalTaskError,
  type WorkerHandlerOutcome,
} from "./workers/external-handler.js";
import {
  applyWorkerRuntimeProfile,
  buildWorkerHandlerEnv,
  parseBoundedSubagentCap,
  parseBuiltinWorkerHandlerKind,
  parsePartyKind,
  parsePartyRole,
  parsePositiveInt,
  parseStringArrayEnv,
  parseWorkerCapabilities,
  parseWorkerMode,
  parseWorkerRuntimeProfile,
  requiredEnv,
  type WorkerRuntimeProfile,
} from "./workers/worker-env.js";
import {
  parseWorkerHttpSignatureConfig,
  parseBrokerIdEnv,
} from "./workers/worker-http-signature.js";
import type { WorkerA2AHttpSignatureConfig } from "./workers/worker-http-signature.js";
import type { A2AWorkerSubagentRedactionMode } from "a2a-attestation";
import type {
  A2APartyKind,
  RegisterWorkerRequest,
  TaskRecord,
  TaskResult,
} from "./core/types.js";

// Slice 6/7 re-exports: the extracted clusters keep their public surface on
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

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_HANDLER_TIMEOUT_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_USER_AGENT = "a2a-broker-worker/0.1";
export type FetchLike = typeof fetch;
export type BuiltinWorkerHandlerKind = "noop" | "echo";
export type WorkerTaskHandler = (task: TaskRecord) => Promise<WorkerHandlerOutcome | TaskResult | void>;

export interface ExternalWorkerHandlerConfig {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /**
   * Conductor identity/budget for the subagent directive injected per task.
   * The node instance is the orchestra conductor: simple tasks are executed
   * directly; heavy tasks may fan out to at most `subagentCap` (default 4)
   * evidence-only subagents. Set `subagentDirectiveDisabled` to skip
   * injection entirely.
   */
  workerId?: string;
  subagentCap?: number;
  subagentDirectiveDisabled?: boolean;
  subagentExecutionIsolation?: "isolated" | "shared";
}

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

export { buildSubagentDirectiveEnv, buildDynamicSubagentRuntime, resolveActiveFanoutFlagKey, FANOUT_FLAG_ENV_KEYS };
export { probeAnalysisArtifactReadiness } from "./workers/worker-metadata.js";
export type { WorkerA2AHttpSignatureConfig } from "./workers/worker-http-signature.js";
export type { AnalysisArtifactProbe } from "./workers/worker-metadata.js";
export type { DynamicSubagentRuntimeOptions, DynamicSubagentRuntime, FanoutFlagKey } from "./workers/subagent-runtime.js";

export function createBuiltinWorkerHandler(kind: BuiltinWorkerHandlerKind): WorkerTaskHandler {
  switch (kind) {
    case "noop":
      return async (task) => ({
        result: {
          summary: `noop handled ${task.intent}`,
          note: task.message,
        },
      });
    case "echo":
      return async (task) => ({
        result: {
          summary: task.message ?? `echo handled ${task.intent}`,
          note: `echo handled task ${task.id}`,
          output: {
            taskId: task.id,
            intent: task.intent,
            message: task.message,
            payload: task.payload,
            proposalId: task.proposalId,
            exchangeId: task.exchangeId,
          },
        },
      });
    default:
      throw new Error("unhandled built-in worker handler kind");
  }
}

/**
 * Externally-supplied trace ids land in process/container env, so bound them
 * to a safe charset and length before propagation. Returns undefined for an
 * absent or out-of-policy value.
 */
function sanitizeTraceId(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 128) return undefined;
  return /^[A-Za-z0-9._:-]+$/.test(trimmed) ? trimmed : undefined;
}

export function createExternalWorkerHandler(config: ExternalWorkerHandlerConfig): WorkerTaskHandler {
  if (!config.command?.trim()) {
    throw new Error("external handler command is required");
  }

  const args = [...(config.args ?? [])];
  const timeoutMs = Math.max(1, config.timeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS);

  return async (task) => {
    // Propagate the distributed-trace id end to end: requester -> broker
    // (task.via.traceId) -> the handler process (and any container it spawns)
    // -> evidence. A2A_TRACE_ID lets the in-handler/in-container work correlate
    // back to the originating request.
    const traceId = sanitizeTraceId(task.via?.traceId);
    const traceEnv = traceId ? { A2A_TRACE_ID: traceId } : {};
    const directiveEnv = config.subagentDirectiveDisabled
      ? {}
      : buildSubagentDirectiveEnv(task, {
          workerId: config.workerId ?? "worker",
          subagentCap: config.subagentCap ?? 4,
          executionIsolation: config.subagentExecutionIsolation ?? "shared",
        });
    const directiveBudget = config.subagentDirectiveDisabled
      ? null
      : Number(directiveEnv.A2A_SUBAGENT_MAX ?? 0);
    // piri reuse WS1 (#1836): fanout is keyed per lane. The active lane is
    // resolved once from the runner env (claude-code wins a both-set tie — the
    // runner emits exactly one); the same key threads through the dynamic
    // runtime emission and every read-back below.
    const fanoutFlagKey = resolveActiveFanoutFlagKey(config.env ?? {});
    const fanoutFlagEnvKey = FANOUT_FLAG_ENV_KEYS[fanoutFlagKey ?? "claude-code"];
    const dynamicRuntime = buildDynamicSubagentRuntime(task, {
      workerId: config.workerId ?? "worker",
      subagentCap: config.subagentCap ?? 4,
      executionIsolation: config.subagentExecutionIsolation ?? "shared",
      fanoutEnabled: config.env?.[fanoutFlagEnvKey] === "1",
      fanoutFlagKey,
      staticRunnerMax: Number(config.env?.A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_MAX ?? 0),
      staticRunnerRoles: (config.env?.A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_ROLES ?? "")
        .split(",")
        .map((role) => role.trim())
        .filter(Boolean),
    });
    const dynamicDirectiveBudget = dynamicRuntime.env[fanoutFlagEnvKey] === "1"
      ? Number(dynamicRuntime.env.A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_MAX ?? 0)
      : dynamicRuntime.env[fanoutFlagEnvKey] === "0"
        ? 0
        : directiveBudget;
    const configuredOutputBytes = Number(config.env?.A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_OUTPUT_BYTES ?? 12_000);
    const subagentOutputBytes = Number.isInteger(configuredOutputBytes) && configuredOutputBytes > 0
      ? Math.min(configuredOutputBytes, 64 * 1024)
      : 12_000;
    const subagentRedactionMode: A2AWorkerSubagentRedactionMode =
      config.env?.A2A_WORKER_SUBAGENT_REDACTION_MODE === "reject" ? "reject" : "redact";
    const runtimeEvidenceContext: RuntimeSubagentEvidenceContext = {
      fanoutEnabled: dynamicRuntime.env[fanoutFlagEnvKey] === "1",
      workerId: config.workerId ?? "worker",
      taskId: task.id,
      planJson: dynamicRuntime.env["A2A_SUBAGENT_PLAN"],
      maxOutputBytes: subagentOutputBytes,
      redactionMode: subagentRedactionMode,
    };
    const handlerInput = dynamicRuntime.subagentContextBrief
      ? { ...task, subagentContextBrief: dynamicRuntime.subagentContextBrief }
      : task;
    const { stdout, stderr, code, signal, timedOut } = await runExternalHandler({
      command: config.command,
      args,
      cwd: config.cwd,
      env: { ...config.env, ...traceEnv, ...directiveEnv, ...dynamicRuntime.env },
      timeoutMs,
      input: JSON.stringify(handlerInput),
    });

    if (timedOut) {
      return {
        error: {
          code: "handler_timeout",
          message: `handler timed out after ${timeoutMs}ms`,
          details: { command: config.command, args },
        },
      } satisfies WorkerHandlerOutcome;
    }

    if (code !== 0) {
      return {
        error: handlerExitNonzeroError({ command: config.command, args, code, signal, stdout, stderr }),
      } satisfies WorkerHandlerOutcome;
    }

    const trimmed = stdout.trim();
    if (!trimmed) {
      return {
        error: {
          code: "handler_invalid_output",
          message: "handler must write a JSON result to stdout",
          details: { command: config.command, args },
        },
      } satisfies WorkerHandlerOutcome;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      return {
        error: {
          code: "handler_invalid_output",
          message: "handler stdout must be valid JSON",
          details: {
            command: config.command,
            args,
            parseError: error instanceof Error ? error.message : String(error),
            stdout: trimmed,
          },
        },
      } satisfies WorkerHandlerOutcome;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        error: {
          code: "handler_invalid_output",
          message: "handler stdout JSON must be an object",
          details: { command: config.command, args, stdout: trimmed },
        },
      } satisfies WorkerHandlerOutcome;
    }

    const record = parsed as Record<string, unknown>;
    if (record.error) {
      return {
        error: normalizeExternalTaskError(record.error),
      } satisfies WorkerHandlerOutcome;
    }

    if (record.result && typeof record.result === "object" && !Array.isArray(record.result)) {
      return finalizeSubagentEvidence(record.result as TaskResult, dynamicDirectiveBudget, config.command, runtimeEvidenceContext);
    }

    return finalizeSubagentEvidence(record as TaskResult, dynamicDirectiveBudget, config.command, runtimeEvidenceContext);
  };
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

function createWorkerHandlerFromEnv(
  env: NodeJS.ProcessEnv,
  handlerTimeoutMs: number,
  runtimeProfile?: WorkerRuntimeProfile,
): WorkerTaskHandler {
  const command = optionalTrimmed(env.WORKER_HANDLER_COMMAND ?? env.A2A_WORKER_HANDLER_COMMAND);
  if (command) {
    return createExternalWorkerHandler({
      command,
      args: parseStringArrayEnv(env.WORKER_HANDLER_ARGS_JSON ?? env.A2A_WORKER_HANDLER_ARGS_JSON),
      cwd: optionalTrimmed(env.WORKER_HANDLER_CWD ?? env.A2A_WORKER_HANDLER_CWD),
      env: buildWorkerHandlerEnv(env, runtimeProfile),
      timeoutMs: handlerTimeoutMs,
      workerId: optionalTrimmed(env.WORKER_ID ?? env.A2A_WORKER_ID),
      subagentCap: parseBoundedSubagentCap(env.WORKER_SUBAGENT_CAP),
      subagentDirectiveDisabled: env.WORKER_SUBAGENT_DIRECTIVE_DISABLED === "1",
    });
  }

  const builtin = parseBuiltinWorkerHandlerKind(
    env.WORKER_HANDLER_BUILTIN ?? env.A2A_WORKER_HANDLER_BUILTIN ?? "echo",
  );
  return createBuiltinWorkerHandler(builtin);
}


if (import.meta.url === new URL(process.argv[1] ?? "", "file://").href) {
  startWorkerFromEnv().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
