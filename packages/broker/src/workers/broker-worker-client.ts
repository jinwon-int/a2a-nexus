/**
 * Broker worker client (#1601 churn relief, extracted from worker.ts slice 7).
 *
 * The HTTP client half of the worker: BrokerApiError, the #1405 connection
 * classification + bounded jittered reconnect math, and the A2ABrokerWorker
 * class (register / poll / claim / heartbeat / submit / drain loop) with the
 * task-completion evidence validation it calls at submit time. Pure move from
 * worker.ts; worker.ts re-exports every public name so all existing
 * `./worker.js` consumers keep working unchanged.
 */

import { createPrivateKey } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join as joinPath } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { signTaskResultProvenance } from "a2a-attestation";
import { normalizeBrokerUrl } from "./worker-env.js";
import { optionalTrimmed } from "./worker-metadata.js";
import { parseTaskAcceptance, runTaskAcceptance, validateAcceptanceEvidence } from "../worker-acceptance.js";
import { validateReviewEvidence } from "../worker-review.js";
import { validateGithubTaskCompletionEvidence } from "../core/github-task-completion.js";
import { normalizeTaskResult } from "../core/broker-task-record-normalizers.js";
import {
  assertHomeBrokerLease,
  isSkippableClaimError,
  normalizeWorkerHandlerOutcome,
  parseJsonText,
  toTaskError,
} from "./external-handler.js";
import { signA2AWorkerRequest } from "./worker-http-signature.js";
import type { FetchLike } from "../worker.js";
import type { BrokerWorkerConfig } from "../worker.js";
import type {
  TaskError,
  TaskRecord,
  TaskResult,
  WorkerHeartbeatRequest,
  WorkerView,
  WorkerRegistrationResponse,
  SubmitValidationRequest,
  ProposalActorRequest,
  ApplyProposalRequest,
  CreateProposalRequest,
  ChangeProposal,
  ProposalDetails,
} from "../core/types.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

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

/**
 * Home broker lease record (definition moved to workers/external-handler.ts,
 * slice 6): a single-writer claim file that pins which broker this worker
 * process is currently serving.
 */
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
        // #1815 item 5: on a failed review verdict, submit the held result
        // with the failure so the broker preserves the negative findings
        // (task.negativeVerdictEvidence) instead of discarding them — no
        // same-source diagnostic re-dispatch needed to recover them.
        const verdictEvidence = completionEvidenceError.code === "review_verdict_failed"
          ? outcome.result
          : undefined;
        await this.failTask(task.id, completionEvidenceError, verdictEvidence);
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

  private async failTask(taskId: string, error?: TaskError, negativeVerdictEvidence?: TaskResult): Promise<TaskRecord> {
    return this.requestJson<TaskRecord>(`/tasks/${encodeURIComponent(taskId)}/fail`, {
      method: "POST",
      body: { workerId: this.workerId, error, ...(negativeVerdictEvidence ? { negativeVerdictEvidence } : {}) },
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


export function validateTaskCompletionEvidence(task: TaskRecord, result?: TaskResult): TaskError | null {
  return validateAcceptanceEvidence(task, result) ?? validateReviewEvidence(task, result) ?? validateGithubTaskCompletionEvidence(task, result);
}
