// -- Mobile worker preflight packet (source-only, no-live) -------------------
//
// Builds an operator-facing health packet for Termux/mobile A2A workers such
// as mobilebeta from supplied input only. It does not inspect live broker, host,
// tmux, SSH tunnel, Gateway, Android, or Termux state.
// ---------------------------------------------------------------------------

import { isRecord } from "./value-guards.js";
import { createHash } from "node:crypto";

export type MobileWorkerPreflightFormat = "markdown" | "json";

export type MobileWorkerMode =
  | "termux-mobile"
  | "android-termux"
  | "hermes-mobile"
  | "mobile"
  | "docker"
  | "docker-runner"
  | "gateway"
  | "unknown";

export type MobileWorkerObservedStatus =
  | "online"
  | "idle"
  | "running"
  | "stale"
  | "disconnected"
  | "offline"
  | "unknown";

export type MobileWorkerPreflightState =
  | "ready"
  | "degraded"
  | "needs_wake_lock"
  | "poll_interval_too_slow"
  | "workspace_isolation_missing"
  | "supervisor_missing"
  | "local_forward_missing"
  | "disconnected"
  | "not_mobile_worker";

export type MobileWorkerSignalStatus = "pass" | "warn" | "fail" | "skip";

export interface MobileWorkerPreflightInput {
  nodeId: string;
  workerMode: MobileWorkerMode | string;
  status?: MobileWorkerObservedStatus | string;
  lastSeenAgeSec?: number;
  lastSeenAt?: string;
  pollIntervalSec?: number;
  staleAfterSec?: number;
  disconnectedAfterSec?: number;
  tmuxSessionPresent?: boolean;
  localForwardPresent?: boolean;
  wakeLockHeld?: boolean;
  activeLanePlanned?: boolean;
  expectedTmuxSession?: boolean;
  expectedLocalForward?: boolean;
  isolatedWorkspaceRootConfigured?: boolean;
  isolatedWorkspaceRootShape?: string;
}

export interface MobileWorkerPreflightFixture {
  kind?: string;
  version?: number;
  description?: string;
  now?: string;
  format?: MobileWorkerPreflightFormat;
  input?: MobileWorkerPreflightInput;
  mobileWorkerInput?: MobileWorkerPreflightInput;
}

export interface NormalizedMobileWorkerPreflightInput extends MobileWorkerPreflightInput {
  status: MobileWorkerObservedStatus;
  staleAfterSec: number;
  disconnectedAfterSec: number;
  activeLanePlanned: boolean;
  expectedTmuxSession: boolean;
  expectedLocalForward: boolean;
}

export interface MobileWorkerPreflightSignal {
  code: string;
  status: MobileWorkerSignalStatus;
  message: string;
}

export interface MobileWorkerPreflightPacket {
  kind: "a2a-broker.mobile-worker-preflight.packet";
  version: 1;
  generatedAt: string;
  idempotencyKey: string;
  state: MobileWorkerPreflightState;
  readyForActiveLane: boolean;
  input: NormalizedMobileWorkerPreflightInput;
  mobileHealth: {
    isMobileWorker: boolean;
    lastSeenWindow: "fresh" | "stale" | "disconnected" | "unknown";
    pollWindow: "compatible" | "near_stale_threshold" | "too_slow" | "unknown";
    supervisor: "present" | "missing" | "not_expected" | "unknown";
    localForward: "present" | "missing" | "not_expected" | "unknown";
    wakeLock: "held" | "recommended" | "not_required" | "unknown";
    workspaceIsolation: "configured" | "missing" | "not_required" | "forbidden_path" | "unknown";
  };
  signals: MobileWorkerPreflightSignal[];
  recommendedActions: string[];
  boundaries: {
    brokerStateRead: false;
    hostStateRead: false;
    termuxWakeLockChanged: false;
    pollIntervalChanged: false;
    workerDispatch: false;
    dbMutation: false;
    deployOrRestart: false;
    providerSend: false;
    terminalAckOrReplay: false;
    secretMovement: false;
    filesystemMutation: false;
  };
}

export interface MobileWorkerPreflightDryRunResult {
  kind: "a2a-broker.mobile-worker-preflight.dry-run";
  version: 1;
  generatedAt: string;
  format: MobileWorkerPreflightFormat;
  packet: MobileWorkerPreflightPacket;
  boundaries: MobileWorkerPreflightPacket["boundaries"];
}

export interface MobileWorkerTaskAcceptanceInput {
  worker: {
    nodeId: string;
    workerMode?: string;
    capabilities?: {
      canAnalyze?: boolean;
      canPatchWorkspace?: boolean;
      canPromoteLive?: boolean;
      environments?: string[];
    };
  };
  task: {
    intent?: string;
    policyContext?: {
      requiresApproval?: boolean;
      liveImpact?: boolean;
      targetEnvironment?: string;
    };
    payload?: Record<string, unknown>;
  };
}

export interface MobileWorkerTaskAcceptanceDecision {
  accept: boolean;
  profile: "non_docker_research" | "blocked";
  reason: string;
  allowedModes: string[];
  blockedExecutors: string[];
}

const DEFAULT_STALE_AFTER_SEC = 30;
const DEFAULT_DISCONNECTED_AFTER_SEC = 90;
const DEFAULT_FORMAT: MobileWorkerPreflightFormat = "markdown";
const NON_DOCKER_RESEARCH_ALLOWED_MODES = [
  "analysis-only",
  "readonly-analysis",
  "a2ad-analysis",
  "local-hermes-smoke",
  "hermes-reference-dry-run",
] as const;
const MOBILE_BLOCKED_EXECUTORS = ["docker", "live", "github-write"] as const;

export function evaluateMobileWorkerTaskAcceptance(
  input: MobileWorkerTaskAcceptanceInput,
): MobileWorkerTaskAcceptanceDecision {
  const allowedModes = [...NON_DOCKER_RESEARCH_ALLOWED_MODES];
  const blockedExecutors = [...MOBILE_BLOCKED_EXECUTORS];
  const payload = input.task.payload ?? {};
  const mode = stringValue(payload.mode);
  const intent = input.task.intent ?? "";
  const workerMode = input.worker.workerMode ?? "unknown";
  const targetEnvironment = input.task.policyContext?.targetEnvironment ?? "research";

  const blocked = (reason: string): MobileWorkerTaskAcceptanceDecision => ({
    accept: false,
    profile: "blocked",
    reason,
    allowedModes,
    blockedExecutors,
  });

  if (!isMobileWorkerMode(workerMode)) {
    return blocked(`workerMode=${workerMode} is not a mobile/non-docker Hermes worker profile`);
  }
  if (input.worker.capabilities?.canAnalyze === false) {
    return blocked("worker capability canAnalyze=false blocks research analysis tasks");
  }
  if (intent !== "analyze" && intent !== "verify") {
    return blocked(`intent=${intent || "unknown"} is not a no-live research analysis intent`);
  }
  if (input.task.policyContext?.liveImpact === true || targetEnvironment === "live") {
    return blocked("live-impact or live target environment is blocked for mobile/non-docker workers");
  }
  if (payload.noLive !== true) {
    return blocked("payload.noLive=true is required for mobile/non-docker worker acceptance");
  }
  if (!allowedModes.includes(mode as typeof NON_DOCKER_RESEARCH_ALLOWED_MODES[number])) {
    return blocked(`payload.mode=${mode || "unknown"} is not an allowed non-docker research mode`);
  }
  if (mode.includes("docker") || hasAnyKey(payload, ["dockerRunner", "docker", "container", "A2A_DOCKER_RUNNER_BIN"])) {
    return blocked("docker executor payloads are blocked for mobile/non-docker workers");
  }
  if (mode.includes("github") || hasAnyKey(payload, ["githubMutation", "mobileGitHubExecutorApproved", "prUrl", "proofPath"])) {
    return blocked("GitHub write/proof-marker payloads are not accepted by the generic non-docker research policy");
  }
  if (payload.noOutboundSideEffects === false) {
    return blocked("payload explicitly permits outbound side effects");
  }
  if (input.worker.capabilities?.canPromoteLive === true) {
    return blocked("mobile/non-docker research profile must not advertise canPromoteLive=true");
  }

  return {
    accept: true,
    profile: "non_docker_research",
    reason: "safe no-live research task accepted for mobile/non-docker Hermes worker",
    allowedModes,
    blockedExecutors,
  };
}

export function normalizeMobileWorkerPreflightInput(
  value: unknown,
  options: { now?: string } = {},
): NormalizedMobileWorkerPreflightInput {
  if (!isRecord(value)) {
    throw new Error("Mobile worker preflight input must be a JSON object.");
  }

  const fixture = value as MobileWorkerPreflightFixture;
  const candidate = fixture.input ?? fixture.mobileWorkerInput ?? value;
  if (!isRecord(candidate)) {
    throw new Error("Mobile worker preflight input must include an input object.");
  }

  const nodeId = stringField(candidate, "nodeId");
  const workerMode = stringField(candidate, "workerMode", "unknown");
  const status = normalizeStatus(candidate.status);
  const now = options.now ?? (typeof fixture.now === "string" ? fixture.now : undefined);
  const staleAfterSec = positiveNumberField(candidate, "staleAfterSec", DEFAULT_STALE_AFTER_SEC);
  const disconnectedAfterSec = positiveNumberField(
    candidate,
    "disconnectedAfterSec",
    DEFAULT_DISCONNECTED_AFTER_SEC,
  );

  if (disconnectedAfterSec < staleAfterSec) {
    throw new Error("disconnectedAfterSec must be greater than or equal to staleAfterSec.");
  }

  return {
    nodeId,
    workerMode,
    status,
    lastSeenAgeSec: normalizeLastSeenAge(candidate, now),
    lastSeenAt: optionalStringField(candidate, "lastSeenAt"),
    pollIntervalSec: optionalPositiveNumberField(candidate, "pollIntervalSec"),
    staleAfterSec,
    disconnectedAfterSec,
    tmuxSessionPresent: optionalBooleanField(candidate, "tmuxSessionPresent"),
    localForwardPresent: optionalBooleanField(candidate, "localForwardPresent"),
    wakeLockHeld: optionalBooleanField(candidate, "wakeLockHeld"),
    activeLanePlanned: booleanField(candidate, "activeLanePlanned", false),
    expectedTmuxSession: booleanField(candidate, "expectedTmuxSession", true),
    expectedLocalForward: booleanField(candidate, "expectedLocalForward", true),
    isolatedWorkspaceRootConfigured: optionalBooleanField(candidate, "isolatedWorkspaceRootConfigured"),
    isolatedWorkspaceRootShape: optionalStringField(candidate, "isolatedWorkspaceRootShape"),
  };
}

export function buildMobileWorkerPreflight(
  value: unknown,
  options: { now?: string; format?: MobileWorkerPreflightFormat } = {},
): MobileWorkerPreflightDryRunResult {
  const generatedAt = options.now ?? new Date().toISOString();
  const input = normalizeMobileWorkerPreflightInput(value, { now: generatedAt });
  const packet = buildMobileWorkerPreflightPacket(input, { now: generatedAt });

  return {
    kind: "a2a-broker.mobile-worker-preflight.dry-run",
    version: 1,
    generatedAt,
    format: options.format ?? normalizeFormat((value as MobileWorkerPreflightFixture)?.format),
    packet,
    boundaries: { ...packet.boundaries },
  };
}

export function buildMobileWorkerPreflightPacket(
  input: NormalizedMobileWorkerPreflightInput,
  options: { now?: string } = {},
): MobileWorkerPreflightPacket {
  const generatedAt = options.now ?? new Date().toISOString();
  const isMobileWorker = isMobileWorkerMode(input.workerMode);
  const signals: MobileWorkerPreflightSignal[] = [];

  if (!isMobileWorker) {
    signals.push({
      code: "not_mobile_worker",
      status: "skip",
      message: `workerMode=${input.workerMode} is not a Termux/mobile worker; use Docker runner or standard broker health checks instead`,
    });
    return packetFrom(input, generatedAt, "not_mobile_worker", signals, [
      "Skip mobile preflight for this worker; use the appropriate Docker-runner or gateway doctor.",
    ]);
  }

  addSupervisorSignal(signals, input);
  addLocalForwardSignal(signals, input);
  addWorkspaceIsolationSignal(signals, input);
  addLastSeenSignal(signals, input);
  addPollIntervalSignal(signals, input);
  addWakeLockSignal(signals, input);

  const state = chooseState(signals);
  return packetFrom(input, generatedAt, state, signals, buildRecommendedActions(state, signals));
}

export function renderMobileWorkerPreflightMarkdown(
  result: MobileWorkerPreflightDryRunResult,
): string {
  const { packet } = result;
  return [
    "# Mobile worker preflight",
    "",
    `- **dryRunKind**: ${result.kind}`,
    `- **packetKind**: ${packet.kind}`,
    `- **generatedAt**: ${result.generatedAt}`,
    `- **idempotencyKey**: ${packet.idempotencyKey}`,
    `- **nodeId**: ${packet.input.nodeId}`,
    `- **workerMode**: ${packet.input.workerMode}`,
    `- **state**: ${packet.state}`,
    `- **readyForActiveLane**: ${packet.readyForActiveLane}`,
    "",
    "## Mobile health",
    "",
    ...Object.entries(packet.mobileHealth).map(([key, value]) => `- **${key}**: ${value}`),
    "",
    "## Signals",
    "",
    ...packet.signals.map((signal) => `- **${signal.status} ${signal.code}**: ${signal.message}`),
    "",
    "## Recommended actions",
    "",
    ...packet.recommendedActions.map((action) => `- ${action}`),
    "",
    "## Boundaries (no-live enforcement)",
    "",
    ...Object.entries(packet.boundaries).map(([key, value]) => `- **${key}**: ${value}`),
    "",
    "This packet is source-only. It does not inspect live host state, change Termux wake-locks,",
    "change poll intervals, dispatch work, mutate DB state, restart services, send providers,",
    "perform terminal ACK/replay, move secrets, or mutate mobile workspace files.",
  ].join("\n");
}

function packetFrom(
  input: NormalizedMobileWorkerPreflightInput,
  generatedAt: string,
  state: MobileWorkerPreflightState,
  signals: MobileWorkerPreflightSignal[],
  recommendedActions: string[],
): MobileWorkerPreflightPacket {
  const mobileHealth = buildMobileHealth(input, signals);
  return {
    kind: "a2a-broker.mobile-worker-preflight.packet",
    version: 1,
    generatedAt,
    idempotencyKey: buildIdempotencyKey(input, state, signals),
    state,
    readyForActiveLane: state === "ready" && signalPresent(signals, "workspace_isolation_configured"),
    input: { ...input },
    mobileHealth,
    signals: signals.map((signal) => ({ ...signal })),
    recommendedActions,
    boundaries: {
      brokerStateRead: false,
      hostStateRead: false,
      termuxWakeLockChanged: false,
      pollIntervalChanged: false,
      workerDispatch: false,
      dbMutation: false,
      deployOrRestart: false,
      providerSend: false,
      terminalAckOrReplay: false,
      secretMovement: false,
      filesystemMutation: false,
    },
  };
}

function addSupervisorSignal(
  signals: MobileWorkerPreflightSignal[],
  input: NormalizedMobileWorkerPreflightInput,
): void {
  if (!input.expectedTmuxSession) {
    signals.push({
      code: "supervisor_not_expected",
      status: "skip",
      message: "tmux supervisor is not expected for this worker profile",
    });
    return;
  }

  if (input.tmuxSessionPresent === true) {
    signals.push({
      code: "supervisor_present",
      status: "pass",
      message: "mobile worker tmux supervisor/session is reported present",
    });
  } else if (input.tmuxSessionPresent === false) {
    signals.push({
      code: "supervisor_missing",
      status: "fail",
      message: "mobile worker tmux supervisor/session is missing",
    });
  } else {
    signals.push({
      code: "supervisor_unknown",
      status: "warn",
      message: "tmux supervisor/session presence was not supplied",
    });
  }
}

function addLocalForwardSignal(
  signals: MobileWorkerPreflightSignal[],
  input: NormalizedMobileWorkerPreflightInput,
): void {
  if (!input.expectedLocalForward) {
    signals.push({
      code: "local_forward_not_expected",
      status: "skip",
      message: "local-forward listener is not expected for this worker profile",
    });
    return;
  }

  if (input.localForwardPresent === true) {
    signals.push({
      code: "local_forward_present",
      status: "pass",
      message: "mobile worker local-forward/listener is reported present",
    });
  } else if (input.localForwardPresent === false) {
    signals.push({
      code: "local_forward_missing",
      status: "fail",
      message: "mobile worker local-forward/listener is missing",
    });
  } else {
    signals.push({
      code: "local_forward_unknown",
      status: "warn",
      message: "local-forward/listener presence was not supplied",
    });
  }
}

function addWorkspaceIsolationSignal(
  signals: MobileWorkerPreflightSignal[],
  input: NormalizedMobileWorkerPreflightInput,
): void {
  const shape = input.isolatedWorkspaceRootShape?.trim();
  if (shape && workspaceShapeLooksForbidden(shape)) {
    signals.push({
      code: "workspace_isolation_forbidden_path",
      status: "fail",
      message: "isolatedWorkspaceRootShape points at a forbidden config, credential, or shared-state path",
    });
    return;
  }

  if (input.isolatedWorkspaceRootConfigured === true || Boolean(shape)) {
    signals.push({
      code: "workspace_isolation_configured",
      status: "pass",
      message: shape
        ? `isolated mobile workspace root shape is supplied: ${shape}`
        : "isolated mobile workspace root is reported configured",
    });
    return;
  }

  if (input.activeLanePlanned) {
    signals.push({
      code: "workspace_isolation_missing",
      status: "fail",
      message: "isolated per-task mobile workspace root is missing before active implementation lane assignment",
    });
    return;
  }

  signals.push({
    code: "workspace_isolation_not_required",
    status: "skip",
    message: "isolated mobile workspace root is not required until active implementation lane use is planned",
  });
}

function addLastSeenSignal(
  signals: MobileWorkerPreflightSignal[],
  input: NormalizedMobileWorkerPreflightInput,
): void {
  if (input.status === "disconnected" || input.status === "offline") {
    signals.push({
      code: "worker_disconnected",
      status: "fail",
      message: `worker status is ${input.status}`,
    });
    return;
  }

  if (input.lastSeenAgeSec === undefined) {
    signals.push({
      code: "last_seen_unknown",
      status: "warn",
      message: "lastSeenAgeSec or parseable lastSeenAt was not supplied",
    });
    return;
  }

  if (input.lastSeenAgeSec >= input.disconnectedAfterSec) {
    signals.push({
      code: "last_seen_disconnected_window",
      status: "fail",
      message: `lastSeenAgeSec=${input.lastSeenAgeSec} is at or beyond disconnectedAfterSec=${input.disconnectedAfterSec}`,
    });
  } else if (input.lastSeenAgeSec >= input.staleAfterSec) {
    signals.push({
      code: "last_seen_stale_window",
      status: "warn",
      message: `lastSeenAgeSec=${input.lastSeenAgeSec} is at or beyond staleAfterSec=${input.staleAfterSec}`,
    });
  } else {
    signals.push({
      code: "last_seen_fresh",
      status: "pass",
      message: `lastSeenAgeSec=${input.lastSeenAgeSec} is within staleAfterSec=${input.staleAfterSec}`,
    });
  }
}

function addPollIntervalSignal(
  signals: MobileWorkerPreflightSignal[],
  input: NormalizedMobileWorkerPreflightInput,
): void {
  if (input.pollIntervalSec === undefined) {
    signals.push({
      code: "poll_interval_unknown",
      status: "warn",
      message: "pollIntervalSec was not supplied",
    });
    return;
  }

  if (input.pollIntervalSec >= input.staleAfterSec) {
    signals.push({
      code: "poll_interval_too_slow",
      status: "fail",
      message: `pollIntervalSec=${input.pollIntervalSec} cannot satisfy staleAfterSec=${input.staleAfterSec}`,
    });
  } else if (input.pollIntervalSec >= input.staleAfterSec * 0.8) {
    signals.push({
      code: "poll_interval_near_stale_threshold",
      status: "warn",
      message: `pollIntervalSec=${input.pollIntervalSec} leaves little margin before staleAfterSec=${input.staleAfterSec}`,
    });
  } else {
    signals.push({
      code: "poll_interval_compatible",
      status: "pass",
      message: `pollIntervalSec=${input.pollIntervalSec} is compatible with staleAfterSec=${input.staleAfterSec}`,
    });
  }
}

function addWakeLockSignal(
  signals: MobileWorkerPreflightSignal[],
  input: NormalizedMobileWorkerPreflightInput,
): void {
  if (input.wakeLockHeld === true) {
    signals.push({
      code: "wake_lock_held",
      status: "pass",
      message: "Termux wake-lock is reported held",
    });
    return;
  }

  const needsWakeLock = input.activeLanePlanned ||
    signalPresent(signals, "poll_interval_too_slow") ||
    signalPresent(signals, "last_seen_stale_window") ||
    signalPresent(signals, "last_seen_disconnected_window");

  if (needsWakeLock && input.wakeLockHeld === false) {
    signals.push({
      code: "wake_lock_recommended",
      status: "warn",
      message: "Termux wake-lock is not held and is recommended before active lane assignment",
    });
  } else if (needsWakeLock) {
    signals.push({
      code: "wake_lock_unknown",
      status: "warn",
      message: "Termux wake-lock state was not supplied and should be checked before active lane assignment",
    });
  } else if (input.wakeLockHeld === false) {
    signals.push({
      code: "wake_lock_not_required",
      status: "pass",
      message: "wake-lock is not held, but active lane use is not planned and timing signals are clean",
    });
  } else {
    signals.push({
      code: "wake_lock_unknown",
      status: "warn",
      message: "Termux wake-lock state was not supplied",
    });
  }
}

function chooseState(signals: MobileWorkerPreflightSignal[]): MobileWorkerPreflightState {
  if (signalPresent(signals, "supervisor_missing")) return "supervisor_missing";
  if (signalPresent(signals, "local_forward_missing")) return "local_forward_missing";
  if (signalPresent(signals, "workspace_isolation_missing") || signalPresent(signals, "workspace_isolation_forbidden_path")) {
    return "workspace_isolation_missing";
  }
  if (signalPresent(signals, "worker_disconnected") || signalPresent(signals, "last_seen_disconnected_window")) {
    return "disconnected";
  }
  if (signalPresent(signals, "poll_interval_too_slow")) return "poll_interval_too_slow";
  if (signalPresent(signals, "wake_lock_recommended") || signalPresent(signals, "wake_lock_unknown")) {
    return "needs_wake_lock";
  }
  if (signals.some((signal) => signal.status === "warn")) return "degraded";
  return "ready";
}

function buildMobileHealth(
  input: NormalizedMobileWorkerPreflightInput,
  signals: MobileWorkerPreflightSignal[],
): MobileWorkerPreflightPacket["mobileHealth"] {
  const has = (code: string) => signalPresent(signals, code);
  return {
    isMobileWorker: isMobileWorkerMode(input.workerMode),
    lastSeenWindow: has("last_seen_disconnected_window") || has("worker_disconnected")
      ? "disconnected"
      : has("last_seen_stale_window")
        ? "stale"
        : has("last_seen_fresh")
          ? "fresh"
          : "unknown",
    pollWindow: has("poll_interval_too_slow")
      ? "too_slow"
      : has("poll_interval_near_stale_threshold")
        ? "near_stale_threshold"
        : has("poll_interval_compatible")
          ? "compatible"
          : "unknown",
    supervisor: has("supervisor_missing")
      ? "missing"
      : has("supervisor_present")
        ? "present"
        : has("supervisor_not_expected")
          ? "not_expected"
          : "unknown",
    localForward: has("local_forward_missing")
      ? "missing"
      : has("local_forward_present")
        ? "present"
        : has("local_forward_not_expected")
          ? "not_expected"
          : "unknown",
    wakeLock: has("wake_lock_held")
      ? "held"
      : has("wake_lock_recommended")
        ? "recommended"
        : has("wake_lock_not_required")
          ? "not_required"
          : "unknown",
    workspaceIsolation: has("workspace_isolation_configured")
      ? "configured"
      : has("workspace_isolation_missing")
        ? "missing"
        : has("workspace_isolation_forbidden_path")
          ? "forbidden_path"
          : has("workspace_isolation_not_required")
            ? "not_required"
            : "unknown",
  };
}

function buildRecommendedActions(
  state: MobileWorkerPreflightState,
  signals: MobileWorkerPreflightSignal[],
): string[] {
  if (state === "not_mobile_worker") {
    return ["Use Docker-runner doctor or standard broker worker health checks for this worker."];
  }

  const actions: string[] = [];
  if (signalPresent(signals, "supervisor_missing")) {
    actions.push("Start or repair the mobile A2A worker tmux supervisor before assigning active work.");
  }
  if (signalPresent(signals, "local_forward_missing")) {
    actions.push("Restore the mobile local-forward/listener before assigning active work.");
  }
  if (signalPresent(signals, "poll_interval_too_slow")) {
    actions.push("Lower pollIntervalSec below broker staleAfterSec with margin before active lane use.");
  }
  if (signalPresent(signals, "workspace_isolation_missing")) {
    actions.push("Configure an isolated per-task mobile workspace root before active implementation lane use.");
  }
  if (signalPresent(signals, "workspace_isolation_forbidden_path")) {
    actions.push("Choose a mobile workspace root outside Hermes/OpenClaw config, shared state, and credential/provider paths.");
  }
  if (signalPresent(signals, "wake_lock_recommended") || signalPresent(signals, "wake_lock_unknown")) {
    actions.push("Check or hold Termux wake-lock before active lane use; this packet does not execute wake-lock.");
  }
  if (signalPresent(signals, "last_seen_stale_window")) {
    actions.push("Treat stale status as timing-degraded until a fresh heartbeat proves active-lane readiness.");
  }
  if (signalPresent(signals, "last_seen_disconnected_window") || signalPresent(signals, "worker_disconnected")) {
    actions.push("Do not assign active work until the worker produces a fresh heartbeat.");
  }

  if (actions.length === 0) {
    if (signalPresent(signals, "workspace_isolation_configured")) {
      actions.push("Worker is ready for active lane assignment based on supplied mobile preflight signals.");
    } else {
      actions.push("Worker is healthy for standby/non-active use; configure isolated mobile workspace before active implementation lane use.");
    }
  }
  actions.push("No live restart, wake-lock, filesystem mutation, DB mutation, provider send, Terminal ACK, or secret movement is performed by this packet.");
  return actions;
}

function signalPresent(signals: MobileWorkerPreflightSignal[], code: string): boolean {
  return signals.some((signal) => signal.code === code);
}

function isMobileWorkerMode(mode: string): boolean {
  const value = mode.toLowerCase();
  return value.includes("termux") || value.includes("mobile") || value.includes("android") || value.includes("hermes");
}

function workspaceShapeLooksForbidden(shape: string): boolean {
  const normalized = shape.toLowerCase();
  return [
    "/.openclaw",
    "~/.openclaw",
    "/auth",
    "/credentials",
    "/credential",
    "/provider",
    "/providers",
    "/secret",
    "/secrets",
    "/.ssh",
    "~/.ssh",
    "/wiki-cache",
  ].some((fragment) => normalized.includes(fragment));
}

function buildIdempotencyKey(
  input: NormalizedMobileWorkerPreflightInput,
  state: MobileWorkerPreflightState,
  signals: MobileWorkerPreflightSignal[],
): string {
  const seed = stableStringify({
    nodeId: input.nodeId,
    workerMode: input.workerMode,
    state,
    lastSeenAgeSec: input.lastSeenAgeSec,
    pollIntervalSec: input.pollIntervalSec,
    staleAfterSec: input.staleAfterSec,
    disconnectedAfterSec: input.disconnectedAfterSec,
    tmuxSessionPresent: input.tmuxSessionPresent,
    localForwardPresent: input.localForwardPresent,
    wakeLockHeld: input.wakeLockHeld,
    isolatedWorkspaceRootConfigured: input.isolatedWorkspaceRootConfigured,
    isolatedWorkspaceRootShape: input.isolatedWorkspaceRootShape,
    signalCodes: signals.map((signal) => `${signal.status}:${signal.code}`),
  });
  return "mobile-worker-preflight:" +
    createHash("sha256").update(seed).digest("hex").slice(0, 24);
}

function normalizeFormat(format: unknown): MobileWorkerPreflightFormat {
  if (format === "json" || format === "markdown") return format;
  return DEFAULT_FORMAT;
}

function normalizeStatus(value: unknown): MobileWorkerObservedStatus {
  if (typeof value !== "string") return "unknown";
  const normalized = value.toLowerCase();
  if (
    normalized === "online" ||
    normalized === "idle" ||
    normalized === "running" ||
    normalized === "stale" ||
    normalized === "disconnected" ||
    normalized === "offline" ||
    normalized === "unknown"
  ) {
    return normalized;
  }
  return "unknown";
}

function normalizeLastSeenAge(
  record: Record<string, unknown>,
  now: string | undefined,
): number | undefined {
  const supplied = optionalPositiveNumberField(record, "lastSeenAgeSec");
  if (supplied !== undefined) return supplied;

  const lastSeenAt = optionalStringField(record, "lastSeenAt");
  if (!lastSeenAt || !now) return undefined;

  const lastSeenMs = Date.parse(lastSeenAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(lastSeenMs) || !Number.isFinite(nowMs)) return undefined;
  const ageSec = Math.max(0, Math.floor((nowMs - lastSeenMs) / 1000));
  return ageSec;
}

function stringField(
  record: Record<string, unknown>,
  key: string,
  fallback?: string,
): string {
  const value = record[key];
  if (typeof value === "string" && value.trim() !== "") return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`${key} must be a non-empty string.`);
}

function optionalStringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.trim() !== "") return value;
  throw new Error(`${key} must be a non-empty string when supplied.`);
}

function booleanField(
  record: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const value = record[key];
  if (typeof value === "boolean") return value;
  return fallback;
}

function optionalBooleanField(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  throw new Error(`${key} must be a boolean when supplied.`);
}

function positiveNumberField(
  record: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const value = record[key];
  if (value === undefined) return fallback;
  return requirePositiveNumber(value, key);
}

function optionalPositiveNumberField(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  return requirePositiveNumber(value, key);
}

function requirePositiveNumber(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${key} must be a finite non-negative number.`);
  }
  return value;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function hasAnyKey(record: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(record, key));
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
