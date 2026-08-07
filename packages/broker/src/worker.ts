import { spawn } from "node:child_process";
import { createHash, createPrivateKey, randomUUID, sign } from "node:crypto";
import { accessSync, constants as fsConstants, existsSync, readdirSync, statSync } from "node:fs";
import { delimiter as pathDelimiter, isAbsolute, join as joinPath, resolve as resolvePath } from "node:path";
import {
  buildA2AWorkerSubagentOrchestrationPolicy,
  type A2AWorkerSubagentTaskProfile,
} from "a2a-attestation";
import {
  buildA2AWorkerSubagentBudgetCounter,
  extractA2AWorkerSubagentBudgetCounterInput,
} from "a2a-attestation";
import {
  buildA2AWorkerSubagentContextBrief,
  extractA2AWorkerSubagentContextBriefInput,
  renderA2AWorkerSubagentContextBriefMarkdown,
} from "./core/worker-subagent-context-brief.js";
import {
  buildA2AWorkerSubagentSpawnGateDecision,
  extractA2AWorkerSubagentSpawnGateDecisionInput,
} from "a2a-attestation";
import { redactSecretsText } from "a2a-attestation";
import { readGeneratedBuildInfo } from "./broker-build-info.js";
import {
  buildA2AWorkerSubagentRedactionGate,
  type A2AWorkerSubagentRedactionMode,
} from "a2a-attestation";
import { buildA2AWorkerSubagentEvidenceAssembly } from "a2a-attestation";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { validateGithubTaskCompletionEvidence } from "./core/github-task-completion.js";
import { normalizeTaskResult } from "./core/broker-task-record-normalizers.js";
import { signTaskResultProvenance } from "a2a-attestation";
import { parseTaskAcceptance, runTaskAcceptance, validateAcceptanceEvidence } from "./worker-acceptance.js";
import { validateReviewEvidence } from "./worker-review.js";
import { buildA2AHttpSignatureBase } from "./core/request-security.js";
import type {
  A2APartyKind,
  A2APartyRole,
  WorkerView,
  WorkerRegistrationResponse,
  RegisterWorkerRequest,
  SubmitValidationRequest,
  ProposalActorRequest,
  ApplyProposalRequest,
  CreateProposalRequest,
  ChangeProposal,
  ProposalDetails,
  TaskError,
  TaskRecord,
  TaskResult,
  WorkerHeartbeatRequest,
} from "./core/types.js";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_HANDLER_TIMEOUT_MS = 60_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_USER_AGENT = "a2a-broker-worker/0.1";
const HTTP_SIGNATURE_PARAM_VALUE_RE = /^[A-Za-z0-9._~:/@-]{1,256}$/;

export type FetchLike = typeof fetch;
export type BuiltinWorkerHandlerKind = "noop" | "echo";

export interface WorkerA2AHttpSignatureConfig {
  keyid: string;
  privateKeyJwk: Record<string, unknown>;
  brokerId: string;
  expiresAfterSec?: number;
  nowEpochSeconds?: () => number;
  nonceFactory?: () => string;
}
type WorkerRuntimeProfile = "broker-poll-only" | "openclaw-poll-only";

export interface WorkerHandlerOutcome {
  result?: TaskResult;
  error?: TaskError;
}

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

interface TaskListResponse {
  items: TaskRecord[];
}

interface ErrorResponseBody {
  error?: {
    code?: string;
    message?: string;
  };
}

interface BrokerHealthResponse {
  brokerId?: unknown;
}

interface HomeBrokerLease {
  brokerId: string;
  brokerUrl: string;
  workerId: string;
  createdAt: string;
}

export class BrokerApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "BrokerApiError";
  }
}

/** Ceiling for the jittered reconnect backoff (#1405). */
export const MAX_RECONNECT_DELAY_MS = 30_000;

const CONNECTION_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * Classify errors that mean "the broker connection went away" (#1405) —
 * socket resets/refusals during a broker redeploy, plus the broker's own
 * 503 broker_draining shutdown notice. These are the failures a fleet must
 * retry with bounded jitter instead of reconnecting in lockstep.
 */
export function isBrokerConnectionError(error: unknown): boolean {
  if (error instanceof BrokerApiError) {
    return error.status === 503 && error.code === "broker_draining";
  }
  for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
    const code = (cause as Error & { code?: unknown }).code;
    if (typeof code === "string" && CONNECTION_ERROR_CODES.has(code)) {
      return true;
    }
    if (cause.name === "TimeoutError" || cause.name === "AbortError") {
      return true;
    }
  }
  return false;
}

/**
 * Bounded, jittered reconnect delay (#1405): exponential from the poll
 * interval up to MAX_RECONNECT_DELAY_MS, with +/-25% jitter so a fleet whose
 * broker restarted does not thundering-herd the fresh instance. Pure —
 * `random` is injectable for tests.
 */
export function computeReconnectDelayMs(
  baseMs: number,
  consecutiveFailures: number,
  random: () => number = Math.random,
): number {
  const attempt = Math.max(1, consecutiveFailures);
  const exponential = Math.min(baseMs * 2 ** (attempt - 1), MAX_RECONNECT_DELAY_MS);
  const jitter = 1 + (random() * 0.5 - 0.25);
  return Math.max(0, Math.round(exponential * jitter));
}

export class A2ABrokerWorker {
  private readonly brokerUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly config: BrokerWorkerConfig;
  private running = false;
  private stopping = false;
  private heartbeatInFlight = false;
  private stopHeartbeatLoop: (() => void) | null = null;
  private loopAbort: (() => void) | null = null;
  private homeBrokerVerified = false;
  private initialHeartbeatSent = false;

  constructor(config: BrokerWorkerConfig, options?: { fetchImpl?: FetchLike }) {
    this.config = config;
    this.fetchImpl = options?.fetchImpl ?? fetch;
    this.brokerUrl = normalizeBrokerUrl(config.brokerUrl);
  }

  get workerId(): string {
    return this.config.worker.nodeId;
  }

  async register(): Promise<WorkerRegistrationResponse> {
    return this.requestJson<WorkerRegistrationResponse>("/workers/register", {
      method: "POST",
      body: this.config.worker,
    });
  }

  async heartbeat(): Promise<WorkerView> {
    const body: WorkerHeartbeatRequest = this.initialHeartbeatSent
      ? {}
      : {
          displayName: this.config.worker.displayName,
          brokerUrl: this.config.worker.brokerUrl,
          capabilities: this.config.worker.capabilities,
          metadata: this.config.worker.metadata,
        };
    const heartbeat = await this.requestJson<WorkerView>(`/workers/${encodeURIComponent(this.workerId)}/heartbeat`, {
      method: "POST",
      body,
    });
    this.initialHeartbeatSent = true;
    return heartbeat;
  }

  async getWorker(): Promise<WorkerView> {
    return this.requestJson<WorkerView>(`/workers/${encodeURIComponent(this.workerId)}`);
  }

  async pollQueuedTasks(): Promise<TaskRecord[]> {
    const search = new URLSearchParams({
      assignedWorkerId: this.workerId,
      status: "queued",
    });
    const response = await this.requestJson<TaskListResponse>(`/tasks?${search.toString()}`);
    return response.items ?? [];
  }

  /**
   * Probe the assigned-task poll path once and fail loudly if it is not reachable
   * or not authorized. register()/heartbeat() succeeding does not prove the worker
   * can actually receive work: the poll route can be blocked by edge/auth or
   * BROKER_URL routing while register/heartbeat still pass. Surfacing that at
   * startup avoids a worker that looks healthy but silently processes nothing.
   */
  async verifyPollReadiness(): Promise<void> {
    try {
      await this.pollQueuedTasks();
    } catch (error) {
      const detail =
        error instanceof BrokerApiError
          ? `${error.status} ${error.code}`
          : error instanceof Error
            ? error.message
            : String(error);
      throw new Error(
        `[worker:${this.workerId}] poll readiness probe failed: ` +
          `GET /tasks?assignedWorkerId=${this.workerId}&status=queued is not reachable or authorized (${detail}). ` +
          `register/heartbeat succeeded but the task-poll control-plane path is blocked; ` +
          `check edge/auth and BROKER_URL routing for the poll endpoint.`,
      );
    }
  }

  async runOnce(): Promise<number> {
    const tasks = await this.pollQueuedTasks();
    let processed = 0;

    for (const task of tasks) {
      const handled = await this.processTask(task);
      if (handled) {
        processed += 1;
      }
    }

    return processed;
  }

  async run(): Promise<void> {
    if (this.running) {
      throw new Error(`worker ${this.workerId} is already running`);
    }

    // Reset the stop flag BEFORE any await. register()/heartbeat() can take a
    // while; a stop() arriving during them must be observed afterwards rather
    // than cleared by a late `this.stopping = false`.
    this.stopping = false;

    await this.register();
    await this.heartbeat();

    if (this.stopping) {
      console.log(`[worker:${this.workerId}] stop requested during startup; not entering poll loop`);
      return;
    }

    if (this.config.pollReadinessProbe !== false) {
      await this.verifyPollReadiness();
    }

    console.log(`[worker:${this.workerId}] registered with ${this.brokerUrl}`);

    this.running = true;
    const loopAbortController = new AbortController();
    this.loopAbort = () => loopAbortController.abort();
    this.startHeartbeatTimer();

    try {
      let consecutiveConnectionFailures = 0;
      while (this.running) {
        let nextDelayMs = this.config.pollIntervalMs;
        try {
          const processed = await this.runOnce();
          consecutiveConnectionFailures = 0;
          if (processed > 0) {
            console.log(`[worker:${this.workerId}] processed ${processed} task(s)`);
          }
        } catch (error) {
          console.error(`[worker:${this.workerId}] poll loop error`, error);
          // Broker went away (redeploy socket churn or a drain notice, #1405):
          // back off with bounded jitter instead of hammering the fixed
          // interval in lockstep with the rest of the fleet.
          if (isBrokerConnectionError(error)) {
            consecutiveConnectionFailures += 1;
            nextDelayMs = computeReconnectDelayMs(this.config.pollIntervalMs, consecutiveConnectionFailures);
            console.log(`[worker:${this.workerId}] broker connection error; reconnecting in ${nextDelayMs}ms (attempt ${consecutiveConnectionFailures})`);
          } else {
            consecutiveConnectionFailures = 0;
          }
        }

        await delay(nextDelayMs, undefined, {
          signal: loopAbortController.signal,
        }).catch((error: unknown) => {
          if (this.running) {
            throw error;
          }
        });
      }
    } finally {
      this.running = false;
      this.stopHeartbeatTimer();
      this.loopAbort = null;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.running = false;
    this.stopHeartbeatTimer();
    this.loopAbort?.();
  }

  private async processTask(task: TaskRecord): Promise<boolean> {
    try {
      await this.claimTask(task.id);
    } catch (error) {
      if (isSkippableClaimError(error)) {
        return false;
      }
      throw error;
    }

    let stopTaskHeartbeat: (() => void) | undefined;
    try {
      const runningTask = await this.startTask(task.id);
      stopTaskHeartbeat = this.startTaskHeartbeatTimer(task.id);
      const outcome = normalizeWorkerHandlerOutcome(await this.config.handler(runningTask));

      if (outcome.error) {
        stopTaskHeartbeat?.();
        stopTaskHeartbeat = undefined;
        await this.failTask(task.id, outcome.error);
        console.warn(`[worker:${this.workerId}] task ${task.id} failed: ${outcome.error.message}`);
        return true;
      }

      const acceptance = parseTaskAcceptance(runningTask);
      if (acceptance?.error) {
        stopTaskHeartbeat?.();
        stopTaskHeartbeat = undefined;
        await this.failTask(task.id, acceptance.error);
        console.warn(`[worker:${this.workerId}] task ${task.id} failed: ${acceptance.error.message}`);
        return true;
      }
      if (acceptance?.spec) {
        const validation = runTaskAcceptance(acceptance.spec);
        outcome.result = { ...(outcome.result ?? {}), validation };
        if (validation.verdict !== "pass") {
          stopTaskHeartbeat?.();
          stopTaskHeartbeat = undefined;
          await this.failTask(task.id, { code: "acceptance_failed", message: validation.note ?? "acceptance command failed" });
          console.warn(`[worker:${this.workerId}] task ${task.id} failed: ${validation.note}`);
          return true;
        }
      }

      const completionEvidenceError = validateTaskCompletionEvidence(runningTask, outcome.result);
      if (completionEvidenceError) {
        stopTaskHeartbeat?.();
        stopTaskHeartbeat = undefined;
        await this.failTask(task.id, completionEvidenceError);
        console.warn(`[worker:${this.workerId}] task ${task.id} failed: ${completionEvidenceError.message}`);
        return true;
      }

      stopTaskHeartbeat?.();
      stopTaskHeartbeat = undefined;
      await this.completeTask(task.id, this.attachResultProvenance(runningTask, outcome.result));
      return true;
    } catch (error) {
      const taskError = toTaskError(error);
      try {
        stopTaskHeartbeat?.();
        stopTaskHeartbeat = undefined;
        await this.failTask(task.id, taskError);
      } catch (failError) {
        console.error(`[worker:${this.workerId}] failed to mark task ${task.id} as failed`, failError);
        throw error;
      }
      console.warn(`[worker:${this.workerId}] task ${task.id} failed: ${taskError.message}`);
      return true;
    } finally {
      stopTaskHeartbeat?.();
    }
  }

  private async claimTask(taskId: string): Promise<TaskRecord> {
    return this.requestJson<TaskRecord>(`/tasks/${encodeURIComponent(taskId)}/claim`, {
      method: "POST",
      body: { workerId: this.workerId },
    });
  }

  private async startTask(taskId: string): Promise<TaskRecord> {
    return this.requestJson<TaskRecord>(`/tasks/${encodeURIComponent(taskId)}/start`, {
      method: "POST",
      body: { workerId: this.workerId },
    });
  }

  private async heartbeatTask(taskId: string): Promise<TaskRecord> {
    const lastProgressAt = this.resolveTaskProgressAt(taskId);
    return this.requestJson<TaskRecord>(`/tasks/${encodeURIComponent(taskId)}/heartbeat`, {
      method: "POST",
      body: { workerId: this.workerId, ...(lastProgressAt ? { lastProgressAt } : {}) },
    });
  }

  /**
   * Newest mtime on the harness's own progress surface for this task, when
   * the runner/bridge writes one (piri --progress-file, a2a-nexus#1745 ②).
   * Scan is worker-local and read-only: the docker-runner root indexes by
   * exact task id, the piri analysis bridge root by task-id-containing dir.
   */
  private resolveTaskProgressAt(taskId: string): string | undefined {
    const env = process.env;
    const runnerRoot = optionalTrimmed(env.A2A_DOCKER_RUNNER_ROOT) ?? "/var/lib/openclaw-a2a/tasks";
    const piriRoot = optionalTrimmed(env.A2A_PIRI_WORK_ROOT) ?? "/var/lib/a2a-runner/piri-tasks";
    let latestMs = 0;
    const consider = (progressPath: string): void => {
      try {
        const ms = statSync(progressPath).mtimeMs;
        if (ms > latestMs) latestMs = ms;
      } catch {
        // not present
      }
    };
    // docker-runner root: <root>/<taskId>/*/artifacts/piri-progress.jsonl
    try {
      for (const runDir of readdirSync(joinPath(runnerRoot, taskId), { withFileTypes: true })) {
        if (!runDir.isDirectory()) continue;
        consider(joinPath(runnerRoot, taskId, runDir.name, "artifacts", "piri-progress.jsonl"));
      }
    } catch {
      // root or task dir missing
    }
    // piri bridge root: the handler names analysis sessions
    // `a2a-<workerId>-<taskId>-analysis` and the bridge sanitizes+truncates
    // that to 48 chars (piri-a2a-analysis-bridge sanitizeName), so the
    // directory is reconstructible exactly. Substring checks cover other
    // session shapes (decision-dialectic, github suffixes).
    const sessionDir = `a2a-${this.workerId}-${taskId}-analysis`
      .replace(/[^A-Za-z0-9_.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
    try {
      for (const entry of readdirSync(piriRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name !== sessionDir && !entry.name.includes(taskId) && !taskId.includes(entry.name)) continue;
        consider(joinPath(piriRoot, entry.name, "artifacts", "piri-progress.jsonl"));
      }
    } catch {
      // root missing
    }
    return latestMs > 0 ? new Date(latestMs).toISOString() : undefined;
  }

  private startTaskHeartbeatTimer(taskId: string): () => void {
    let stopped = false;
    let inFlight = false;
    const heartbeatTimer = setInterval(() => {
      // Skip while a previous task heartbeat is still in flight so a slow
      // broker cannot pile up concurrent requests for the same task.
      if (stopped || inFlight) {
        return;
      }
      inFlight = true;
      void this.safeTaskHeartbeat(taskId).finally(() => {
        inFlight = false;
      });
    }, this.config.heartbeatIntervalMs);
    if (typeof heartbeatTimer.unref === "function") {
      heartbeatTimer.unref();
    }
    return () => {
      stopped = true;
      clearInterval(heartbeatTimer);
    };
  }

  private async safeTaskHeartbeat(taskId: string): Promise<void> {
    if (this.stopping) {
      return;
    }

    try {
      await this.heartbeatTask(taskId);
    } catch (error) {
      console.error(`[worker:${this.workerId}] task ${taskId} heartbeat failed`, error);
    }
  }

  private attachResultProvenance(task: TaskRecord, result?: TaskResult): TaskResult | undefined {
    if (!result) {
      return result;
    }
    const { provenance: _ignored, ...unsignedResult } = result;
    const normalizedResult = normalizeTaskResult(unsignedResult);
    const httpSignature = this.config.httpSignature;
    if (!httpSignature) {
      return normalizedResult;
    }
    const privateKeyPem = createPrivateKey({ key: httpSignature.privateKeyJwk, format: "jwk" })
      .export({ type: "pkcs8", format: "pem" })
      .toString();
    const claimedAt = task.claimedAt ?? new Date().toISOString();
    return {
      ...normalizedResult,
      provenance: signTaskResultProvenance(normalizedResult as Record<string, unknown>, {
        taskId: task.id,
        claimedAt,
        privateKeyPem,
        workerKeyId: httpSignature.keyid,
      }),
    };
  }

  private async completeTask(taskId: string, result?: TaskResult): Promise<TaskRecord> {
    return this.requestJson<TaskRecord>(`/tasks/${encodeURIComponent(taskId)}/complete`, {
      method: "POST",
      body: { workerId: this.workerId, result },
    });
  }

  private async failTask(taskId: string, error?: TaskError): Promise<TaskRecord> {
    return this.requestJson<TaskRecord>(`/tasks/${encodeURIComponent(taskId)}/fail`, {
      method: "POST",
      body: { workerId: this.workerId, error },
    });
  }


  // --- Proposal API methods (for use inside task handlers) ---

  async submitValidation(
    proposalId: string,
    request: SubmitValidationRequest,
  ): Promise<unknown> {
    return this.requestJson(`/proposals/${encodeURIComponent(proposalId)}/validate`, {
      method: "POST",
      body: request,
    });
  }

  async approveProposal(
    proposalId: string,
    request: ProposalActorRequest,
  ): Promise<unknown> {
    return this.requestJson(`/proposals/${encodeURIComponent(proposalId)}/approve`, {
      method: "POST",
      body: request,
    });
  }

  async rejectProposal(
    proposalId: string,
    request: ProposalActorRequest,
  ): Promise<unknown> {
    return this.requestJson(`/proposals/${encodeURIComponent(proposalId)}/reject`, {
      method: "POST",
      body: request,
    });
  }

  async applyProposal(
    proposalId: string,
    request: ApplyProposalRequest,
  ): Promise<unknown> {
    return this.requestJson(`/proposals/${encodeURIComponent(proposalId)}/apply`, {
      method: "POST",
      body: request,
    });
  }

  async getProposalDetails(proposalId: string): Promise<ProposalDetails> {
    return this.requestJson<ProposalDetails>(`/proposals/${encodeURIComponent(proposalId)}`);
  }

  async createProposal(request: CreateProposalRequest): Promise<ChangeProposal> {
    return this.requestJson<ChangeProposal>("/proposals", {
      method: "POST",
      body: request,
    });
  }

  /** Expose fetchImpl and brokerUrl for use by external intent handlers. */
  get brokerClient() {
    return {
      fetch: this.fetchImpl,
      brokerUrl: this.brokerUrl,
      workerId: this.workerId,
      role: this.config.worker.role,
      edgeSecret: this.config.edgeSecret,
      userAgent: this.config.userAgent,
      requestJson: <T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> =>
        this.requestJson<T>(path, init),
    };
  }

  private startHeartbeatTimer(): void {
    this.stopHeartbeatTimer();
    const heartbeatTimer = setInterval(() => {
      void this.safeHeartbeat();
    }, this.config.heartbeatIntervalMs);
    this.stopHeartbeatLoop = () => {
      clearInterval(heartbeatTimer);
    };
    if (typeof heartbeatTimer.unref === "function") {
      heartbeatTimer.unref();
    }
  }

  private stopHeartbeatTimer(): void {
    if (!this.stopHeartbeatLoop) {
      return;
    }
    this.stopHeartbeatLoop();
    this.stopHeartbeatLoop = null;
  }

  private async safeHeartbeat(): Promise<void> {
    if (!this.running || this.stopping || this.heartbeatInFlight) {
      // Skip the tick if a heartbeat is still in flight; otherwise a slow
      // broker would accumulate unbounded concurrent heartbeat requests.
      return;
    }

    this.heartbeatInFlight = true;
    try {
      await this.heartbeat();
    } catch (error) {
      console.error(`[worker:${this.workerId}] heartbeat failed`, error);
    } finally {
      this.heartbeatInFlight = false;
    }
  }

  private async ensureHomeBrokerLease(): Promise<void> {
    const expectedBrokerId = this.config.homeBrokerId?.trim();
    if (!expectedBrokerId || this.homeBrokerVerified) {
      return;
    }

    const actualBrokerId = await this.fetchBrokerId();
    if (actualBrokerId !== expectedBrokerId) {
      throw new Error(
        `home broker mismatch: expected A2A_HOME_BROKER_ID=${expectedBrokerId}, got ${actualBrokerId ?? "<missing>"}`,
      );
    }

    if (this.config.homeBrokerLeaseFile) {
      await assertHomeBrokerLease(this.config.homeBrokerLeaseFile, {
        brokerId: expectedBrokerId,
        brokerUrl: this.brokerUrl,
        workerId: this.workerId,
        createdAt: new Date().toISOString(),
      });
    }

    this.homeBrokerVerified = true;
  }

  private async fetchBrokerId(): Promise<string | undefined> {
    const response = await this.fetchImpl(new URL("/health", this.brokerUrl), {
      method: "GET",
      headers: new Headers({
        accept: "application/json",
        "user-agent": this.config.userAgent,
      }),
      signal: AbortSignal.timeout(this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    const json = parseJsonText(text) as BrokerHealthResponse | null;

    if (!response.ok) {
      const payload = json as ErrorResponseBody | null;
      throw new BrokerApiError(
        response.status,
        payload?.error?.code ?? `http_${response.status}`,
        (payload?.error?.message ?? response.statusText) || `broker identity request failed with ${response.status}`,
        json,
      );
    }

    return typeof json?.brokerId === "string" && json.brokerId.trim() ? json.brokerId.trim() : undefined;
  }

  private async requestJson<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    await this.ensureHomeBrokerLease();

    const headers = new Headers({
      accept: "application/json",
      "x-a2a-requester-id": this.workerId,
      "x-a2a-requester-kind": this.config.requesterKind,
      "x-a2a-requester-role": this.config.worker.role,
      "user-agent": this.config.userAgent,
    });

    if (this.config.edgeSecret) {
      headers.set("x-a2a-edge-secret", this.config.edgeSecret);
    }

    let body: string | undefined;
    if (init?.body !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.body);
    }

    const method = init?.method ?? "GET";
    const url = new URL(path, this.brokerUrl);
    if (this.config.httpSignature) {
      signA2AWorkerRequest({
        method,
        url,
        headers,
        body: body ?? "",
        config: this.config.httpSignature,
      });
    }

    const response = await this.fetchImpl(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
    });

    const text = await response.text();
    const json = parseJsonText(text);

    if (!response.ok) {
      const payload = json as ErrorResponseBody | null;
      throw new BrokerApiError(
        response.status,
        payload?.error?.code ?? `http_${response.status}`,
        (payload?.error?.message ?? response.statusText) || `request failed with ${response.status}`,
        json,
      );
    }

    return json as T;
  }
}

function signA2AWorkerRequest(options: {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
  config: WorkerA2AHttpSignatureConfig;
}): void {
  const keyid = options.config.keyid.trim();
  const brokerId = options.config.brokerId.trim();
  if (!keyid) {
    throw new Error("A2A HTTP Signature worker key id is required");
  }
  if (!brokerId) {
    throw new Error("A2A HTTP Signature broker id is required");
  }
  assertSafeHttpSignatureParamValue(keyid, "A2A HTTP Signature worker key id");

  options.headers.set("content-digest", `sha-256=:${createHash("sha256").update(options.body).digest("base64")}:`);
  options.headers.set("x-a2a-broker-id", brokerId);

  const now = Math.trunc(options.config.nowEpochSeconds?.() ?? Date.now() / 1000);
  const expiresAfterSec = Math.max(1, Math.trunc(options.config.expiresAfterSec ?? 60));
  const nonce = options.config.nonceFactory?.() ?? randomUUID();
  assertSafeHttpSignatureParamValue(nonce, "A2A HTTP Signature nonce");
  const signatureInput = `a2a=("@method" "@authority" "@path" "@query" "content-digest" "x-a2a-requester-id" "x-a2a-requester-role" "x-a2a-broker-id");alg="ed25519";keyid="${keyid}";created=${now};expires=${now + expiresAfterSec};nonce="${nonce}";tag="a2a-worker-v1"`;
  options.headers.set("signature-input", signatureInput);

  const headers = Object.fromEntries([...options.headers.entries()]);
  const signatureBase = buildA2AHttpSignatureBase({
    method: options.method,
    authority: options.url.host,
    path: options.url.pathname,
    query: options.url.search.length > 0 ? options.url.search.slice(1) : "",
    headers,
    signatureInput,
  });
  const privateKey = createPrivateKey({ key: options.config.privateKeyJwk, format: "jwk" });
  const signatureValue = sign(null, Buffer.from(signatureBase), privateKey).toString("base64");
  options.headers.set("signature", `a2a=:${signatureValue}:`);
}

function assertSafeHttpSignatureParamValue(value: string, label: string): void {
  if (!HTTP_SIGNATURE_PARAM_VALUE_RE.test(value)) {
    throw new Error(`${label} contains characters that are not safe for Signature-Input parameters`);
  }
}

export function validateTaskCompletionEvidence(task: TaskRecord, result?: TaskResult): TaskError | null {
  return validateAcceptanceEvidence(task, result) ?? validateReviewEvidence(task, result) ?? validateGithubTaskCompletionEvidence(task, result);
}

/**
 * Build the per-task subagent conductor directive env for an external
 * handler (the node-instance agent process, including Docker-contained
 * runs that inherit this env).
 *
 * The node instance is the orchestra conductor: simple tasks are executed
 * directly (budget 0), heavy tasks may fan out to at most the worker cap
 * (default 4) evidence-only subagents with disjoint write sets and a single
 * finalizer. The plan comes from the worker-subagent orchestration policy;
 * an explicit task.payload.subagentProfile wins over the conservative
 * intent-based default profile.
 */
export function buildSubagentDirectiveEnv(
  task: TaskRecord,
  options: { workerId: string; subagentCap: number; executionIsolation?: "isolated" | "shared" },
): Record<string, string> {
  const profile = deriveSubagentTaskProfile(task);
  const packet = buildA2AWorkerSubagentOrchestrationPolicy({
    task: profile,
    executionIsolation: options.executionIsolation,
    host: {
      workerId: options.workerId,
      workerSubagentCap: Math.max(0, Math.min(4, options.subagentCap)),
      activeSubagents: 0,
    },
  });
  return {
    A2A_SUBAGENT_CONDUCTOR: "1",
    A2A_SUBAGENT_MAX: String(packet.decision.parallelismHint),
    A2A_SUBAGENT_ROLES: packet.decision.recommendedSubagents.map((agent) => agent.role).join(","),
    A2A_SUBAGENT_PLAN: JSON.stringify({
      taskId: task.id,
      parallelismHint: packet.decision.parallelismHint,
      recommendedSubagents: packet.decision.recommendedSubagents,
      oneFinalizerRequired: packet.decision.oneFinalizerRequired,
      writeSetIsolationRequired: packet.decision.writeSetIsolationRequired,
      directExecutionAllowed: packet.decision.directExecutionAllowed,
      reducedBy: packet.resourceGate.reducedBy,
    }),
  };
}

export interface DynamicSubagentRuntimeOptions {
  workerId: string;
  subagentCap: number;
  executionIsolation?: "isolated" | "shared";
  fanoutEnabled: boolean;
  staticRunnerMax: number;
  staticRunnerRoles: string[];
}

export interface DynamicSubagentRuntime {
  env: Record<string, string>;
  subagentContextBrief?: string;
}

const CLOSED_DYNAMIC_SUBAGENT_ENV = {
  A2A_DOCKER_RUNNER_CLAUDE_CODE_FANOUT_ENABLED: "0",
  A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_MAX: "0",
  A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_ROLES: "",
  A2A_SUBAGENT_CONDUCTOR: "1",
  A2A_SUBAGENT_MAX: "0",
  A2A_SUBAGENT_ROLES: "",
} as const;

const DYNAMIC_SUBAGENT_ROLES = new Set(["explorer", "implementer", "verifier"]);
const SUBAGENT_CONTEXT_BRIEF_PATH = "/work/artifacts/context-brief.md";

function isSafeAuthorizedWriteSetPath(value: string): boolean {
  const path = value.trim();
  if (!path || Buffer.byteLength(path, "utf8") > 512) return false;
  if (redactSecretsText(path) !== path) return false;
  if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(path)) return false;
  return !path.replace(/\\/g, "/").split("/").includes("..");
}

/** Convert source-only Phase-1 packets into shrink-only per-task runner authorization. */
export function buildDynamicSubagentRuntime(
  task: TaskRecord,
  options: DynamicSubagentRuntimeOptions,
): DynamicSubagentRuntime {
  if (!options.fanoutEnabled) return { env: {} };

  const staticRunnerMax = Number.isInteger(options.staticRunnerMax)
    ? Math.max(0, Math.min(4, options.staticRunnerMax))
    : 0;
  const staticRunnerRoles = [...new Set(options.staticRunnerRoles)]
    .filter((role) => DYNAMIC_SUBAGENT_ROLES.has(role));
  const plan = (fields: Record<string, unknown>) => JSON.stringify({
    version: 1,
    workerId: options.workerId,
    taskId: task.id,
    oneFinalizerRequired: true,
    writeSetIsolationRequired: true,
    staticRunnerMax,
    staticRunnerRoles,
    ...fields,
  });
  const closed = (reason: string, fields: Record<string, unknown> = {}): DynamicSubagentRuntime => ({
    env: {
      ...CLOSED_DYNAMIC_SUBAGENT_ENV,
      A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_REASONS: reason,
      A2A_SUBAGENT_PLAN: plan({
        state: "refused",
        reason,
        authorizedSubagentCount: 0,
        ...fields,
      }),
    },
  });

  if (staticRunnerMax === 0 || staticRunnerRoles.length === 0) {
    return closed("static_runner_policy_refused");
  }

  const approval = task.approval;
  const approvalRole = approval?.actorRole ?? approval?.requesterRole;
  if (
    !approval
    || typeof approval.approvalId !== "string"
    || approval.approvalId.length === 0
    || typeof approval.approvedAt !== "string"
    || typeof approval.approvedBy !== "string"
    || (approvalRole !== "operator" && approvalRole !== "hub")
  ) {
    return closed("broker_approval_missing_or_untrusted", { approvalState: "missing-or-untrusted" });
  }

  const payload = (task.payload ?? {}) as Record<string, unknown>;
  const budgetInput = payload.workerSubagentBudgetCounter ?? payload.budgetCounter;
  const authorizationInput = payload.spawnAuthorization ?? payload.authorization;
  if (!budgetInput || typeof budgetInput !== "object" || Array.isArray(budgetInput)) {
    return closed("budget_input_missing");
  }
  if (!authorizationInput || typeof authorizationInput !== "object" || Array.isArray(authorizationInput)) {
    return closed("authorization_input_missing");
  }

  try {
    const extractedBudget = extractA2AWorkerSubagentBudgetCounterInput(budgetInput);
    const budget = buildA2AWorkerSubagentBudgetCounter(extractedBudget);
    if (budget.state !== "within-budget") {
      return closed("budget_not_within_ceiling", { budgetState: budget.state });
    }
    if (budget.workerId !== options.workerId) {
      return closed("budget_worker_binding_invalid", { budgetState: budget.state });
    }
    if (extractedBudget.usage.taskId !== task.id) {
      return closed("budget_task_binding_invalid", { budgetState: budget.state });
    }
    const authorizationTaskId = (authorizationInput as Record<string, unknown>).taskId;
    if (authorizationTaskId !== task.id) {
      return closed("authorization_task_binding_invalid", { budgetState: budget.state });
    }

    const profile = deriveSubagentTaskProfile(task);
    const policy = buildA2AWorkerSubagentOrchestrationPolicy({
      task: profile,
      executionIsolation: options.executionIsolation,
      host: {
        workerId: options.workerId,
        workerSubagentCap: Math.max(0, Math.min(4, options.subagentCap)),
        activeSubagents: 0,
      },
    });
    if (policy.decision.parallelismHint === 0) {
      return closed("orchestration_policy_refused", {
        budgetState: budget.state,
        reducedBy: policy.resourceGate.reducedBy,
      });
    }

    const gate = buildA2AWorkerSubagentSpawnGateDecision(extractA2AWorkerSubagentSpawnGateDecisionInput({
      spawnAuthorization: authorizationInput,
      budgetCounter: budget,
      requestedSpawn: {
        subagents: policy.decision.recommendedSubagents.map((agent) => ({
          role: agent.role,
          writeSet: agent.writeSet ? [agent.writeSet] : undefined,
        })),
      },
    }));
    if (gate.state !== "authorized" || gate.authorizedSubagentCount <= 0) {
      return closed("spawn_gate_refused", {
        budgetState: budget.state,
        gateState: gate.state,
        blockers: gate.blockers,
        reviews: gate.reviews,
      });
    }
    if (gate.workerId !== options.workerId) {
      return closed("gate_worker_binding_invalid", { budgetState: budget.state, gateState: gate.state });
    }
    if (gate.taskId !== task.id) {
      return closed("gate_task_binding_invalid", { budgetState: budget.state, gateState: gate.state });
    }

    const authorizedRoles = policy.decision.recommendedSubagents
      .map((agent) => agent.role)
      .filter((role) => staticRunnerRoles.includes(role))
      .slice(0, Math.min(gate.authorizedSubagentCount, staticRunnerMax));
    const authorizedSubagentCount = authorizedRoles.length;
    if (authorizedSubagentCount === 0) {
      return closed("static_runner_role_intersection_empty", {
        budgetState: budget.state,
        gateState: gate.state,
      });
    }
    const authorizedAssignments = policy.decision.recommendedSubagents
      .filter((agent) => authorizedRoles.includes(agent.role))
      .slice(0, authorizedSubagentCount)
      .map((agent) => ({
        role: agent.role,
        objective: agent.purpose,
        writeSet: agent.writeSet ? [agent.writeSet] : undefined,
      }));
    if (authorizedAssignments.some((assignment) =>
      assignment.writeSet?.some((path) => !isSafeAuthorizedWriteSetPath(path)))) {
      return closed("authorized_write_set_invalid", {
        budgetState: budget.state,
        gateState: gate.state,
      });
    }

    const contextInput = payload.workerSubagentContextBrief ?? payload.contextBrief;
    const extractedContext = contextInput && typeof contextInput === "object" && !Array.isArray(contextInput)
      ? extractA2AWorkerSubagentContextBriefInput(contextInput)
      : {
          workerId: options.workerId,
          taskId: task.id,
          summary: task.message,
        };
    const contextPacket = buildA2AWorkerSubagentContextBrief({
      ...extractedContext,
      workerId: options.workerId,
      taskId: task.id,
      assignments: authorizedAssignments,
    });
    const subagentContextBrief = redactSecretsText(
      renderA2AWorkerSubagentContextBriefMarkdown(contextPacket),
    );
    if (Buffer.byteLength(subagentContextBrief, "utf8") > 64 * 1024) {
      return closed("context_brief_too_large", { budgetState: budget.state, gateState: gate.state });
    }

    const reducedBy = [...new Set([
      ...policy.resourceGate.reducedBy,
      ...(authorizedSubagentCount < gate.authorizedSubagentCount ? ["static_runner_policy"] : []),
    ])];
    const briefDigest = `sha256:${createHash("sha256").update(subagentContextBrief, "utf8").digest("hex")}`;
    const planEvidence = plan({
      state: "authorized",
      approvalRef: approval.approvalId,
      budgetState: budget.state,
      gateState: gate.state,
      requestedSubagentCount: gate.requestedSubagentCount,
      authorizedSubagentCount,
      authorizedRoles,
      authorizedAssignments,
      reducedBy,
      budgetCounterIdempotencyKey: budget.idempotencyKey,
      gateDecisionIdempotencyKey: gate.idempotencyKey,
      briefDigest,
      briefPath: SUBAGENT_CONTEXT_BRIEF_PATH,
    });
    return {
      env: {
        A2A_SUBAGENT_CONDUCTOR: "1",
        A2A_SUBAGENT_MAX: String(authorizedSubagentCount),
        A2A_SUBAGENT_ROLES: authorizedRoles.join(","),
        A2A_SUBAGENT_PLAN: planEvidence,
        A2A_DOCKER_RUNNER_CLAUDE_CODE_FANOUT_ENABLED: "1",
        A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_MAX: String(authorizedSubagentCount),
        A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_ROLES: authorizedRoles.join(","),
        A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_REASONS: reducedBy.join(",") || "authorized",
      },
      subagentContextBrief,
    };
  } catch {
    return closed("invalid_runtime_packet");
  }
}

/**
 * Derive a conservative task profile for the orchestration policy.
 * Explicit payload.subagentProfile wins; otherwise patch-shaped intents are
 * treated as conservative independent work with optional write-set inference
 * and everything else as trivial direct work, so a node never fans out for chatter.
 */
function deriveSubagentTaskProfile(task: TaskRecord): A2AWorkerSubagentTaskProfile {
  const payload = (task.payload ?? {}) as Record<string, unknown>;
  const explicit = payload.subagentProfile;
  if (explicit && typeof explicit === "object" && !Array.isArray(explicit)) {
    const candidate = explicit as Record<string, unknown>;
    const size = candidate.size;
    const coupling = candidate.coupling;
    if (
      (size === "trivial" || size === "small" || size === "medium" || size === "large") &&
      (coupling === "low" || coupling === "medium" || coupling === "high")
    ) {
      return {
        taskId: task.id,
        size,
        coupling,
        sensitive: candidate.sensitive === true,
        urgent: candidate.urgent === true,
        hasIndependentSubtasks: candidate.hasIndependentSubtasks === true,
        writeSets: Array.isArray(candidate.writeSets)
          ? candidate.writeSets.filter((entry): entry is string => typeof entry === "string")
          : undefined,
        requiresSingleDesignDecision: candidate.requiresSingleDesignDecision === true,
      };
    }
  }
  const patchShaped =
    task.intent === "propose_patch" ||
    task.intent === "apply_local_change" ||
    task.intent === "validate_change" ||
    task.intent === "backfill";
  if (!patchShaped) return { taskId: task.id, size: "trivial", coupling: "low" };

  const writeSets = inferWriteSets(payload);
  if (writeSets.length >= 2) {
    return { taskId: task.id, size: "large", coupling: "low", hasIndependentSubtasks: true, writeSets };
  }
  if (writeSets.length === 1) {
    return { taskId: task.id, size: "medium", coupling: "low", hasIndependentSubtasks: true, writeSets };
  }
  // Patch-shaped work without enough structural signals stays at the existing
  // conservative two-role explorer/verifier budget. It may investigate in
  // parallel, but it does not infer multiple implementer lanes.
  return { taskId: task.id, size: "medium", coupling: "low", hasIndependentSubtasks: true };
}

function inferWriteSets(payload: Record<string, unknown>): string[] {
  const candidates = [payload.writeSets, payload.write_sets, payload.changedFiles, payload.changed_files, payload.files, payload.filePaths, payload.file_paths];
  const out: string[] = [];
  for (const value of candidates) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (typeof entry !== "string") continue;
      const trimmed = entry.trim();
      if (!trimmed || trimmed.includes("..")) continue;
      out.push(trimmed);
    }
  }
  return [...new Set(out)].slice(0, 4);
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
    const dynamicRuntime = buildDynamicSubagentRuntime(task, {
      workerId: config.workerId ?? "worker",
      subagentCap: config.subagentCap ?? 4,
      executionIsolation: config.subagentExecutionIsolation ?? "shared",
      fanoutEnabled: config.env?.A2A_DOCKER_RUNNER_CLAUDE_CODE_FANOUT_ENABLED === "1",
      staticRunnerMax: Number(config.env?.A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_MAX ?? 0),
      staticRunnerRoles: (config.env?.A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_ROLES ?? "")
        .split(",")
        .map((role) => role.trim())
        .filter(Boolean),
    });
    const dynamicDirectiveBudget = dynamicRuntime.env.A2A_DOCKER_RUNNER_CLAUDE_CODE_FANOUT_ENABLED === "1"
      ? Number(dynamicRuntime.env.A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_MAX ?? 0)
      : dynamicRuntime.env.A2A_DOCKER_RUNNER_CLAUDE_CODE_FANOUT_ENABLED === "0"
        ? 0
        : directiveBudget;
    const configuredOutputBytes = Number(config.env?.A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_OUTPUT_BYTES ?? 12_000);
    const subagentOutputBytes = Number.isInteger(configuredOutputBytes) && configuredOutputBytes > 0
      ? Math.min(configuredOutputBytes, 64 * 1024)
      : 12_000;
    const subagentRedactionMode: A2AWorkerSubagentRedactionMode =
      config.env?.A2A_WORKER_SUBAGENT_REDACTION_MODE === "reject" ? "reject" : "redact";
    const runtimeEvidenceContext: RuntimeSubagentEvidenceContext = {
      fanoutEnabled: dynamicRuntime.env.A2A_DOCKER_RUNNER_CLAUDE_CODE_FANOUT_ENABLED === "1",
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

/**
 * Close the conductor evidence loop. Legacy count-only reports keep their
 * additive budget annotation. An authorized fanout report must carry bounded
 * helper entries; those entries are bound to the broker-owned plan, redacted,
 * and deterministically assembled before the TaskResult can be completed or
 * signed. Raw helper entries never survive in the returned TaskResult.
 */
interface RuntimeSubagentEvidenceContext {
  fanoutEnabled: boolean;
  workerId: string;
  taskId: string;
  planJson?: string;
  maxOutputBytes: number;
  redactionMode: A2AWorkerSubagentRedactionMode;
}

interface RuntimeSubagentReportEntry {
  role: string;
  id: string;
  writeSet: string[];
  status: string;
  output: string;
  preRedacted: boolean;
  preTruncated: boolean;
}

function runtimeRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function runtimeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
  return items.length === value.length ? items : undefined;
}

function subagentEvidenceError(code: string, message: string, details: Record<string, unknown>): WorkerHandlerOutcome {
  return { error: { code, message, details } };
}

function finalizeSubagentEvidence(
  result: TaskResult,
  directiveBudget: number | null,
  command: string,
  runtimeContext?: RuntimeSubagentEvidenceContext,
): WorkerHandlerOutcome {
  const output = result.output;
  const report = runtimeRecord(output) ? output.subagentReport : undefined;
  const fanoutEnabled = runtimeContext?.fanoutEnabled === true;

  if (report === undefined) {
    if (fanoutEnabled) {
      return subagentEvidenceError(
        "subagent_report_missing",
        "authorized fanout handler result must include subagentReport",
        { command, taskId: runtimeContext.taskId, workerId: runtimeContext.workerId },
      );
    }
    return { result };
  }
  if (!runtimeRecord(report)) {
    return subagentEvidenceError(
      "subagent_report_invalid",
      "subagentReport must be an object",
      { command, fanoutEnabled },
    );
  }

  const reported = Number(report.count);
  if (!Number.isInteger(reported) || reported < 0) {
    return subagentEvidenceError(
      "subagent_report_invalid",
      "subagentReport.count must be a non-negative integer",
      { command, fanoutEnabled },
    );
  }
  if (directiveBudget !== null && reported > directiveBudget) {
    return subagentEvidenceError(
      "subagent_budget_exceeded",
      `handler reported ${reported} subagents but the conductor budget for this task was ${directiveBudget}`,
      { command, budget: directiveBudget, reported },
    );
  }

  if (!fanoutEnabled) {
    if (report.entries !== undefined) {
      return subagentEvidenceError(
        "subagent_report_entries_without_authorized_fanout",
        "subagentReport.entries require broker-authorized fanout",
        { command, reported },
      );
    }
    return {
      result: {
        ...result,
        output: {
          ...(output as Record<string, unknown>),
          subagentReport: {
            count: reported,
            budget: directiveBudget,
            withinBudget: true,
          },
        },
      },
    };
  }

  if (!runtimeContext?.planJson || directiveBudget === null) {
    return subagentEvidenceError(
      "subagent_runtime_plan_missing",
      "authorized fanout result is missing its broker runtime plan",
      { command, reported },
    );
  }
  let plan: Record<string, unknown>;
  try {
    const parsed = JSON.parse(runtimeContext.planJson) as unknown;
    if (!runtimeRecord(parsed)) throw new Error("plan must be an object");
    plan = parsed;
  } catch {
    return subagentEvidenceError(
      "subagent_runtime_plan_invalid",
      "authorized fanout runtime plan is invalid",
      { command, reported },
    );
  }
  if (
    plan.state !== "authorized"
    || plan.workerId !== runtimeContext.workerId
    || plan.taskId !== runtimeContext.taskId
    || Number(plan.authorizedSubagentCount) !== directiveBudget
    || typeof plan.gateDecisionIdempotencyKey !== "string"
    || plan.gateDecisionIdempotencyKey.length === 0
    || typeof plan.budgetCounterIdempotencyKey !== "string"
    || plan.budgetCounterIdempotencyKey.length === 0
  ) {
    return subagentEvidenceError(
      "subagent_runtime_plan_binding_invalid",
      "fanout runtime plan is not bound to this worker/task/budget",
      { command, taskId: runtimeContext.taskId, workerId: runtimeContext.workerId, reported },
    );
  }

  const authorizedRoles = runtimeStringList(plan.authorizedRoles);
  const assignmentsRaw = Array.isArray(plan.authorizedAssignments) ? plan.authorizedAssignments : undefined;
  if (!authorizedRoles || !assignmentsRaw || authorizedRoles.length !== directiveBudget) {
    return subagentEvidenceError(
      "subagent_runtime_plan_invalid",
      "fanout runtime plan is missing its authorized roster",
      { command, reported, budget: directiveBudget },
    );
  }
  if (assignmentsRaw.length !== authorizedRoles.length) {
    return subagentEvidenceError(
      "subagent_runtime_plan_invalid",
      "fanout runtime plan assignments must cover the authorized roster",
      { command, reported },
    );
  }
  const assignments = new Map<string, string[]>();
  for (const candidate of assignmentsRaw) {
    if (!runtimeRecord(candidate) || typeof candidate.role !== "string" || !authorizedRoles.includes(candidate.role)) {
      return subagentEvidenceError(
        "subagent_runtime_plan_invalid",
        "fanout runtime plan contains an invalid assignment",
        { command, reported },
      );
    }
    const writeSet = candidate.writeSet === undefined ? [] : runtimeStringList(candidate.writeSet);
    if (!writeSet || assignments.has(candidate.role)) {
      return subagentEvidenceError(
        "subagent_runtime_plan_invalid",
        "fanout runtime plan assignments must have unique roles and valid write sets",
        { command, reported },
      );
    }
    assignments.set(candidate.role, writeSet);
  }
  if (assignments.size !== authorizedRoles.length) {
    return subagentEvidenceError(
      "subagent_runtime_plan_invalid",
      "fanout runtime plan assignments must cover the authorized roster",
      { command, reported },
    );
  }

  const entriesRaw = report.entries;
  if (!Array.isArray(entriesRaw) || entriesRaw.length !== reported) {
    return subagentEvidenceError(
      "subagent_report_entries_invalid",
      "subagentReport.entries length must equal count",
      { command, reported, entries: Array.isArray(entriesRaw) ? entriesRaw.length : null },
    );
  }
  const seenIds = new Set<string>();
  const seenRoles = new Set<string>();
  const entries: RuntimeSubagentReportEntry[] = [];
  for (const [index, candidate] of entriesRaw.entries()) {
    if (!runtimeRecord(candidate)) {
      return subagentEvidenceError(
        "subagent_report_entries_invalid",
        "each subagentReport entry must be an object",
        { command, reported, index },
      );
    }
    const role = typeof candidate.role === "string" ? candidate.role.trim() : "";
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const status = typeof candidate.status === "string" ? candidate.status.trim().toLowerCase() : "complete";
    const outputText = typeof candidate.output === "string" ? candidate.output : undefined;
    const preRedacted = candidate.redacted === true || candidate.redactionChanged === true;
    const preTruncated = candidate.truncated === true || candidate.outputTruncated === true;
    const writeSet = candidate.writeSet === undefined ? [] : runtimeStringList(candidate.writeSet);
    if (!authorizedRoles.includes(role) || !assignments.has(role)) {
      return subagentEvidenceError(
        "subagent_report_unauthorized_role",
        "subagentReport entry role was not authorized by the broker plan",
        { command, reported, index },
      );
    }
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id) || seenIds.has(id)) {
      return subagentEvidenceError(
        "subagent_report_invalid_id",
        "subagentReport entry id must be unique and bounded",
        { command, reported, index },
      );
    }
    if (seenRoles.has(role)) {
      return subagentEvidenceError(
        "subagent_report_duplicate_role",
        "subagentReport may use each broker-authorized role at most once",
        { command, reported, index },
      );
    }
    if (!writeSet || writeSet.some((path) => !assignments.get(role)?.includes(path))) {
      return subagentEvidenceError(
        "subagent_report_write_set_exceeded",
        "subagentReport entry exceeded its broker-authorized write set",
        { command, reported, index },
      );
    }
    if (!new Set(["complete", "blocked", "failed", "skipped"]).has(status) || outputText === undefined) {
      return subagentEvidenceError(
        "subagent_report_entries_invalid",
        "subagentReport entries require a valid status and string output",
        { command, reported, index },
      );
    }
    seenIds.add(id);
    seenRoles.add(role);
    entries.push({ role, id, writeSet, status, output: outputText, preRedacted, preTruncated });
  }

  entries.sort((left, right) => left.role.localeCompare(right.role) || left.id.localeCompare(right.id));

  const redaction = buildA2AWorkerSubagentRedactionGate({
    workerId: runtimeContext.workerId,
    taskId: runtimeContext.taskId,
    mode: runtimeContext.redactionMode,
    maxOutputBytes: runtimeContext.maxOutputBytes,
    entries,
  });
  if (runtimeContext.redactionMode === "reject" && redaction.summary.rejected > 0) {
    return subagentEvidenceError(
      "subagent_evidence_rejected",
      "one or more helper outputs were rejected by the runtime redaction gate",
      {
        command,
        reported,
        rejected: redaction.summary.rejected,
        redactionDigest: redaction.determinism.contentDigest,
      },
    );
  }

  const assembledEntries = redaction.results.flatMap((redactionResult, index) => {
    if (!redactionResult.included || redactionResult.cleaned === undefined) return [];
    const source = entries[index];
    return [{
      role: source.role,
      id: source.id,
      writeSet: source.writeSet,
      status: source.status,
      summary: redactionResult.cleaned,
    }];
  });
  const assembly = buildA2AWorkerSubagentEvidenceAssembly({
    workerId: runtimeContext.workerId,
    taskId: runtimeContext.taskId,
    finalizer: "broker-worker-finalizer",
    entries: assembledEntries,
    execution: {
      gateDecisionIdempotencyKey: typeof plan.gateDecisionIdempotencyKey === "string" ? plan.gateDecisionIdempotencyKey : undefined,
      budgetCounterIdempotencyKey: typeof plan.budgetCounterIdempotencyKey === "string" ? plan.budgetCounterIdempotencyKey : undefined,
      authorizedSubagentCount: directiveBudget,
      parallelismUsed: reported,
    },
  });

  const safeReport = {
    count: reported,
    roles: entries.map((entry) => entry.role),
    writeSets: entries.map((entry) => entry.writeSet),
    budget: directiveBudget,
    withinBudget: true,
    runtimeEvidenceRef: assembly.idempotencyKey,
  };
  return {
    result: {
      ...result,
      output: {
        ...(output as Record<string, unknown>),
        subagentReport: safeReport,
        subagentEvidence: {
          kind: "a2a-broker.worker-subagent-runtime-evidence",
          version: 1,
          workerId: runtimeContext.workerId,
          taskId: runtimeContext.taskId,
          state: redaction.state === "has-rejections" ? "blocked" : "assembled",
          redaction,
          assembly,
          runtime: {
            enforced: true,
            fanoutEnabled: true,
            actualSubagentCount: reported,
            maxOutputBytes: runtimeContext.maxOutputBytes,
            redactionMode: runtimeContext.redactionMode,
          },
        },
      },
    },
  };
}

function validateDockerRunnerExtraMountsReadiness(env: NodeJS.ProcessEnv): void {
  if (parseBooleanEnv(env.A2A_DOCKER_RUNNER_EXTRA_MOUNTS_PREFLIGHT_DISABLED, false)) {
    return;
  }

  const raw = optionalTrimmed(env.A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON);
  if (!raw) {
    return;
  }

  const profile = normalizeDockerRunnerPatchProfile(env.A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `docker runner extra-mounts readiness preflight failed: invalid A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error("docker runner extra-mounts readiness preflight failed: invalid A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: expected an array");
  }

  const mounts = parsed.map((entry, index) => parseDockerRunnerExtraMount(entry, index));
  for (const [index, mount] of mounts.entries()) {
    if (mount.readOnly === false && (isProtectedDockerRunnerMountPath(mount.source) || isProtectedDockerRunnerMountPath(mount.target))) {
      throw new Error(
        `docker runner extra-mounts readiness preflight failed: invalid extra mount at index ${index}: writable agent runtime/session paths are forbidden; mount only scratch paths read-write and keep host ~/.openclaw / ~/.hermes sessions read-only`,
      );
    }
  }

  if (profile === "hermes") {
    validateDockerRunnerProfileMount(mounts, "/run/secrets/hermes-dir", env.A2A_DOCKER_RUNNER_HERMES_CONFIG_DIR, "hermes", "Hermes");
  } else if (profile === "openclaw") {
    validateDockerRunnerProfileMount(mounts, "/run/secrets/openclaw-dir", env.A2A_DOCKER_RUNNER_OPENCLAW_CONFIG_DIR, "openclaw", "OpenClaw");
  } else if (profile === "claude-code") {
    validateDockerRunnerProfileMount(mounts, "/run/secrets/claude-dir", env.A2A_DOCKER_RUNNER_CLAUDE_CONFIG_DIR, "claude-code", "Claude Code");
  }
}

interface DockerRunnerExtraMountForPreflight {
  source: string;
  target: string;
  readOnly?: boolean;
}

function parseDockerRunnerExtraMount(entry: unknown, index: number): DockerRunnerExtraMountForPreflight {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`docker runner extra-mounts readiness preflight failed: invalid extra mount at index ${index}: expected object`);
  }
  const record = entry as Record<string, unknown>;
  const source = record.source;
  const target = record.target;
  const readOnly = record.readOnly;
  if (typeof source !== "string" || !source.startsWith("/")) {
    throw new Error(`docker runner extra-mounts readiness preflight failed: invalid extra mount at index ${index}: source must be an absolute path`);
  }
  if (typeof target !== "string" || !target.startsWith("/")) {
    throw new Error(`docker runner extra-mounts readiness preflight failed: invalid extra mount at index ${index}: target must be an absolute path`);
  }
  if (readOnly !== undefined && typeof readOnly !== "boolean") {
    throw new Error(`docker runner extra-mounts readiness preflight failed: invalid extra mount at index ${index}: readOnly must be boolean`);
  }
  return { source, target, readOnly };
}

function validateDockerRunnerProfileMount(
  mounts: DockerRunnerExtraMountForPreflight[],
  target: string,
  expectedSource: string | undefined,
  profile: string,
  label: string,
): void {
  const matching = mounts.filter((mount) => normalizeDockerRunnerMountPath(mount.target) === target);
  if (matching.length === 0) {
    throw new Error(
      `docker runner extra-mounts readiness preflight failed: invalid A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: ${profile} patch profile requires a ${target} mount; ` +
        `omit A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON or include the ${label} config mount explicitly`,
    );
  }
  if (!expectedSource) {
    return;
  }
  const normalizedExpected = normalizeDockerRunnerMountPath(expectedSource);
  const conflicts = matching.filter((mount) => normalizeDockerRunnerMountPath(mount.source) !== normalizedExpected);
  if (conflicts.length > 0) {
    throw new Error(
      `docker runner extra-mounts readiness preflight failed: invalid A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: ${target} source conflicts with ` +
        `the configured ${label} profile directory; mount the configured ${label} profile directory or omit the duplicate mount`,
    );
  }
}

function normalizeDockerRunnerPatchProfile(value: unknown): "openclaw" | "hermes" | "claude-code" | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase().replace(/_/g, "-");
  if (normalized === "openclaw") return "openclaw";
  if (normalized === "hermes") return "hermes";
  if (normalized === "claude-code" || normalized === "claude" || normalized === "cccb") return "claude-code";
  return undefined;
}

function normalizeDockerRunnerMountPath(value: string): string {
  return value.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}

function isProtectedDockerRunnerMountPath(value: string): boolean {
  const normalized = normalizeDockerRunnerMountPath(value);
  return [
    /^\/root\/\.openclaw(?:\/|$)/,
    /^\/home\/[^/]+\/\.openclaw(?:\/|$)/,
    /^\/run\/secrets\/openclaw-dir(?:\/|$)/,
    /^\/root\/\.hermes(?:\/|$)/,
    /^\/home\/[^/]+\/\.hermes(?:\/|$)/,
    /^\/run\/secrets\/hermes-dir(?:\/|$)/,
    /^\/root\/\.claude(?:\/|$)/,
    /^\/home\/[^/]+\/\.claude(?:\/|$)/,
    /^\/run\/secrets\/claude-dir(?:\/|$)/,
  ].some((pattern) => pattern.test(normalized));
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

async function runExternalHandler(options: {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  input: string;
}): Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string | null;
  timedOut: boolean;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const hardKillTimer = setTimeout(() => {
      if (settled) {
        return;
      }
      child.kill("SIGKILL");
    }, options.timeoutMs + DEFAULT_SHUTDOWN_GRACE_MS);

    const timeoutTimer = setTimeout(() => {
      if (settled) {
        return;
      }
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(hardKillTimer);
      reject(error);
    });

    child.once("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(hardKillTimer);
      resolve({ stdout, stderr, code, signal, timedOut });
    });

    child.stdin.end(options.input);
  });
}

function boundedDiagnosticExcerpt(value: unknown, maxLength = 500): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (normalized.length <= maxLength) return normalized;
  // Head + tail (#1610): the actionable error is almost always at the end of
  // the output, not the beginning.
  const headLength = Math.floor(maxLength / 3);
  const tailLength = maxLength - headLength - 1;
  return `${normalized.slice(0, headLength)}…${normalized.slice(normalized.length - tailLength)}`;
}

function parseHandlerStdoutError(stdout: string): TaskError | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const error = (parsed as Record<string, unknown>).error;
    if (!error) return undefined;
    return normalizeExternalTaskError(error);
  } catch {
    return undefined;
  }
}

function handlerExitNonzeroError(options: {
  command: string;
  args: string[];
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}): TaskError {
  const nested = parseHandlerStdoutError(options.stdout);
  const nestedDetails = nested?.details;
  const nestedStage = typeof nestedDetails?.stage === "string" ? nestedDetails.stage : undefined;
  const nestedExcerpt = typeof nestedDetails?.excerpt === "string" ? nestedDetails.excerpt : undefined;
  const stderrExcerpt = boundedDiagnosticExcerpt(options.stderr);
  const stdoutExcerpt = boundedDiagnosticExcerpt(options.stdout);
  // Prefer the nested runner/handler error message over the raw JSON wrapper:
  // the wrapper's head is preamble noise while the message carries the
  // runner's own head+tail of the failing output (#1610).
  const fallbackExcerpt =
    boundedDiagnosticExcerpt(nested?.message)
    ?? stderrExcerpt
    ?? stdoutExcerpt
    ?? `handler exited with code ${options.code}${options.signal ? ` (${options.signal})` : ""}`;

  return {
    code: "handler_exit_nonzero",
    message: options.stderr.trim() || `handler exited with code ${options.code}${options.signal ? ` (${options.signal})` : ""}`,
    details: {
      stage: nestedStage ?? "handler",
      excerpt: nestedExcerpt ?? fallbackExcerpt,
      command: options.command,
      args: options.args,
      code: options.code,
      signal: options.signal,
      stdout: options.stdout.trim() || undefined,
      nestedError: nested
        ? {
            code: nested.code,
            message: nested.message,
            details: nested.details,
          }
        : undefined,
    },
  };
}

function normalizeExternalTaskError(value: unknown): TaskError {
  if (typeof value === "string") {
    return { message: value };
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { message: "external handler reported an unknown error" };
  }

  const record = value as Record<string, unknown>;
  return {
    code: typeof record.code === "string" ? record.code : undefined,
    message: typeof record.message === "string" ? record.message : "external handler failed",
    details:
      record.details && typeof record.details === "object" && !Array.isArray(record.details)
        ? (record.details as Record<string, unknown>)
        : undefined,
  };
}

function normalizeWorkerHandlerOutcome(value: WorkerHandlerOutcome | TaskResult | void): WorkerHandlerOutcome {
  if (!value) {
    return { result: {} };
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("worker handler must return an object");
  }

  if (isWorkerHandlerOutcome(value)) {
    return value;
  }

  return { result: value };
}

function isWorkerHandlerOutcome(value: TaskResult | WorkerHandlerOutcome): value is WorkerHandlerOutcome {
  return "result" in value || "error" in value;
}

function isSkippableClaimError(error: unknown): boolean {
  return error instanceof BrokerApiError && [401, 403, 404, 409].includes(error.status);
}

function parseJsonText(text: string): unknown {
  if (!text.trim()) {
    return null;
  }
  return JSON.parse(text);
}

function toTaskError(error: unknown): TaskError {
  if (error instanceof BrokerApiError) {
    return {
      code: error.code,
      message: error.message,
      details: { status: error.status },
    };
  }

  if (error instanceof Error) {
    return {
      message: error.message,
      details: { name: error.name },
    };
  }

  return { message: typeof error === "string" ? error : "task failed" };
}

async function assertHomeBrokerLease(path: string, expected: HomeBrokerLease): Promise<void> {
  try {
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text) as Partial<HomeBrokerLease>;
    if (parsed.brokerId !== expected.brokerId) {
      throw new Error(
        `home broker lease mismatch at ${path}: expected ${expected.brokerId}, found ${parsed.brokerId ?? "<missing>"}`,
      );
    }
    return;
  } catch (error: unknown) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }
  }

  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, `${JSON.stringify(expected, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error: unknown) {
    if (!isFileAlreadyExistsError(error)) {
      throw error;
    }
    await assertHomeBrokerLease(path, expected);
  }
}

function isFileNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isFileAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function normalizeBrokerUrl(value: string): string {
  const trimmed = value.trim();
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

function requiredEnv(env: NodeJS.ProcessEnv, names: string[]): string {
  for (const name of names) {
    const value = optionalTrimmed(env[name]);
    if (value) {
      return value;
    }
  }
  throw new Error(`missing required env var: ${names.join(" or ")}`);
}

function optionalTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseBrokerIdEnv(value: string | undefined, label: string): string | undefined {
  const normalized = optionalTrimmed(value);
  if (!normalized) {
    return undefined;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) {
    throw new Error(`${label} must use only letters, numbers, dots, underscores, colons, or hyphens`);
  }
  return normalized;
}

function parsePositiveInt(
  value: string | undefined,
  fallback: number,
  label: string,
): number {
  if (!optionalTrimmed(value)) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return Math.trunc(parsed);
}

function parseBooleanEnv(value: string | undefined, fallback = false): boolean {
  const normalized = optionalTrimmed(value)?.toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`invalid boolean value: ${value}`);
}

function parseBoundedSubagentCap(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return 4;
  return Math.min(4, parsed);
}

function parseStringArrayEnv(value: string | undefined): string[] {
  const trimmed = optionalTrimmed(value);
  if (!trimmed) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      `expected JSON string array but received ${value}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("expected JSON string array");
  }

  return parsed.map((item) => item.trim()).filter(Boolean);
}

function parseCsvEnv(value: string | undefined): string[] {
  const trimmed = optionalTrimmed(value);
  if (!trimmed) {
    return [];
  }
  return [...new Set(trimmed.split(",").map((item) => item.trim()).filter(Boolean))];
}

function parseMetadataEnv(value: string | undefined): Record<string, string> | undefined {
  const trimmed = optionalTrimmed(value);
  if (!trimmed) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      `expected metadata JSON object but received ${value}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("WORKER_METADATA_JSON must be a JSON object");
  }

  const entries = Object.entries(parsed as Record<string, unknown>).map(([key, item]) => [key, String(item)]);
  return Object.fromEntries(entries);
}

function buildWorkerMetadata(
  env: NodeJS.ProcessEnv,
  runtimeProfile?: WorkerRuntimeProfile,
): Record<string, string> | undefined {
  const metadata = parseMetadataEnv(env.WORKER_METADATA_JSON ?? env.A2A_WORKER_METADATA_JSON) ?? {};
  if (runtimeProfile) {
    const legacyOpenClawProfile = runtimeProfile === "openclaw-poll-only";
    return {
      ...metadata,
      workerProfile: runtimeProfile,
      runtimeFlavor: legacyOpenClawProfile ? "openclaw-poll-handler" : "broker-poll-http-handler",
      executionPlane: "broker-poll-http-handler",
      handlerContract: "stdin-stdout",
      gatewayHookRequired: "false",
      ...(legacyOpenClawProfile ? { openclawBridge: "disabled" } : {}),
    };
  }
  return Object.keys(metadata).length ? metadata : undefined;
}

// ---------------------------------------------------------------------------
// Registration-time analysis handler artifact probe (#1597, routed from #1725
// finding 2). The 2026-08-03 A2AD audit watched two workers advertise
// `online` + `canAnalyze=true`, accept analysis tasks, and die in 3–5 s with
// MODULE_NOT_FOUND because the declared handler artifact was absent. A worker
// must therefore verify the selected handler path (exists + readable /
// executable) BEFORE advertising `canAnalyze=true` at registration or
// heartbeat. Adapter class and handler path are derived from the actual
// wiring — the same env vars the execution handler resolves — never from
// static self-report, so drift between declaration and wiring is impossible
// by construction.
// ---------------------------------------------------------------------------

export interface AnalysisArtifactProbe {
  /** False when the probe did not run (worker does not declare canAnalyze). */
  probed: boolean;
  ready: boolean;
  reason?: "handler_artifact_missing";
  adapterClass?: string;
  handlerPath?: string;
}

const PROBE_ADAPTER_ALIASES: Record<string, string> = {
  openclaw: "openclaw",
  "claude-code": "claude_code",
  claude_code: "claude_code",
  claudecode: "claude_code",
  codex: "codex",
  hermes: "hermes",
  builtin: "builtin",
};

function normalizeProbeAdapter(value: string | undefined): string | undefined {
  const normalized = optionalTrimmed(value)?.toLowerCase();
  if (!normalized) return undefined;
  return PROBE_ADAPTER_ALIASES[normalized];
}

function analysisBridgeCommandForProbe(env: NodeJS.ProcessEnv): string {
  return (
    optionalTrimmed(env.A2A_HERMES_ANALYSIS_BIN) ??
    optionalTrimmed(env.A2A_OPENCLAW_ANALYSIS_BIN) ??
    optionalTrimmed(env.OPENCLAW_BIN) ??
    "openclaw"
  );
}

/** Mirror of the execution handler's adapter telemetry heuristic. */
function deriveAnalysisAdapterClass(env: NodeJS.ProcessEnv, command: string): string {
  const explicit = normalizeProbeAdapter(env.A2A_ANALYSIS_BRIDGE_ADAPTER ?? env.A2A_WORKER_BRIDGE_ADAPTER);
  if (explicit) return explicit;
  const combined = [
    command,
    optionalTrimmed(env.A2A_CLAUDE_CODE_BIN) ?? "",
    optionalTrimmed(env.CLAUDE_BIN) ?? "",
    optionalTrimmed(env.A2A_WORKER_RUNTIME_FLAVOR ?? env.WORKER_RUNTIME_FLAVOR) ?? "",
    optionalTrimmed(env.WORKER_METADATA_JSON) ?? "",
  ].join("\n").toLowerCase();
  if (combined.includes("codex")) return "codex";
  if (combined.includes("claude")) return "claude_code";
  if (combined.includes("hermes")) return "hermes";
  return "openclaw";
}

function isExecutableFile(candidate: string): boolean {
  try {
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathLookupExecutable(name: string, pathEnv: string | undefined): string | undefined {
  for (const dir of (pathEnv ?? "").split(pathDelimiter)) {
    if (!dir) continue;
    const candidate = joinPath(dir, name);
    if (existsSync(candidate) && isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

function probeWorkerBuildRevision(env: NodeJS.ProcessEnv): string | undefined {
  const explicit = optionalTrimmed(env.A2A_WORKER_BUILD_SHA ?? env.A2A_WORKER_BUILD_REVISION ?? env.A2A_BROKER_REVISION);
  if (explicit) return explicit;
  try {
    const revision = readGeneratedBuildInfo()?.revision;
    return typeof revision === "string" && revision.trim() ? revision.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function probeAnalysisArtifactReadiness(
  env: NodeJS.ProcessEnv,
  canAnalyze: boolean,
): AnalysisArtifactProbe {
  if (!canAnalyze) return { probed: false, ready: false };
  const bridgeEnabled =
    parseBooleanEnv(env.A2A_HERMES_ANALYSIS_ENABLED) || parseBooleanEnv(env.A2A_OPENCLAW_ANALYSIS_ENABLED);
  if (!bridgeEnabled) {
    // Builtin structured analysis needs no external artifact: nothing to
    // verify, no metadata to publish (legacy semantics preserved).
    return { probed: false, ready: true, adapterClass: "builtin" };
  }
  const command = analysisBridgeCommandForProbe(env);
  const adapterClass = deriveAnalysisAdapterClass(env, command);
  const looksLikeScript = /\.(?:mjs|cjs|js)$/i.test(command);
  const hasPathSeparator = command.includes("/") || command.includes("\\") || command.startsWith(".");

  if (looksLikeScript && hasPathSeparator) {
    const cwd = optionalTrimmed(env.A2A_HANDLER_CWD ?? env.WORKER_HANDLER_CWD) ?? process.cwd();
    const resolved = isAbsolute(command) ? command : resolvePath(cwd, command);
    const ready = existsSync(resolved) && (() => {
      try {
        accessSync(resolved, fsConstants.R_OK);
        return true;
      } catch {
        return false;
      }
    })();
    return ready
      ? { probed: true, ready: true, adapterClass, handlerPath: resolved }
      : { probed: true, ready: false, reason: "handler_artifact_missing", adapterClass, handlerPath: resolved };
  }

  if (hasPathSeparator) {
    const ready = existsSync(command) && isExecutableFile(command);
    return ready
      ? { probed: true, ready: true, adapterClass, handlerPath: command }
      : { probed: true, ready: false, reason: "handler_artifact_missing", adapterClass, handlerPath: command };
  }

  const onPath = pathLookupExecutable(command, env.PATH);
  return onPath
    ? { probed: true, ready: true, adapterClass, handlerPath: onPath }
    : { probed: true, ready: false, reason: "handler_artifact_missing", adapterClass, handlerPath: command };
}

function withAnalysisProbeMetadata(
  metadata: Record<string, string> | undefined,
  probe: AnalysisArtifactProbe,
  env: NodeJS.ProcessEnv,
): Record<string, string> | undefined {
  if (!probe.probed) return metadata;
  const out: Record<string, string> = { ...(metadata ?? {}) };
  out.analysisReady = probe.ready ? "true" : "false";
  if (probe.adapterClass) out.analysisAdapterClass = probe.adapterClass;
  if (probe.handlerPath) out.analysisHandlerPath = probe.handlerPath;
  if (!probe.ready) {
    out.analysisReadyReason = probe.reason ?? "handler_artifact_missing";
    // The probe only runs when canAnalyze was declared; keep the declaration
    // visible so operators can tell "declared but drifted" from "never
    // declared" without diffing env.
    out.analysisDeclaredCanAnalyze = "true";
  }
  const buildRevision = probeWorkerBuildRevision(env);
  if (buildRevision) out.analysisBuildSha = buildRevision;
  return out;
}

function buildWorkerHandlerEnv(
  env: NodeJS.ProcessEnv,
  runtimeProfile?: WorkerRuntimeProfile,
): NodeJS.ProcessEnv {
  const handlerEnv: NodeJS.ProcessEnv = {
    ...env,
    ...(runtimeProfile === "openclaw-poll-only" ? { A2A_OPENCLAW_BRIDGE_DISABLED: "1" } : {}),
  };
  delete handlerEnv.A2A_HTTP_SIGNATURE_WORKER_PRIVATE_KEY_JWK;
  delete handlerEnv.WORKER_HTTP_SIGNATURE_PRIVATE_KEY_JWK;
  return handlerEnv;
}

function parseWorkerHttpSignatureConfig(env: NodeJS.ProcessEnv): WorkerA2AHttpSignatureConfig | undefined {
  const keyid = optionalTrimmed(env.A2A_HTTP_SIGNATURE_WORKER_KEY_ID)
    ?? optionalTrimmed(env.WORKER_HTTP_SIGNATURE_KEY_ID);
  const privateKeyJwkRaw = optionalTrimmed(env.A2A_HTTP_SIGNATURE_WORKER_PRIVATE_KEY_JWK)
    ?? optionalTrimmed(env.WORKER_HTTP_SIGNATURE_PRIVATE_KEY_JWK);
  const brokerId = parseBrokerIdEnv(
    optionalTrimmed(env.A2A_HTTP_SIGNATURE_BROKER_ID) ?? optionalTrimmed(env.WORKER_HTTP_SIGNATURE_BROKER_ID),
    "A2A_HTTP_SIGNATURE_BROKER_ID",
  );

  if (!keyid && !privateKeyJwkRaw && !brokerId) {
    return undefined;
  }
  if (!keyid) {
    throw new Error("A2A_HTTP_SIGNATURE_WORKER_KEY_ID is required when worker HTTP Signature is configured");
  }
  if (!privateKeyJwkRaw) {
    throw new Error("A2A_HTTP_SIGNATURE_WORKER_PRIVATE_KEY_JWK is required when worker HTTP Signature is configured");
  }
  if (!brokerId) {
    throw new Error("A2A_HTTP_SIGNATURE_BROKER_ID is required when worker HTTP Signature is configured");
  }
  assertSafeHttpSignatureParamValue(keyid, "A2A_HTTP_SIGNATURE_WORKER_KEY_ID");

  let privateKeyJwk: unknown;
  try {
    privateKeyJwk = JSON.parse(privateKeyJwkRaw);
  } catch (error) {
    throw new Error(
      `A2A_HTTP_SIGNATURE_WORKER_PRIVATE_KEY_JWK must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  validateWorkerPrivateJwk(privateKeyJwk);

  return {
    keyid,
    privateKeyJwk: privateKeyJwk as Record<string, unknown>,
    brokerId,
  };
}

function validateWorkerPrivateJwk(input: unknown): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("A2A_HTTP_SIGNATURE_WORKER_PRIVATE_KEY_JWK must be a JSON object");
  }
  const jwk = input as Record<string, unknown>;
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string" || typeof jwk.d !== "string") {
    throw new Error("A2A_HTTP_SIGNATURE_WORKER_PRIVATE_KEY_JWK must be an Ed25519 private JWK");
  }
  try {
    createPrivateKey({ key: jwk, format: "jwk" });
  } catch (error) {
    throw new Error(
      `A2A_HTTP_SIGNATURE_WORKER_PRIVATE_KEY_JWK is invalid: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function parseWorkerRuntimeProfile(value: unknown): WorkerRuntimeProfile | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(/_/g, "-");
  if (!normalized) return undefined;
  if (normalized === "broker-poll-only" || normalized === "broker-poll-http-handler" || normalized === "poll-only") {
    return "broker-poll-only";
  }
  if (normalized === "openclaw-poll-only") return "openclaw-poll-only";
  throw new Error(`invalid worker profile: ${value}`);
}

function parsePartyRole(value: string): A2APartyRole {
  if (
    value === "hub" ||
    value === "live-trader" ||
    value === "researcher" ||
    value === "analyst" ||
    value === "operator"
  ) {
    return value;
  }
  throw new Error(`invalid worker role: ${value}`);
}

function parsePartyKind(value: string): A2APartyKind {
  if (value === "session" || value === "node" || value === "user" || value === "service") {
    return value;
  }
  throw new Error(`invalid requester kind: ${value}`);
}

function parseBuiltinWorkerHandlerKind(value: string): BuiltinWorkerHandlerKind {
  if (value === "noop" || value === "echo") {
    return value;
  }
  throw new Error(`invalid built-in worker handler: ${value}`);
}

/**
 * Read the implementation-lane readiness profile (#1597) from discrete env vars.
 *
 * Values are passed through verbatim: the broker owns the single normalization
 * boundary (normalizeImplementationCapability), which coerces unknown runtimes
 * to "unknown", constrains provider/model ids to secret-safe lowercase ids, and
 * strips credential-shaped evidence. Normalizing here as well would create a
 * second place for those rules to drift.
 *
 * Returns undefined when nothing is declared, which keeps legacy workers
 * registering exactly as before and simply ineligible for implementation work.
 */
type DeclaredImplementationCapability = NonNullable<
  RegisterWorkerRequest["capabilities"]["implementationCapability"]
>;

/**
 * Cast a declared-but-unnormalized profile onto the wire type. The broker
 * rejects or coerces every field on arrival, so the worker deliberately does not
 * pre-fill `runtime` or `availability` here — inventing a default would publish
 * a readiness claim the operator never made.
 */
function asDeclaredImplementationCapability(
  value: Record<string, unknown>,
): DeclaredImplementationCapability {
  return value as unknown as DeclaredImplementationCapability;
}

function parseImplementationCapabilityEnv(env: NodeJS.ProcessEnv): Record<string, unknown> | undefined {
  const capable = parseOptionalBoolean(
    env.WORKER_IMPLEMENTATION_CAPABLE ?? env.A2A_WORKER_IMPLEMENTATION_CAPABLE,
  );
  if (capable === undefined) return undefined;

  const runtime = optionalTrimmed(env.WORKER_IMPLEMENTATION_RUNTIME ?? env.A2A_WORKER_IMPLEMENTATION_RUNTIME);
  const providerId = optionalTrimmed(env.WORKER_IMPLEMENTATION_PROVIDER_ID ?? env.A2A_WORKER_IMPLEMENTATION_PROVIDER_ID);
  const modelTier = optionalTrimmed(env.WORKER_IMPLEMENTATION_MODEL_TIER ?? env.A2A_WORKER_IMPLEMENTATION_MODEL_TIER);
  const availability = optionalTrimmed(env.WORKER_IMPLEMENTATION_AVAILABILITY ?? env.A2A_WORKER_IMPLEMENTATION_AVAILABILITY);
  const lastVerifiedAt = optionalTrimmed(env.WORKER_IMPLEMENTATION_LAST_VERIFIED_AT ?? env.A2A_WORKER_IMPLEMENTATION_LAST_VERIFIED_AT);
  const evidenceId = optionalTrimmed(env.WORKER_IMPLEMENTATION_EVIDENCE_ID ?? env.A2A_WORKER_IMPLEMENTATION_EVIDENCE_ID);

  return {
    capable,
    ...(runtime ? { runtime } : {}),
    ...(providerId ? { providerId } : {}),
    ...(modelTier ? { modelTier } : {}),
    ...(availability ? { availability } : {}),
    ...(lastVerifiedAt ? { lastVerifiedAt } : {}),
    ...(evidenceId ? { evidenceId } : {}),
  };
}

function parseWorkerCapabilities(
  env: NodeJS.ProcessEnv,
  role: A2APartyRole,
): RegisterWorkerRequest["capabilities"] {
  const capabilitiesJson = optionalTrimmed(env.WORKER_CAPABILITIES_JSON ?? env.A2A_WORKER_CAPABILITIES_JSON);
  if (capabilitiesJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(capabilitiesJson);
    } catch (error) {
      throw new Error(
        `WORKER_CAPABILITIES_JSON must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("WORKER_CAPABILITIES_JSON must be a JSON object");
    }

    const record = parsed as Record<string, unknown>;
    const runtimeFlavor = parseWorkerRuntimeFlavor(record.runtimeFlavor);
    const gatewayRequired = parseOptionalBoolean(record.gatewayRequired);
    // Discrete env vars win over the JSON blob so an operator can add or revoke
    // readiness without rewriting a whole capabilities document.
    const implementationCapability = parseImplementationCapabilityEnv(env)
      ?? (record.implementationCapability && typeof record.implementationCapability === "object" &&
          !Array.isArray(record.implementationCapability)
        ? record.implementationCapability as Record<string, unknown>
        : undefined);
    return {
      canAnalyze: Boolean(record.canAnalyze),
      canBackfill: Boolean(record.canBackfill),
      canPatchWorkspace: Boolean(record.canPatchWorkspace),
      canPromoteLive: Boolean(record.canPromoteLive),
      workspaceIds: Array.isArray(record.workspaceIds)
        ? record.workspaceIds.map((item) => String(item)).filter(Boolean)
        : [],
      environments: Array.isArray(record.environments)
        ? record.environments
            .map((item) => String(item))
            .filter(isWorkerEnvironment)
        : [],
      ...(runtimeFlavor ? { runtimeFlavor } : {}),
      ...(gatewayRequired !== undefined ? { gatewayRequired } : {}),
      ...(implementationCapability
        ? { implementationCapability: asDeclaredImplementationCapability(implementationCapability) }
        : {}),
    };
  }

  const declaredImplementationCapability = parseImplementationCapabilityEnv(env);
  return {
    canAnalyze: parseBooleanEnv(env.WORKER_CAN_ANALYZE ?? env.A2A_WORKER_CAN_ANALYZE, role === "analyst" || role === "researcher"),
    canBackfill: parseBooleanEnv(env.WORKER_CAN_BACKFILL ?? env.A2A_WORKER_CAN_BACKFILL, false),
    canPatchWorkspace: parseBooleanEnv(env.WORKER_CAN_PATCH_WORKSPACE ?? env.A2A_WORKER_CAN_PATCH_WORKSPACE, false),
    canPromoteLive: parseBooleanEnv(env.WORKER_CAN_PROMOTE_LIVE ?? env.A2A_WORKER_CAN_PROMOTE_LIVE, false),
    workspaceIds: parseCsvEnv(env.WORKER_WORKSPACE_IDS ?? env.A2A_WORKER_WORKSPACE_IDS),
    environments: parseCsvEnv(env.WORKER_ENVIRONMENTS ?? env.A2A_WORKER_ENVIRONMENTS).filter(isWorkerEnvironment),
    ...(parseWorkerRuntimeFlavor(env.WORKER_RUNTIME_FLAVOR ?? env.A2A_WORKER_RUNTIME_FLAVOR) ? { runtimeFlavor: parseWorkerRuntimeFlavor(env.WORKER_RUNTIME_FLAVOR ?? env.A2A_WORKER_RUNTIME_FLAVOR) } : {}),
    ...(parseOptionalBoolean(env.WORKER_GATEWAY_REQUIRED ?? env.A2A_WORKER_GATEWAY_REQUIRED) !== undefined ? { gatewayRequired: parseOptionalBoolean(env.WORKER_GATEWAY_REQUIRED ?? env.A2A_WORKER_GATEWAY_REQUIRED) } : {}),
    ...(declaredImplementationCapability
      ? { implementationCapability: asDeclaredImplementationCapability(declaredImplementationCapability) }
      : {}),
  };
}

function applyWorkerRuntimeProfile(
  capabilities: RegisterWorkerRequest["capabilities"],
  runtimeProfile?: WorkerRuntimeProfile,
): RegisterWorkerRequest["capabilities"] {
  if (!runtimeProfile) {
    return capabilities;
  }
  const requiredRuntimeFlavor = runtimeProfile === "openclaw-poll-only"
    ? "openclaw-poll-handler"
    : "broker-poll-http-handler";
  if (capabilities.runtimeFlavor && capabilities.runtimeFlavor !== requiredRuntimeFlavor) {
    throw new Error(
      `A2A_WORKER_PROFILE=${runtimeProfile} requires runtimeFlavor=${requiredRuntimeFlavor}, got ${capabilities.runtimeFlavor}`,
    );
  }
  if (capabilities.gatewayRequired === true) {
    throw new Error(`A2A_WORKER_PROFILE=${runtimeProfile} requires gatewayRequired=false`);
  }
  return {
    ...capabilities,
    runtimeFlavor: requiredRuntimeFlavor,
    gatewayRequired: false,
  };
}

function isWorkerEnvironment(value: string): value is RegisterWorkerRequest["capabilities"]["environments"][number] {
  return value === "research" || value === "staging" || value === "live";
}

function parseWorkerRuntimeFlavor(value: unknown): RegisterWorkerRequest["capabilities"]["runtimeFlavor"] | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(/_/g, "-");
  if (
    normalized === "gateway" ||
    normalized === "termux-hermes" ||
    normalized === "broker-poll-http-handler" ||
    normalized === "openclaw-poll-handler"
  ) return normalized;
  if (normalized === "hermes") return "termux-hermes";
  if (normalized === "broker-poll-only" || normalized === "broker-poll-handler" || normalized === "poll-only") {
    return "broker-poll-http-handler";
  }
  if (normalized === "openclaw-poll-only") {
    return "openclaw-poll-handler";
  }
  if (normalized.length > 0) return "unknown";
  return undefined;
}

function parseWorkerMode(value: unknown): RegisterWorkerRequest["workerMode"] | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "persistent" || normalized === "mobile") return normalized;
  return undefined;
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return undefined;
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file://").href) {
  startWorkerFromEnv().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
