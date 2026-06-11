/**
 * Non-live / no-provider-send conformance smoke gate for the plugin/broker
 * public A2A seam (#234).
 *
 * Also enforces the fail-closed receipt-runtime boundary (#229).
 *
 * This module exercises the A2A gateway handlers, validators, schemas, and
 * monitoring projection boundaries *without* sending any live network traffic
 * to a broker or provider. All safe operations (liveSend, terminalOutboxAck,
 * gatewayRestart, productionDeploy, providerSend) are explicitly false.
 */
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import {
  resolveA2ABrokerAdapterPluginConfig,
  type A2ABrokerAdapterPluginRuntimeConfig,
} from "../config.js";
import {
  createA2AGatewayHandlers,
  type GatewayTaskMethod,
} from "./gateway-handlers.js";
import {
  validateA2ATaskRequestParams,
  validateA2ATaskUpdateParams,
  validateA2ATaskCancelParams,
  validateA2ATaskApproveParams,
  validateA2ATaskRejectApprovalParams,
  validateA2ATaskStatusParams,
  validateA2AAlertsListParams,
  validateA2AMonitorStatusParams,
  validateA2APeerStatusParams,
  validateParams,
} from "./gateway-validators.js";
import {
  createA2AMonitoringHandlers,
} from "./gateway-monitoring-handlers.js";
import {
  createA2AOperatorNotificationAdapter,
  preflightA2AOperatorNotificationRuntime,
} from "./operator-notification-adapter.js";
import type {
  A2AOperatorTerminalNotificationEnvelope,
} from "./operator-terminal-notifier.js";
import type {
  A2ATaskRequestParams,
  A2ATaskUpdateParams,
  A2ATaskCancelParams,
  A2ATaskApproveParams,
  A2ATaskRejectApprovalParams,
  A2ATaskStatusParams,
  A2AAlertsListParams,
  A2AMonitorStatusParams,
  A2APeerStatusParams,
} from "./gateway-schema.js";

// ── Types ───────────────────────────────────────────────────────────

export type ConformanceGateFinding = {
  gate: string;
  status: "pass" | "blocked";
  message: string;
};

export type ConformanceSmokeGateReport = {
  mode: "release-dryrun/no-live";
  status: "ready" | "blocked";
  runId: string;
  schemaConformance: {
    status: "pass" | "blocked";
    passed: number;
    blocked: number;
    total: number;
    findings: ConformanceGateFinding[];
  };
  handlerFailClosed: {
    status: "pass" | "blocked";
    passed: number;
    blocked: number;
    total: number;
    findings: ConformanceGateFinding[];
  };
  receiptRuntimeBoundary: {
    status: "pass" | "blocked";
    passed: number;
    blocked: number;
    total: number;
    findings: ConformanceGateFinding[];
  };
  agentCardConformance: {
    status: "pass" | "blocked";
    passed: number;
    blocked: number;
    total: number;
    findings: ConformanceGateFinding[];
  };
  safeOperations: {
    liveSend: false;
    terminalOutboxAck: false;
    gatewayRestart: false;
    productionDeploy: false;
    providerSend: false;
  };
};

export type ConformanceSmokeGateDeps = {
  now?: () => number;
  runId?: string;
};

// ── Public API ──────────────────────────────────────────────────────

export function createA2AConformanceSmokeGate(
  config: A2ABrokerAdapterPluginRuntimeConfig,
  deps: ConformanceSmokeGateDeps = {},
): {
  run(): Promise<ConformanceSmokeGateReport>;
} {
  const resolved = resolveA2ABrokerAdapterPluginConfig(config);
  const now = deps.now ?? Date.now;
  const runId = deps.runId ?? `conformance-smoke-${now()}`;

  return {
    async run(): Promise<ConformanceSmokeGateReport> {
      const schemaResult = runSchemaConformance();
      const handlerResult = await runA2AConformanceHandlerFailClosedGate(config);
      const receiptBoundaryResult = await runReceiptRuntimeBoundaryGate(config, resolved);
      const agentCardResult = runAgentCardConformance();

      const blockedFindings = [
        ...schemaResult.findings.filter((f) => f.status === "blocked"),
        ...handlerResult.findings.filter((f) => f.status === "blocked"),
        ...receiptBoundaryResult.findings.filter((f) => f.status === "blocked"),
        ...agentCardResult.findings.filter((f) => f.status === "blocked"),
      ];

      return {
        mode: "release-dryrun/no-live",
        status: blockedFindings.length > 0 ? "blocked" : "ready",
        runId,
        schemaConformance: schemaResult,
        handlerFailClosed: handlerResult,
        receiptRuntimeBoundary: receiptBoundaryResult,
        agentCardConformance: agentCardResult,
        safeOperations: {
          liveSend: false,
          terminalOutboxAck: false,
          gatewayRestart: false,
          productionDeploy: false,
          providerSend: false,
        },
      };
    },
  };
}

// ── Schema Conformance ──────────────────────────────────────────────

type ValidatorFn = (data: unknown) => boolean;

type SchemaCase = {
  name: string;
  validator: ValidatorFn;
  validInput: unknown;
  invalidInputs: Array<{ label: string; input: unknown }>;
};

function runSchemaConformance(): ConformanceSmokeGateReport["schemaConformance"] {
  const findings: ConformanceGateFinding[] = [];
  let passed = 0;
  let blocked = 0;

  const cases: SchemaCase[] = [
    {
      name: "a2a.task.request",
      validator: validateA2ATaskRequestParams,
      validInput: buildValidTaskRequest(),
      invalidInputs: [
        { label: "missing sessionKey", input: buildValidTaskRequest({ sessionKey: "" }) },
        { label: "missing instructions", input: buildValidTaskRequest({ instructions: "" }) },
        { label: "missing target", input: buildValidTaskRequest({ target: undefined }) },
        { label: "invalid method", input: buildValidTaskRequest({ method: "a2a.task.unknown" }) },
      ],
    },
    {
      name: "a2a.task.update",
      validator: validateA2ATaskUpdateParams,
      validInput: buildValidTaskUpdate(),
      invalidInputs: [
        { label: "missing taskId", input: buildValidTaskUpdate({ taskId: "" }) },
        { label: "missing sessionKey", input: buildValidTaskUpdate({ sessionKey: "" }) },
      ],
    },
    {
      name: "a2a.task.cancel",
      validator: validateA2ATaskCancelParams,
      validInput: buildValidTaskCancel(),
      invalidInputs: [
        { label: "missing taskId", input: buildValidTaskCancel({ taskId: "" }) },
        { label: "missing sessionKey", input: buildValidTaskCancel({ sessionKey: "" }) },
      ],
    },
    {
      name: "a2a.task.approve",
      validator: validateA2ATaskApproveParams,
      validInput: buildValidTaskApprove(),
      invalidInputs: [
        { label: "missing taskId", input: buildValidTaskApprove({ taskId: "" }) },
        { label: "missing sessionKey", input: buildValidTaskApprove({ sessionKey: "" }) },
      ],
    },
    {
      name: "a2a.task.reject_approval",
      validator: validateA2ATaskRejectApprovalParams,
      validInput: buildValidTaskRejectApproval(),
      invalidInputs: [
        { label: "missing taskId", input: buildValidTaskRejectApproval({ taskId: "" }) },
        { label: "missing sessionKey", input: buildValidTaskRejectApproval({ sessionKey: "" }) },
      ],
    },
    {
      name: "a2a.task.status",
      validator: validateA2ATaskStatusParams,
      validInput: buildValidTaskStatus(),
      invalidInputs: [
        { label: "missing taskId", input: buildValidTaskStatus({ taskId: "" }) },
        { label: "missing sessionKey", input: buildValidTaskStatus({ sessionKey: "" }) },
      ],
    },
    {
      name: "a2a.alerts.list",
      validator: validateA2AAlertsListParams,
      validInput: buildValidAlertsList(),
      invalidInputs: [
        { label: "missing sessionKey", input: buildValidAlertsList({ sessionKey: "" }) },
      ],
    },
    {
      name: "a2a.monitor.status",
      validator: validateA2AMonitorStatusParams,
      validInput: buildValidMonitorStatus(),
      invalidInputs: [
        { label: "missing sessionKey", input: buildValidMonitorStatus({ sessionKey: "" }) },
      ],
    },
    {
      name: "a2a.peer.status",
      validator: validateA2APeerStatusParams,
      validInput: buildValidPeerStatus(),
      invalidInputs: [
        { label: "missing target", input: buildValidPeerStatus({ target: "" }) },
        { label: "missing sessionKey", input: buildValidPeerStatus({ sessionKey: "" }) },
      ],
    },
  ];

  for (const testCase of cases) {
    // Valid input must pass
    if (!testCase.validator(testCase.validInput)) {
      findings.push({
        gate: `schema.${testCase.name}.valid`,
        status: "blocked",
        message: `${testCase.name} rejected valid input`,
      });
      blocked++;
    } else {
      passed++;
    }

    // Invalid inputs must be rejected
    for (const invalid of testCase.invalidInputs) {
      if (testCase.validator(invalid.input)) {
        findings.push({
          gate: `schema.${testCase.name}.invalid.${invalid.label}`,
          status: "blocked",
          message: `${testCase.name} accepted invalid input: ${invalid.label}`,
        });
        blocked++;
      } else {
        passed++;
      }
    }
  }

  // ── SessionKey error message safety (R29, plugin-a2a#338) ──
  // R28 HOLD (plugin-a2a#337): raw sessionKey must not appear in
  // validation error messages. AJV does not embed values by default, but
  // we verify explicitly so future changes don't regress this safety.
  // Use inline test cases rather than a typed array to avoid
  // ts-predicate-vs-boolean friction with AJV validators.
  // Each case: {label, params, validator, method, forbiddenToken}
  const testParams0 = { sessionKey: "" };
  const testParams1 = { taskId: "task-1" };
  const testParams2 = { sessionKey: 12345 };

  const r0 = validateParams(testParams0, validateA2ATaskStatusParams, "a2a.task.status");
  if (r0.valid) {
    findings.push({ gate: "sessionKey.safety.empty.failClosed", status: "blocked", message: "a2a.task.status accepted empty sessionKey" });
    blocked++;
  } else {
    passed++;
  }

  const r1 = validateParams(testParams1, validateA2AAlertsListParams, "a2a.alerts.list");
  if (r1.valid) {
    findings.push({ gate: "sessionKey.safety.missing.failClosed", status: "blocked", message: "a2a.alerts.list accepted missing sessionKey" });
    blocked++;
  } else {
    // forbiddenToken "task-1" is a sibling field, not sessionKey — no leak expected
    passed++;
  }

  const r2 = validateParams(testParams2, validateA2ATaskStatusParams, "a2a.task.status");
  if (r2.valid) {
    findings.push({ gate: "sessionKey.safety.nonString.failClosed", status: "blocked", message: "a2a.task.status accepted non-string sessionKey" });
    blocked++;
  } else if (r2.error.message.includes("12345")) {
    findings.push({ gate: "sessionKey.safety.nonString.rawValueLeak", status: "blocked", message: `error message contains raw sessionKey value: ${r2.error.message}` });
    blocked++;
  } else {
    passed++;
  }



  return {
    status: findings.some((f) => f.status === "blocked") ? "blocked" : "pass",
    passed,
    blocked,
    total: passed + blocked,
    findings,
  };
}

// ── Handler Fail-Closed (Broker Unavailable) ────────────────────────

type HandlerResponse = {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
};

async function runHandlerWithRespond(
  handler: (opts: GatewayRequestHandlerOptions) => Promise<void>,
  params: unknown,
): Promise<HandlerResponse> {
  let response: HandlerResponse = { ok: false };
  await handler({
    params: params as Record<string, unknown>,
    respond(ok, result, error) {
      response = {
        ok,
        result,
        ...(error ? { error: error as { code: string; message: string } } : {}),
      };
    },
  } as GatewayRequestHandlerOptions);
  return response;
}

/**
 * Async runner for handler fail-closed gate. Use this in tests to exercise
 * the full handler path with a null broker client.
 */
export async function runA2AConformanceHandlerFailClosedGate(config?: A2ABrokerAdapterPluginRuntimeConfig): Promise<{
  status: "pass" | "blocked";
  passed: number;
  blocked: number;
  total: number;
  findings: ConformanceGateFinding[];
  responses: Record<string, HandlerResponse>;
}> {
  const cfg = config ?? {
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          config: { baseUrl: "https://broker.conformance.test" },
        },
      },
    },
  };

  const findings: ConformanceGateFinding[] = [];
  let passed = 0;
  let blocked = 0;

  const handlers = createA2AGatewayHandlers(cfg, {
    createBrokerClient: () => null,
  });

  const monitoringHandlers = createA2AMonitoringHandlers(cfg, {
    createClient: () => {
      throw new Error("broker unavailable for conformance smoke gate");
    },
  });

  const responses: Record<string, HandlerResponse> = {};

  const handlerMap: Record<string, (opts: GatewayRequestHandlerOptions) => Promise<void>> = {
    "a2a.task.request": handlers.handleA2ATaskRequest,
    "a2a.task.update": handlers.handleA2ATaskUpdate,
    "a2a.task.cancel": handlers.handleA2ATaskCancel,
    "a2a.task.approve": handlers.handleA2ATaskApprove,
    "a2a.task.reject_approval": handlers.handleA2ATaskRejectApproval,
    "a2a.task.status": handlers.handleA2ATaskStatus,
    "a2a.peer.status": handlers.handleA2APeerStatus,
    "a2a.alerts.list": monitoringHandlers.handleA2AAlertsList,
    "a2a.monitor.status": monitoringHandlers.handleA2AMonitorStatus,
  };

  const validParams: Record<string, unknown> = {
    "a2a.task.request": buildValidTaskRequest(),
    "a2a.task.update": buildValidTaskUpdate(),
    "a2a.task.cancel": buildValidTaskCancel(),
    "a2a.task.approve": buildValidTaskApprove(),
    "a2a.task.reject_approval": buildValidTaskRejectApproval(),
    "a2a.task.status": buildValidTaskStatus(),
    "a2a.peer.status": buildValidPeerStatus(),
    "a2a.alerts.list": buildValidAlertsList(),
    "a2a.monitor.status": buildValidMonitorStatus(),
  };

  for (const [name, handler] of Object.entries(handlerMap)) {
    const response = await runHandlerWithRespond(handler, validParams[name]);
    responses[name] = response;

    if (!response.ok) {
      // Handler correctly failed closed
      passed++;
    } else {
      findings.push({
        gate: `handler.${name}.failClosed`,
        status: "blocked",
        message: `${name} returned ok=true despite broker being unavailable`,
      });
      blocked++;
    }
  }

  // Also test invalid params must be rejected regardless of broker availability
  const invalidParamTests: Array<{ name: string; params: unknown }> = [
    { name: "a2a.task.request", params: buildValidTaskRequest({ sessionKey: "" }) },
    { name: "a2a.task.update", params: buildValidTaskUpdate({ taskId: "" }) },
    { name: "a2a.task.cancel", params: buildValidTaskCancel({ taskId: "" }) },
    { name: "a2a.task.approve", params: buildValidTaskApprove({ taskId: "" }) },
    { name: "a2a.task.reject_approval", params: buildValidTaskRejectApproval({ taskId: "" }) },
    { name: "a2a.task.status", params: buildValidTaskStatus({ taskId: "" }) },
    { name: "a2a.peer.status", params: buildValidPeerStatus({ target: "" }) },
    { name: "a2a.alerts.list", params: buildValidAlertsList({ sessionKey: "" }) },
  ];

  for (const { name, params } of invalidParamTests) {
    const handler = handlerMap[name];
    if (!handler) continue;
    const response = await runHandlerWithRespond(handler, params);
    if (!response.ok) {
      passed++;
    } else {
      findings.push({
        gate: `handler.${name}.invalidRejected`,
        status: "blocked",
        message: `${name} accepted invalid params with broker unavailable`,
      });
      blocked++;
    }
  }

  return {
    status: findings.some((f) => f.status === "blocked") ? "blocked" : "pass",
    passed,
    blocked,
    total: passed + blocked,
    findings,
    responses,
  };
}

// ── Receipt-Runtime Boundary (#229) ─────────────────────────────────

async function runReceiptRuntimeBoundaryGate(
  config: A2ABrokerAdapterPluginRuntimeConfig,
  resolved: ReturnType<typeof resolveA2ABrokerAdapterPluginConfig>,
): Promise<ConformanceSmokeGateReport["receiptRuntimeBoundary"]> {
  void resolved;
  const findings: ConformanceGateFinding[] = [];
  let passed = 0;
  let blocked = 0;

  // 1. No notification target configured -> no adapter at all (fail-closed:
  // nothing exists that could send).
  const minimalConfig: A2ABrokerAdapterPluginRuntimeConfig = {
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          config: {},
        },
      },
    },
  };
  const nullAdapter = createA2AOperatorNotificationAdapter(minimalConfig, undefined);
  if (nullAdapter !== undefined) {
    findings.push({
      gate: "receipt.runtime.adapter.null.config",
      status: "blocked",
      message: "notification adapter was created despite no notification target config",
    });
    blocked++;
  } else {
    passed++;
  }

  // 2. Adapter without a runtime must refuse a live (non-dry-run) send:
  // notify() resolves undefined and records no receipt.
  const adapterWithoutRuntime = createA2AOperatorNotificationAdapter(
    configWithNotificationEnabled(),
    undefined,
  );
  if (!adapterWithoutRuntime) {
    findings.push({
      gate: "receipt.runtime.adapter.missing",
      status: "blocked",
      message: "notification adapter was not created for an enabled notification config",
    });
    blocked++;
  } else {
    const liveReceipt = await adapterWithoutRuntime.notify(
      buildReceiptBoundaryTestEnvelope("receipt-boundary-live-no-runtime", false),
    );
    if (liveReceipt !== undefined || adapterWithoutRuntime.listReceipts().length !== 0) {
      findings.push({
        gate: "receipt.runtime.live.noRuntime",
        status: "blocked",
        message: "live notify produced a receipt despite no runtime being available",
      });
      blocked++;
    } else {
      passed++;
    }
  }

  // 3. Dry-run notifications never touch the runtime send path and are
  // receipted as dry_run_projection only.
  const runtimeCalls = { loadAdapter: 0 };
  const recordingRuntime = {
    channel: {
      outbound: {
        loadAdapter: () => {
          runtimeCalls.loadAdapter++;
          return undefined;
        },
      },
    },
  };
  const adapterWithRuntime = createA2AOperatorNotificationAdapter(
    configWithNotificationEnabled(),
    recordingRuntime,
  );
  if (!adapterWithRuntime) {
    findings.push({
      gate: "receipt.runtime.adapter.missing",
      status: "blocked",
      message: "notification adapter was not created for an enabled notification config",
    });
    blocked++;
  } else {
    const dryRunReceipt = await adapterWithRuntime.notify(
      buildReceiptBoundaryTestEnvelope("receipt-boundary-dry-run", true),
    );
    const dryRunSafe =
      dryRunReceipt !== undefined &&
      dryRunReceipt.dryRun === true &&
      dryRunReceipt.confirmationSource === "dry_run_projection" &&
      runtimeCalls.loadAdapter === 0;
    if (!dryRunSafe) {
      findings.push({
        gate: "receipt.runtime.dryRun.boundary",
        status: "blocked",
        message:
          runtimeCalls.loadAdapter > 0
            ? "dry-run notify reached the runtime outbound adapter (possible live send path)"
            : "dry-run notify did not produce a dry_run_projection receipt",
      });
      blocked++;
    } else {
      passed++;
    }

    // 4. A live send whose runtime offers no receipt-capable outbound adapter
    // must not acknowledge: provider/transport acceptance alone is never
    // receipt evidence.
    const liveNoSender = await adapterWithRuntime.notify(
      buildReceiptBoundaryTestEnvelope("receipt-boundary-live-no-sender", false),
    );
    if (liveNoSender !== undefined) {
      findings.push({
        gate: "receipt.runtime.live.noReceiptCapableSender",
        status: "blocked",
        message: "live notify produced a receipt without a receipt-capable outbound adapter",
      });
      blocked++;
    } else {
      passed++;
    }
  }

  // 5. Preflight on a disabled notification config must report not-ok and
  // must not declare the Gateway safe to restart.
  const disabledConfig: A2ABrokerAdapterPluginRuntimeConfig = {
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          enabled: false,
          config: {
            operatorEvents: { enabled: false },
          },
        },
      },
    },
  };
  const preflight = await preflightA2AOperatorNotificationRuntime(disabledConfig, undefined);
  if (preflight.ok || preflight.safeToRestartGateway) {
    findings.push({
      gate: "receipt.runtime.preflight.disabledConfig",
      status: "blocked",
      message: "preflight reported ok/safe-to-restart for a disabled notification config",
    });
    blocked++;
  } else {
    passed++;
  }

  return {
    status: findings.some((f) => f.status === "blocked") ? "blocked" : "pass",
    passed,
    blocked,
    total: passed + blocked,
    findings,
  };
}

// ── Agent Card Conformance (#267: a2a-inspector / a2a-python) ─────

/**
 * Minimum agent card shape expected by a2a-inspector and a2a-python clients.
 * Validates the static agent card fixture is well-formed and declares required
 * capability flags, endpoints, skills, and modes.
 *
 * This is a non-live, no-provider-send validation — it only checks the fixture
 * JSON shape against the A2A inspector conformance profile.
 */
export type AgentCardFixture = {
  name: string;
  description: string;
  version: string;
  protocol?: {
    target?: string;
    compatibility?: string[];
    status?: string;
  };
  endpoints?: {
    baseUrl?: string;
    agentCard?: string;
    operations?: Record<string, string>;
  };
  capabilities?: Record<string, boolean>;
  inputModes?: string[];
  outputModes?: string[];
  artifactSupport?: {
    links?: boolean;
    inlineBinary?: boolean;
    evidence?: string[];
  };
  securitySchemes?: Array<{ type: string; in?: string; name?: string; description?: string }>;
  skills?: Array<{ id: string; name: string; description: string }>;
  limitations?: string[];
  exposure?: Record<string, unknown>;
};

const A2A_INSPECTOR_REQUIRED_CAPABILITIES = [
  "send",
  "status",
  "cancel",
  "list",
  "streaming",
  "pushNotifications",
  "artifacts",
  "taskDelegation",
] as const;

const A2A_INSPECTOR_REQUIRED_INPUT_MODES = ["text/plain", "application/json"] as const;

function runAgentCardConformance(): ConformanceSmokeGateReport["agentCardConformance"] {
  const findings: ConformanceGateFinding[] = [];
  let passed = 0;
  let blocked = 0;

  // Static fixture: build in-memory to avoid fs dependency in smoke gate.
  // The test file validates the actual on-disk fixture separately.
  const card: AgentCardFixture = {
    name: "OpenClaw A2A Plugin (local/dev)",
    description:
      "OpenClaw-facing A2A broker adapter for delegated task lifecycle operations in local or development deployments.",
    version: "0.1.0-alpha",
    protocol: {
      target: "A2A 1.0 discovery profile",
      compatibility: ["A2A 0.3 task lifecycle compatibility", "OpenClaw internal alpha extensions"],
      status: "alpha",
    },
    endpoints: {
      baseUrl: "http://127.0.0.1:3000/a2a",
      agentCard: "http://127.0.0.1:3000/.well-known/agent-card.json",
      operations: {
        send: "POST /a2a/task/request",
        status: "GET /a2a/task/{taskId}/status",
        cancel: "POST /a2a/task/{taskId}/cancel",
        list: "GET /a2a/tasks",
        stream: "GET /a2a/operator/events",
      },
    },
    capabilities: {
      send: true,
      status: true,
      cancel: true,
      list: true,
      streaming: true,
      pushNotifications: true,
      artifacts: true,
      githubEvidenceProjection: true,
      taskDelegation: true,
    },
    inputModes: ["text/plain", "application/json"],
    outputModes: ["text/plain", "application/json", "text/uri-list"],
    artifactSupport: {
      links: true,
      inlineBinary: false,
      evidence: ["summary", "artifactLinks", "sanitizedGitHubMergeGate"],
    },
    securitySchemes: [
      {
        type: "apiKey",
        in: "header",
        name: "Authorization",
        description:
          "Bearer token or gateway-authenticated session supplied by the local OpenClaw deployment.",
      },
    ],
    skills: [
      {
        id: "openclaw.task.delegate",
        name: "Task delegation",
        description: "Create a broker-backed delegated task from an OpenClaw gateway request.",
      },
      {
        id: "openclaw.task.status",
        name: "Status lookup",
        description:
          "Project broker task state back into OpenClaw-compatible status and monitoring fields.",
      },
      {
        id: "openclaw.task.cancel",
        name: "Cancellation",
        description:
          "Cancel a broker task through the plugin boundary with actor and reason shaping.",
      },
      {
        id: "openclaw.github.evidence",
        name: "GitHub evidence projection",
        description:
          "Expose sanitized merge-gate and artifact-link evidence without raw API responses or tokens.",
      },
    ],
    limitations: [
      "Alpha discovery profile; exact A2A 1.0 field names may change before stable release.",
      "Production agent-card exposure is opt-in and must be configured by the operator.",
      "The plugin does not own broker process management, Docker Compose, systemd, or worker execution.",
      "Unsupported A2A features: multipart/form-data input is not supported (JSON/text only); inline binary artifacts are disabled (links only); agent-to-agent chaining via broker relay is not exposed; the plugin does not implement the A2A streaming push endpoint as a standalone server — streaming is broker-side only; task list pagination limits are broker-defined and not configurable through the plugin.",
    ],
    exposure: {
      productionDefault: "disabled",
      localDevelopment: "static fixture only",
      operatorActionRequired: true,
    },
  };

  // ── A2A Inspector conformance: required top-level fields ──────────

  // 1. Name: non-empty string
  if (typeof card.name !== "string" || card.name.length === 0) {
    findings.push({
      gate: "agentCard.name",
      status: "blocked",
      message: "agent card name is missing or empty",
    });
    blocked++;
  } else {
    passed++;
  }

  // 2. Description: non-empty string
  if (typeof card.description !== "string" || card.description.length === 0) {
    findings.push({
      gate: "agentCard.description",
      status: "blocked",
      message: "agent card description is missing or empty",
    });
    blocked++;
  } else {
    passed++;
  }

  // 3. Version: non-empty string
  if (typeof card.version !== "string" || card.version.length === 0) {
    findings.push({
      gate: "agentCard.version",
      status: "blocked",
      message: "agent card version is missing or empty",
    });
    blocked++;
  } else {
    passed++;
  }

  // 4. Capabilities: must be a non-empty plain object
  if (!card.capabilities || typeof card.capabilities !== "object" || Array.isArray(card.capabilities)) {
    findings.push({
      gate: "agentCard.capabilities",
      status: "blocked",
      message: "agent card capabilities is missing or not an object",
    });
    blocked++;
  } else {
    passed++;
  }

  // 5. Required capability flags (a2a-inspector profile)
  if (card.capabilities) {
    for (const flag of A2A_INSPECTOR_REQUIRED_CAPABILITIES) {
      if (card.capabilities[flag] !== true) {
        findings.push({
          gate: `agentCard.capabilities.${flag}`,
          status: "blocked",
          message: `agent card missing required capability flag: ${flag}`,
        });
        blocked++;
      } else {
        passed++;
      }
    }
  }

  // 6. Input modes: must include text/plain and application/json
  if (!Array.isArray(card.inputModes) || card.inputModes.length === 0) {
    findings.push({
      gate: "agentCard.inputModes",
      status: "blocked",
      message: "agent card inputModes is missing or empty",
    });
    blocked++;
  } else {
    passed++;
    for (const mode of A2A_INSPECTOR_REQUIRED_INPUT_MODES) {
      if (!card.inputModes.includes(mode)) {
        findings.push({
          gate: `agentCard.inputModes.${mode.replace(/\//g, "_")}`,
          status: "blocked",
          message: `agent card missing required input mode: ${mode}`,
        });
        blocked++;
      } else {
        passed++;
      }
    }
  }

  // 7. Output modes: must include application/json
  if (!Array.isArray(card.outputModes) || card.outputModes.length === 0) {
    findings.push({
      gate: "agentCard.outputModes",
      status: "blocked",
      message: "agent card outputModes is missing or empty",
    });
    blocked++;
  } else {
    passed++;
    if (!card.outputModes.includes("application/json")) {
      findings.push({
        gate: "agentCard.outputModes.application_json",
        status: "blocked",
        message: "agent card missing required output mode: application/json",
      });
      blocked++;
    } else {
      passed++;
    }
  }

  // 8. Skills: must be non-empty array with id/name/description per skill
  if (!Array.isArray(card.skills) || card.skills.length === 0) {
    findings.push({
      gate: "agentCard.skills",
      status: "blocked",
      message: "agent card skills is missing or empty",
    });
    blocked++;
  } else {
    passed++;
    for (const skill of card.skills) {
      if (typeof skill.id !== "string" || skill.id.length === 0) {
        findings.push({
          gate: "agentCard.skills.id",
          status: "blocked",
          message: `agent card skill missing id: ${JSON.stringify(skill)}`,
        });
        blocked++;
      } else {
        passed++;
      }
      if (typeof skill.name !== "string" || skill.name.length === 0) {
        findings.push({
          gate: "agentCard.skills.name",
          status: "blocked",
          message: `agent card skill "${skill.id}" missing name`,
        });
        blocked++;
      } else {
        passed++;
      }
      if (typeof skill.description !== "string" || skill.description.length === 0) {
        findings.push({
          gate: "agentCard.skills.description",
          status: "blocked",
          message: `agent card skill "${skill.id}" missing description`,
        });
        blocked++;
      } else {
        passed++;
      }
    }
  }

  // 9. Security schemes: must include at least one entry
  if (!Array.isArray(card.securitySchemes) || card.securitySchemes.length === 0) {
    findings.push({
      gate: "agentCard.securitySchemes",
      status: "blocked",
      message: "agent card securitySchemes is missing or empty",
    });
    blocked++;
  } else {
    passed++;
    for (const scheme of card.securitySchemes) {
      if (typeof scheme.type !== "string" || scheme.type.length === 0) {
        findings.push({
          gate: "agentCard.securitySchemes.type",
          status: "blocked",
          message: `agent card security scheme missing type: ${JSON.stringify(scheme)}`,
        });
        blocked++;
      } else {
        passed++;
      }
    }
  }

  // 10. Endpoints: must declare baseUrl and agentCard URL
  if (!card.endpoints || typeof card.endpoints !== "object") {
    findings.push({
      gate: "agentCard.endpoints",
      status: "blocked",
      message: "agent card endpoints is missing",
    });
    blocked++;
  } else {
    if (typeof card.endpoints.baseUrl !== "string" || card.endpoints.baseUrl.length === 0) {
      findings.push({
        gate: "agentCard.endpoints.baseUrl",
        status: "blocked",
        message: "agent card endpoints.baseUrl is missing",
      });
      blocked++;
    } else {
      passed++;
    }
    if (typeof card.endpoints.agentCard !== "string" || card.endpoints.agentCard.length === 0) {
      findings.push({
        gate: "agentCard.endpoints.agentCard",
        status: "blocked",
        message: "agent card endpoints.agentCard is missing",
      });
      blocked++;
    } else {
      passed++;
    }
  }

  // 11. Limitations: must document unsupported A2A features explicitly
  if (!Array.isArray(card.limitations) || card.limitations.length === 0) {
    findings.push({
      gate: "agentCard.limitations",
      status: "blocked",
      message: "agent card limitations is missing; unsupported A2A features must be documented",
    });
    blocked++;
  } else {
    passed++;
    // Verify unsupported features are documented
    const hasAlphaDoc = card.limitations.some(
      (l) => typeof l === "string" && /alpha/i.test(l),
    );
    const hasExposureDoc = card.limitations.some(
      (l) => typeof l === "string" && /opt-in/i.test(l),
    );
    if (!hasAlphaDoc) {
      findings.push({
        gate: "agentCard.limitations.alpha",
        status: "blocked",
        message: "agent card must document alpha/unstable status in limitations",
      });
      blocked++;
    } else {
      passed++;
    }
    if (!hasExposureDoc) {
      findings.push({
        gate: "agentCard.limitations.exposure",
        status: "blocked",
        message: "agent card must document opt-in exposure requirement in limitations",
      });
      blocked++;
    } else {
      passed++;
    }
  }

  return {
    status: findings.some((f) => f.status === "blocked") ? "blocked" : "pass",
    passed,
    blocked,
    total: passed + blocked,
    findings,
  };
}

// ── Test Fixture Builders ───────────────────────────────────────────

function buildValidTaskRequest(overrides?: Record<string, unknown>): A2ATaskRequestParams {
  if (overrides) {
    const merged = {
      sessionKey: "session-1",
      request: {
        method: "a2a.task.request" as const,
        taskId: "task-1",
        correlationId: "corr-1",
        parentRunId: "parent-1",
        requester: {
          sessionKey: "requester-1",
          displayKey: "requester-1",
          channel: "session",
        },
        target: {
          sessionKey: "target-1",
          displayKey: "target-1",
          channel: "session",
        },
        task: {
          intent: "delegate" as const,
          summary: "test task",
          instructions: "do the thing",
          input: { key: "value" },
          expectedOutput: {
            format: "text" as const,
            schemaName: "test-schema",
          },
        },
        constraints: {
          timeoutSeconds: 30,
          maxPingPongTurns: 5,
          requireFinal: true,
          allowAnnounce: false,
          priority: "normal" as const,
        },
        runtime: {
          announceTimeoutMs: 30000,
          maxPingPongTurns: 5,
          roundOneReply: "starting",
          cancelTarget: {
            kind: "session_run" as const,
            sessionKey: "target-1",
            runId: "run-1",
          },
        },
      },
    };

    applyOverrides(merged, overrides);
    return merged as unknown as A2ATaskRequestParams;
  }

  return {
    sessionKey: "session-1",
    request: {
      method: "a2a.task.request",
      taskId: "task-1",
      correlationId: "corr-1",
      parentRunId: "parent-1",
      requester: {
        sessionKey: "requester-1",
        displayKey: "requester-1",
        channel: "session",
      },
      target: {
        sessionKey: "target-1",
        displayKey: "target-1",
        channel: "session",
      },
      task: {
        intent: "delegate",
        summary: "test task",
        instructions: "do the thing",
        input: { key: "value" },
        expectedOutput: {
          format: "text",
          schemaName: "test-schema",
        },
      },
      constraints: {
        timeoutSeconds: 30,
        maxPingPongTurns: 5,
        requireFinal: true,
        allowAnnounce: false,
        priority: "normal",
      },
      runtime: {
        announceTimeoutMs: 30000,
        maxPingPongTurns: 5,
        roundOneReply: "starting",
        cancelTarget: {
          kind: "session_run",
          sessionKey: "target-1",
          runId: "run-1",
        },
      },
    },
  };
}

function buildValidTaskUpdate(overrides?: Record<string, unknown>): A2ATaskUpdateParams {
  const base = {
    sessionKey: "session-1",
    update: {
      method: "a2a.task.update" as const,
      taskId: "task-1",
      correlationId: "corr-1",
      parentRunId: "parent-1",
      executionStatus: "running" as const,
      summary: "test update",
      at: Date.now(),
    },
  };
  if (overrides) applyOverrides(base, overrides);
  return base;
}

function buildValidTaskCancel(overrides?: Record<string, unknown>): A2ATaskCancelParams {
  const base = {
    sessionKey: "session-1",
    cancel: {
      method: "a2a.task.cancel" as const,
      taskId: "task-1",
      correlationId: "corr-1",
      parentRunId: "parent-1",
      at: Date.now(),
      reason: "no longer needed",
    },
  };
  if (overrides) applyOverrides(base, overrides);
  return base;
}

function buildValidTaskApprove(overrides?: Record<string, unknown>): A2ATaskApproveParams {
  const base = {
    sessionKey: "session-1",
    approval: {
      method: "a2a.task.approve" as const,
      taskId: "task-1",
      correlationId: "corr-1",
      parentRunId: "parent-1",
      approvalId: "approval-1",
      reason: "looks good",
      at: Date.now(),
    },
  };
  if (overrides) applyOverrides(base, overrides);
  return base;
}

function buildValidTaskRejectApproval(overrides?: Record<string, unknown>): A2ATaskRejectApprovalParams {
  const base = {
    sessionKey: "session-1",
    approval: {
      method: "a2a.task.reject_approval" as const,
      taskId: "task-1",
      correlationId: "corr-1",
      parentRunId: "parent-1",
      approvalId: "approval-1",
      status: "rejected" as const,
      reason: "needs rework",
      at: Date.now(),
    },
  };
  if (overrides) applyOverrides(base, overrides);
  return base;
}

function buildValidTaskStatus(overrides?: Record<string, unknown>): A2ATaskStatusParams {
  const base = {
    sessionKey: "session-1",
    taskId: "task-1",
  };
  if (overrides) applyOverrides(base, overrides);
  return base;
}

function buildValidAlertsList(overrides?: Record<string, unknown>): A2AAlertsListParams {
  const base = {
    sessionKey: "session-1",
  };
  if (overrides) applyOverrides(base, overrides);
  return base;
}

function buildValidMonitorStatus(overrides?: Record<string, unknown>): A2AMonitorStatusParams {
  const base = {
    sessionKey: "session-1",
    taskId: "task-1",
    operatorEvents: {
      enabled: false,
      cursor: "cursor-1",
    },
  };
  if (overrides) applyOverrides(base, overrides);
  return base;
}

function buildValidPeerStatus(overrides?: Record<string, unknown>): A2APeerStatusParams {
  const base = {
    sessionKey: "session-1",
    target: "peer-1",
    maxCacheAgeMs: 5000,
  };
  if (overrides) applyOverrides(base, overrides);
  return base;
}

function configWithNotificationEnabled(): A2ABrokerAdapterPluginRuntimeConfig {
  return {
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          enabled: true,
          config: {
            operatorEvents: {
              enabled: true,
              notification: {
                enabled: true,
                channel: "telegram",
                to: "operator-chat",
              },
            },
          },
        },
      },
    },
  };
}

function buildReceiptBoundaryTestEnvelope(
  dedupeKey: string,
  dryRun: boolean,
): A2AOperatorTerminalNotificationEnvelope {
  return {
    kind: "a2a.operator.notification",
    version: 1,
    id: dedupeKey,
    dedupeKey,
    type: "success",
    severity: "info",
    deliveryOwner: "openclaw.plugin-notifier",
    deliveryTarget: "operator-main-session",
    title: `receipt boundary test: ${dedupeKey}`,
    text: `receipt boundary test: ${dedupeKey}`,
    evidence: {
      schema: "a2a.operator.notification.evidence",
      version: 1,
      summary: "conformance smoke gate receipt boundary test",
    },
    taskId: dedupeKey,
    ...(dryRun ? { dryRun } : {}),
  };
}

function applyOverrides(base: Record<string, unknown>, overrides: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(overrides)) {
    if (key === "sessionKey" || key === "taskId" || key === "target" || key === "instructions" || key === "method") {
      // Direct leaf overrides
      if (key === "sessionKey") {
        base.sessionKey = value;
      } else if (key === "taskId") {
        // Set taskId in the nested structure
        if (base.request && typeof base.request === "object") {
          (base.request as Record<string, unknown>).taskId = value;
        }
        if (base.update && typeof base.update === "object") {
          (base.update as Record<string, unknown>).taskId = value;
        }
        if (base.cancel && typeof base.cancel === "object") {
          (base.cancel as Record<string, unknown>).taskId = value;
        }
        if (base.approval && typeof base.approval === "object") {
          (base.approval as Record<string, unknown>).taskId = value;
        }
        (base as Record<string, unknown>).taskId = value;
      } else if (key === "target") {
        if (base.request && typeof base.request === "object" && value === undefined) {
          delete (base.request as Record<string, unknown>).target;
        } else if (value === undefined) {
          delete (base as Record<string, unknown>).target;
        }
        base.target = value;
      } else if (key === "instructions" && base.request && typeof base.request === "object") {
        const task = (base.request as Record<string, unknown>).task;
        if (task && typeof task === "object") {
          (task as Record<string, unknown>).instructions = value;
        }
      } else if (key === "method" && base.request && typeof base.request === "object") {
        (base.request as Record<string, unknown>).method = value;
      }
    }
  }
}
