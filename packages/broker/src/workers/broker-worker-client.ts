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

import { promises as fsp, readdirSync, statSync } from "node:fs";
import { join as joinPath } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { signTaskResultProvenance } from "a2a-attestation";
import { normalizeBrokerUrl } from "./worker-env.js";
import { optionalTrimmed } from "./worker-metadata.js";
import { parseTaskAcceptance, runTaskAcceptance, normalizeBridgeAcceptanceReport, validateAcceptanceEvidence } from "../worker-acceptance.js";
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
import { signA2AWorkerRequest, workerPrivateKeyPem } from "./worker-http-signature.js";
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

/** Mirrors the broker's TASK_LONG_POLL_MAX_WAIT_MS (#2082 B). */
const MAX_TASK_LONG_POLL_WAIT_MS = 30_000;

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

/**
 * Sanitize a name the same way the piri analysis bridge sanitizes session
 * directory names (regex shared with the bridge's sanitizeName).
 */
export function sanitizePiriName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Whether a piri work-root directory name may carry this task's progress.
 *
 * #2011: the previous predicate also accepted directories whose name was any
 * substring of the raw task id (`taskId.includes(entry.name)`), so a stray
 * one-character directory matched nearly every task id and its days-old file
 * mtime was reported as live progress — instantly tripping the broker's stale
 * detection and dead-lettering the task through automatic requeues.
 * Matching is now: the exact sanitized session directory, or a directory that
 * contains the sanitized task id (suffixed session shapes such as
 * decision-dialectic / github variants). Generic short names can never match.
 */
export function piriProgressDirMatches(entryName: string, sessionDir: string, taskId: string): boolean {
  if (entryName === sessionDir) return true;
  const sanitizedTaskId = sanitizePiriName(taskId);
  // A sanitized id shorter than this is too generic to substring-match safely.
  if (sanitizedTaskId.length >= 8 && entryName.includes(sanitizedTaskId)) return true;
  // Long ids truncate the session directory at 48 chars; suffixed shapes
  // still carry that exact truncated prefix, which garbage cannot contain.
  if (sessionDir.length >= 8 && entryName.includes(sessionDir)) return true;
  return false;
}

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

/**
 * #2082 A: delay after a poll, with optional idle backoff. An idle worker used
 * to poll at the fixed `pollIntervalMs` forever — N idle workers cost the
 * broker 12·N list queries per minute even with nothing to do. When a ceiling
 * is configured, empty polls grow the delay geometrically (×1.5, ±20% jitter)
 * capped at the ceiling; any processed task resets to the base interval.
 * Connection-error backoff is handled separately (computeReconnectDelayMs).
 */
export function nextIdlePollDelayMs(options: {
  processed: number;
  currentIdleDelayMs: number;
  pollIntervalMs: number;
  maxIdlePollIntervalMs?: number;
  random?: () => number;
}): number {
  const { processed, currentIdleDelayMs, pollIntervalMs } = options;
  const maxIdlePollIntervalMs = options.maxIdlePollIntervalMs ?? 0;
  if (processed > 0 || !maxIdlePollIntervalMs || maxIdlePollIntervalMs <= pollIntervalMs) {
    return pollIntervalMs;
  }
  const random = options.random ?? Math.random;
  const jitter = 1 + (random() * 0.4 - 0.2); // ±20%
  const grown = Math.min(Math.max(currentIdleDelayMs, pollIntervalMs) * 1.5 * jitter, maxIdlePollIntervalMs);
  return Math.max(pollIntervalMs, Math.round(grown));
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
  // Per-task cache of matching piri session dirs so heartbeats stop listing
  // the whole (history-sized) piri root on every tick. Invalidated when the
  // root's mtime changes (a new session dir touches it) or after 60s.
  private readonly piriSessionDirCache = new Map<string, { rootMtimeMs: number; scannedAtMs: number; matchingDirs: string[] }>();
  // #2082 C: the task the worker is actively executing — carried on every
  // worker heartbeat so task liveness rides the same timer. Null when idle.
  private activeTaskId: string | null = null;
  // Progress-surface scan results cached for one heartbeat cycle (the scan is
  // now async off the event loop and only the periodic heartbeat needs it).
  private readonly progressAtCache = new Map<string, { scannedAtMs: number; value: string | undefined }>();

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
    // #2082 C: name the actively-running task so the single worker heartbeat
    // sustains task liveness too (the broker stamps it only when the task is
    // still assigned and active). resolveTaskProgressAt is async now and
    // cached per heartbeat cycle.
    const activeTaskId = this.activeTaskId;
    const activeTaskLastProgressAt = activeTaskId ? await this.resolveTaskProgressAt(activeTaskId) : undefined;
    const body: WorkerHeartbeatRequest = {
      ...(this.initialHeartbeatSent
        ? {}
        : {
            displayName: this.config.worker.displayName,
            brokerUrl: this.config.worker.brokerUrl,
            capabilities: this.config.worker.capabilities,
            metadata: this.config.worker.metadata,
          }),
      ...(activeTaskId ? { activeTaskId, activeTaskLastProgressAt } : {}),
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

  async pollQueuedTasks(waitMs = 0): Promise<TaskRecord[]> {
    const search = new URLSearchParams({
      assignedWorkerId: this.workerId,
      status: "queued",
    });
    // #2082 B: hold the poll server-side for waitMs when the page is empty
    // (capped at the broker's 30s bound). An old broker ignores the parameter
    // and the idle backoff below degrades naturally.
    const effectiveWaitMs = Math.max(0, Math.min(Math.round(waitMs), MAX_TASK_LONG_POLL_WAIT_MS));
    if (effectiveWaitMs > 0) {
      search.set("waitMs", String(effectiveWaitMs));
    }
    const response = await this.requestJson<TaskListResponse>(`/tasks?${search.toString()}`, {
      // The held poll answers at waitMs; give the request headroom beyond the
      // configured timeout so the long-poll is never aborted client-side.
      timeoutMs: effectiveWaitMs > 0 ? effectiveWaitMs + 5_000 : undefined,
    });
    return response.items ?? [];
  }

  /**
   * #2082 B: server-side hold requested for an idle poll — 6× the base poll
   * interval, capped at the broker's 30s long-poll bound. Derived from
   * pollIntervalMs so fleets that shortened their poll also shorten the hold.
   */
  private taskLongPollWaitMs(): number {
    return Math.min(this.config.pollIntervalMs * 6, MAX_TASK_LONG_POLL_WAIT_MS);
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
      // Readiness probe must stay instant — never hold on the long-poll path.
      await this.pollQueuedTasks(0);
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
    const tasks = await this.pollQueuedTasks(this.taskLongPollWaitMs());
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
      let idlePollDelayMs = this.config.pollIntervalMs;
      while (this.running) {
        let nextDelayMs = this.config.pollIntervalMs;
        try {
          const processed = await this.runOnce();
          consecutiveConnectionFailures = 0;
          // #2082 A: opt-in idle backoff. Unset ceiling keeps the historical
          // fixed interval; a set ceiling grows the delay geometrically while
          // polls come back empty and resets the moment a task is processed.
          idlePollDelayMs = nextIdlePollDelayMs({
            processed,
            currentIdleDelayMs: idlePollDelayMs,
            pollIntervalMs: this.config.pollIntervalMs,
            maxIdlePollIntervalMs: this.config.maxIdlePollIntervalMs,
          });
          nextDelayMs = idlePollDelayMs;
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

    // #2082 C: task liveness rides the regular worker heartbeat (which now
    // names this task as active) instead of a dedicated heartbeat timer.
    try {
      const runningTask = await this.startTask(task.id);
      this.activeTaskId = task.id;
      const outcome = normalizeWorkerHandlerOutcome(await this.config.handler(runningTask));

      if (outcome.error) {
        this.activeTaskId = null;
        await this.failTask(task.id, outcome.error);
        console.warn(`[worker:${this.workerId}] task ${task.id} failed: ${outcome.error.message}`);
        return true;
      }

      const acceptance = parseTaskAcceptance(runningTask);
      if (acceptance?.error) {
        this.activeTaskId = null;
        await this.failTask(task.id, acceptance.error);
        console.warn(`[worker:${this.workerId}] task ${task.id} failed: ${acceptance.error.message}`);
        return true;
      }
      if (acceptance?.spec) {
        // #1904: a handler-side bridge that owns a real workspace (host piri
        // patch clone) may have already executed the spec where the patched
        // files live and reported the verdict as result.acceptance. Prefer it;
        // the worker cwd has no checkout, so a local spawn could only fail.
        const reported = normalizeBridgeAcceptanceReport(outcome.result);
        const validation = reported ?? runTaskAcceptance(acceptance.spec);
        outcome.result = { ...(outcome.result ?? {}), validation };
        if (validation.verdict !== "pass") {
          this.activeTaskId = null;
          await this.failTask(task.id, { code: "acceptance_failed", message: validation.note ?? "acceptance command failed" });
          console.warn(`[worker:${this.workerId}] task ${task.id} failed: ${validation.note}`);
          return true;
        }
      }

      const completionEvidenceError = validateTaskCompletionEvidence(runningTask, outcome.result);
      if (completionEvidenceError) {
        this.activeTaskId = null;
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

      this.activeTaskId = null;
      await this.completeTask(task.id, this.attachResultProvenance(runningTask, outcome.result));
      return true;
    } catch (error) {
      const taskError = toTaskError(error);
      this.activeTaskId = null;
      try {
        await this.failTask(task.id, taskError);
      } catch (failError) {
        console.error(`[worker:${this.workerId}] failed to mark task ${task.id} as failed`, failError);
        throw error;
      }
      console.warn(`[worker:${this.workerId}] task ${task.id} failed: ${taskError.message}`);
      return true;
    } finally {
      this.activeTaskId = null;
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

  /**
   * #2082 C: the per-task progress scan result is cached for one heartbeat
   * cycle — the only caller is the periodic worker heartbeat, and the scan
   * used to hit the event loop synchronously on every tick.
   */
  private async resolveTaskProgressAt(taskId: string): Promise<string | undefined> {
    const cached = this.progressAtCache.get(taskId);
    const nowMs = Date.now();
    if (cached && nowMs - cached.scannedAtMs < this.config.heartbeatIntervalMs) {
      return cached.value;
    }
    const value = await this.scanTaskProgressAt(taskId);
    this.progressAtCache.set(taskId, { scannedAtMs: nowMs, value });
    if (this.progressAtCache.size >= 64) {
      for (const key of this.progressAtCache.keys()) {
        this.progressAtCache.delete(key);
        break;
      }
    }
    return value;
  }

  private async scanTaskProgressAt(taskId: string): Promise<string | undefined> {
    const env = process.env;
    const runnerRoot = optionalTrimmed(env.A2A_DOCKER_RUNNER_ROOT) ?? "/var/lib/openclaw-a2a/tasks";
    const piriRoot = optionalTrimmed(env.A2A_PIRI_WORK_ROOT) ?? "/var/lib/a2a-runner/piri-tasks";
    // #2082 C: fs.promises instead of the old sync statSync/readdirSync walk.
    const consider = async (progressPath: string): Promise<number> => {
      try {
        return (await fsp.stat(progressPath)).mtimeMs;
      } catch {
        return 0; // not present
      }
    };
    // docker-runner root: <root>/<taskId>/*/artifacts/piri-progress.jsonl
    const candidates: Array<Promise<number>> = [];
    try {
      const runDirs = await fsp.readdir(joinPath(runnerRoot, taskId), { withFileTypes: true });
      for (const runDir of runDirs) {
        if (!runDir.isDirectory()) continue;
        candidates.push(consider(joinPath(runnerRoot, taskId, runDir.name, "artifacts", "piri-progress.jsonl")));
      }
    } catch {
      // root or task dir missing
    }
    // piri bridge root: the handler names analysis sessions
    // `a2a-<workerId>-<taskId>-analysis` and the bridge sanitizes+truncates
    // that to 48 chars (piri-a2a-analysis-bridge sanitizeName), so the
    // directory is reconstructible exactly. Suffixed session shapes
    // (decision-dialectic, github variants) contain the sanitized task id —
    // see piriProgressDirMatches for the #2011 matching rules.
    const sessionDir = sanitizePiriName(`a2a-${this.workerId}-${taskId}-analysis`).slice(0, 48);
    try {
      for (const dirName of this.matchingPiriSessionDirs(piriRoot, taskId, sessionDir)) {
        candidates.push(consider(joinPath(piriRoot, dirName, "artifacts", "piri-progress.jsonl")));
      }
    } catch {
      // root missing
    }
    const latestMs = Math.max(0, ...(await Promise.all(candidates)));
    return latestMs > 0 ? new Date(latestMs).toISOString() : undefined;
  }

  private matchingPiriSessionDirs(piriRoot: string, taskId: string, sessionDir: string): string[] {
    const rootMtimeMs = statSync(piriRoot).mtimeMs;
    const nowMs = Date.now();
    const cached = this.piriSessionDirCache.get(taskId);
    if (cached && cached.rootMtimeMs === rootMtimeMs && nowMs - cached.scannedAtMs < 60_000) {
      return cached.matchingDirs;
    }
    const matchingDirs: string[] = [];
    for (const entry of readdirSync(piriRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!piriProgressDirMatches(entry.name, sessionDir, taskId)) continue;
      matchingDirs.push(entry.name);
    }
    if (this.piriSessionDirCache.size >= 64 && !this.piriSessionDirCache.has(taskId)) {
      const oldest = this.piriSessionDirCache.keys().next().value;
      if (oldest !== undefined) this.piriSessionDirCache.delete(oldest);
    }
    this.piriSessionDirCache.set(taskId, { rootMtimeMs, scannedAtMs: nowMs, matchingDirs });
    return matchingDirs;
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
    // #2082 D: the PEM export is cached per signature config (workerPrivateKeyPem)
    // instead of importing and exporting the JWK on every completion.
    const privateKeyPem = workerPrivateKeyPem(httpSignature);
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

  private async requestJson<T>(
    path: string,
    init?: { method?: string; body?: unknown; timeoutMs?: number },
  ): Promise<T> {
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
      signal: AbortSignal.timeout(init?.timeoutMs ?? this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
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
