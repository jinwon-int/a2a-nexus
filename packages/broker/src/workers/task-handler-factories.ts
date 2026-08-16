/**
 * Task-handler factories (#1601 churn relief, extracted from worker.ts slice 8).
 *
 * The "which handler runs a task" half of the worker: the built-in noop/echo
 * factories, the env → handler selection (createWorkerHandlerFromEnv), and
 * the external task-handler factory (createExternalWorkerHandler) that
 * composes the subagent directive + dynamic-runtime env injection, runs the
 * operator's command via external-handler.ts, parses its stdout JSON into a
 * TaskResult, and funnels every success through finalizeSubagentEvidence.
 *
 * Pure move from worker.ts — worker.ts keeps re-exporting every public name
 * so all existing ./worker.js consumers import unchanged.
 */

import {
  buildSubagentDirectiveEnv,
  buildDynamicSubagentRuntime,
  resolveActiveFanoutFlagKey,
  FANOUT_FLAG_ENV_KEYS,
} from "./subagent-runtime.js";
import {
  finalizeSubagentEvidence,
  type RuntimeSubagentEvidenceContext,
} from "./subagent-evidence.js";
import {
  handlerExitNonzeroError,
  runExternalHandler,
  normalizeExternalTaskError,
  type WorkerHandlerOutcome,
} from "./external-handler.js";
import { optionalTrimmed } from "./worker-metadata.js";
import {
  buildWorkerHandlerEnv,
  parseBoundedSubagentCap,
  parseBuiltinWorkerHandlerKind,
  parseStringArrayEnv,
  type WorkerRuntimeProfile,
} from "./worker-env.js";
import type { A2AWorkerSubagentRedactionMode } from "a2a-attestation";
import type { TaskRecord, TaskResult } from "../core/types.js";

export const DEFAULT_HANDLER_TIMEOUT_MS = 60_000;

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

export function createWorkerHandlerFromEnv(
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
