import { spawn } from "node:child_process";
import { createHash, createPrivateKey, randomUUID, sign } from "node:crypto";
import {
  buildA2AWorkerSubagentOrchestrationPolicy,
  type A2AWorkerSubagentTaskProfile,
} from "./core/worker-subagent-orchestration-policy.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { validateGithubTaskCompletionEvidence } from "./core/github-task-completion.js";
import { parseTaskAcceptance, runTaskAcceptance, validateAcceptanceEvidence } from "./worker-acceptance.js";
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
      while (this.running) {
        try {
          const processed = await this.runOnce();
          if (processed > 0) {
            console.log(`[worker:${this.workerId}] processed ${processed} task(s)`);
          }
        } catch (error) {
          console.error(`[worker:${this.workerId}] poll loop error`, error);
        }

        await delay(this.config.pollIntervalMs, undefined, {
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
      await this.completeTask(task.id, outcome.result);
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
    return this.requestJson<TaskRecord>(`/tasks/${encodeURIComponent(taskId)}/heartbeat`, {
      method: "POST",
      body: { workerId: this.workerId },
    });
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
  return validateAcceptanceEvidence(task, result) ?? validateGithubTaskCompletionEvidence(task, result);
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
    const { stdout, stderr, code, signal, timedOut } = await runExternalHandler({
      command: config.command,
      args,
      cwd: config.cwd,
      env: { ...config.env, ...traceEnv, ...directiveEnv },
      timeoutMs,
      input: JSON.stringify(task),
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
        error: {
          code: "handler_exit_nonzero",
          message: stderr.trim() || `handler exited with code ${code}${signal ? ` (${signal})` : ""}`,
          details: { command: config.command, args, code, signal, stdout: stdout.trim() || undefined },
        },
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
      return finalizeSubagentEvidence(record.result as TaskResult, directiveBudget, config.command);
    }

    return finalizeSubagentEvidence(record as TaskResult, directiveBudget, config.command);
  };
}

/**
 * Close the conductor evidence loop: when the handler reports actual
 * subagent usage (result.output.subagentReport = { count, roles?,
 * writeSets? }), the worker verifies it against the directive budget it
 * injected for this task. Exceeding the budget fails closed — the directive
 * is a verifiable contract, not advice. Within-budget reports are annotated
 * with the budget so terminal evidence carries the full round trip.
 */
function finalizeSubagentEvidence(
  result: TaskResult,
  directiveBudget: number | null,
  command: string,
): WorkerHandlerOutcome {
  if (directiveBudget === null) {
    return { result };
  }
  const output = result.output;
  const report =
    output && typeof output === "object" && !Array.isArray(output)
      ? (output as Record<string, unknown>).subagentReport
      : undefined;
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return { result };
  }
  const reported = Number((report as Record<string, unknown>).count);
  if (!Number.isInteger(reported) || reported < 0) {
    return {
      error: {
        code: "subagent_report_invalid",
        message: "subagentReport.count must be a non-negative integer",
        details: { command, subagentReport: report },
      },
    };
  }
  if (reported > directiveBudget) {
    return {
      error: {
        code: "subagent_budget_exceeded",
        message: `handler reported ${reported} subagents but the conductor budget for this task was ${directiveBudget}`,
        details: { command, budget: directiveBudget, reported, subagentReport: report },
      },
    };
  }
  return {
    result: {
      ...result,
      output: {
        ...(output as Record<string, unknown>),
        subagentReport: {
          ...(report as Record<string, unknown>),
          budget: directiveBudget,
          withinBudget: true,
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

  const worker: RegisterWorkerRequest = {
    nodeId: workerId,
    role,
    displayName: optionalTrimmed(env.WORKER_DISPLAY_NAME ?? env.A2A_WORKER_DISPLAY_NAME),
    brokerUrl: optionalTrimmed(env.WORKER_PUBLIC_URL ?? env.A2A_WORKER_PUBLIC_URL),
    capabilities: applyWorkerRuntimeProfile(parseWorkerCapabilities(env, role), runtimeProfile),
    workerMode: parseWorkerMode(env.WORKER_MODE ?? env.A2A_WORKER_MODE),
    metadata: buildWorkerMetadata(env, runtimeProfile),
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
    };
  }

  return {
    canAnalyze: parseBooleanEnv(env.WORKER_CAN_ANALYZE ?? env.A2A_WORKER_CAN_ANALYZE, role === "analyst" || role === "researcher"),
    canBackfill: parseBooleanEnv(env.WORKER_CAN_BACKFILL ?? env.A2A_WORKER_CAN_BACKFILL, false),
    canPatchWorkspace: parseBooleanEnv(env.WORKER_CAN_PATCH_WORKSPACE ?? env.A2A_WORKER_CAN_PATCH_WORKSPACE, false),
    canPromoteLive: parseBooleanEnv(env.WORKER_CAN_PROMOTE_LIVE ?? env.A2A_WORKER_CAN_PROMOTE_LIVE, false),
    workspaceIds: parseCsvEnv(env.WORKER_WORKSPACE_IDS ?? env.A2A_WORKER_WORKSPACE_IDS),
    environments: parseCsvEnv(env.WORKER_ENVIRONMENTS ?? env.A2A_WORKER_ENVIRONMENTS).filter(isWorkerEnvironment),
    ...(parseWorkerRuntimeFlavor(env.WORKER_RUNTIME_FLAVOR ?? env.A2A_WORKER_RUNTIME_FLAVOR) ? { runtimeFlavor: parseWorkerRuntimeFlavor(env.WORKER_RUNTIME_FLAVOR ?? env.A2A_WORKER_RUNTIME_FLAVOR) } : {}),
    ...(parseOptionalBoolean(env.WORKER_GATEWAY_REQUIRED ?? env.A2A_WORKER_GATEWAY_REQUIRED) !== undefined ? { gatewayRequired: parseOptionalBoolean(env.WORKER_GATEWAY_REQUIRED ?? env.A2A_WORKER_GATEWAY_REQUIRED) } : {}),
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
