import {
  BROKER_POLICY_WORKER_CLASSES,
  evaluateTaskPolicy,
  validateBrokerPolicyDocument,
  type BrokerPolicyDecision,
  type BrokerPolicyDocument,
  type BrokerPolicyEvaluationInput,
  type BrokerPolicyMode,
} from "./broker-policy.js";

export const POLICY_REFEREE_TASK_SCHEMA = "a2a.policy-referee.task.v1";
export const POLICY_REFEREE_WORKER_SCHEMA = "a2a.policy-referee.worker.v1";
export const POLICY_REFEREE_DECISION_SCHEMA = "a2a.policy-referee.decision.v1";
export const POLICY_REFEREE_ERROR_SCHEMA = "a2a.policy-referee.error.v1";
export const POLICY_REFEREE_MAX_TASKS_TODAY = 1_000_000;

export const POLICY_REFEREE_EXIT = Object.freeze({
  allow: 0,
  requireApproval: 10,
  deny: 20,
  invalidInput: 64,
  internalFailure: 70,
} as const);

const TOKEN_PATTERN = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;
const TOKEN_MAX_LENGTH = 64;
const TASK_FIELDS = new Set(["schemaVersion", "intent", "mode", "evaluationPoint", "tasksToday"]);
const WORKER_FIELDS = new Set(["schemaVersion", "workerClass", "implementation"]);
const IMPLEMENTATION_FIELDS = new Set(["isImplementationIntent", "ready"]);

export type PolicyRefereeInputKind = "arguments" | "policy" | "task" | "worker";

export type PolicyRefereeErrorCode =
  | "file_too_large"
  | "file_unreadable"
  | "invalid_enum"
  | "invalid_integer"
  | "invalid_json"
  | "invalid_policy"
  | "invalid_structure"
  | "invalid_token"
  | "invalid_type"
  | "invalid_usage"
  | "invalid_utf8"
  | "invalid_version"
  | "non_plain_object"
  | "required_field"
  | "unexpected_field"
  | "unknown_field";

export class PolicyRefereeInputError extends Error {
  readonly code: PolicyRefereeErrorCode;
  readonly input: PolicyRefereeInputKind;
  readonly path: string;

  constructor(code: PolicyRefereeErrorCode, input: PolicyRefereeInputKind, path: string) {
    super(code);
    this.name = "PolicyRefereeInputError";
    this.code = code;
    this.input = input;
    this.path = path;
  }
}

export interface PolicyRefereeTaskEnvelope {
  schemaVersion: typeof POLICY_REFEREE_TASK_SCHEMA;
  intent: string;
  mode?: string;
  evaluationPoint: "create" | "claim";
  tasksToday?: number;
}

export interface PolicyRefereeImplementationReadiness {
  isImplementationIntent: boolean;
  ready: boolean;
}

export interface PolicyRefereeWorkerEnvelope {
  schemaVersion: typeof POLICY_REFEREE_WORKER_SCHEMA;
  workerClass: (typeof BROKER_POLICY_WORKER_CLASSES)[number];
  implementation?: PolicyRefereeImplementationReadiness;
}

export type PolicyRefereeReasonCode =
  | "approval_required"
  | "daily_budget_exhausted"
  | "default_allow"
  | "default_deny"
  | "implementation_capability_unready"
  | "implementation_readiness_missing"
  | "intent_not_allowed"
  | "mode_denied"
  | "rule_allow";

export interface PolicyRefereeDecisionEnvelope {
  schemaVersion: typeof POLICY_REFEREE_DECISION_SCHEMA;
  policyMode: BrokerPolicyMode;
  action: BrokerPolicyDecision["action"];
  ruleId?: string;
  reasonCode: PolicyRefereeReasonCode;
  enforceMode: {
    deny: boolean;
    requireApproval: boolean;
  };
}

export interface PolicyRefereeEvaluationResult {
  decision: PolicyRefereeDecisionEnvelope;
  exitCode: number;
}

function inputError(
  code: PolicyRefereeErrorCode,
  input: PolicyRefereeInputKind,
  path: string,
): never {
  throw new PolicyRefereeInputError(code, input, path);
}

function assertPlainJsonTree(value: unknown, input: PolicyRefereeInputKind): void {
  const seen = new WeakSet<object>();
  let nodes = 0;

  function visit(current: unknown, depth: number): void {
    nodes += 1;
    if (nodes > 4_096 || depth > 32) inputError("invalid_structure", input, "$");
    if (current === null || typeof current !== "object") return;
    if (seen.has(current)) inputError("invalid_structure", input, "$");
    seen.add(current);

    if (Array.isArray(current)) {
      if (Object.getPrototypeOf(current) !== Array.prototype) {
        inputError("non_plain_object", input, "$");
      }
      const keys = Object.keys(current);
      if (
        Object.getOwnPropertySymbols(current).length > 0 ||
        keys.length !== current.length ||
        keys.some((key, index) => key !== String(index))
      ) {
        inputError("invalid_structure", input, "$");
      }
      for (const item of current) visit(item, depth + 1);
      return;
    }

    if (Object.getPrototypeOf(current) !== Object.prototype) {
      inputError("non_plain_object", input, "$");
    }
    for (const key in current) {
      if (!Object.hasOwn(current, key)) inputError("non_plain_object", input, "$");
    }
    if (Object.getOwnPropertySymbols(current).length > 0) {
      inputError("invalid_structure", input, "$");
    }
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(current))) {
      if (!("value" in descriptor)) inputError("non_plain_object", input, "$");
      visit(descriptor.value, depth + 1);
    }
  }

  visit(value, 0);
}

function plainRecord(
  value: unknown,
  input: PolicyRefereeInputKind,
  path: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    inputError("invalid_type", input, path);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownFields(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  input: PolicyRefereeInputKind,
  path: string,
): void {
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    inputError("unknown_field", input, path);
  }
}

function canonicalToken(value: unknown, input: PolicyRefereeInputKind, path: string): string {
  if (
    typeof value !== "string" ||
    value.length > TOKEN_MAX_LENGTH ||
    !TOKEN_PATTERN.test(value)
  ) {
    inputError("invalid_token", input, path);
  }
  return value;
}

export function parsePolicyRefereeTaskEnvelope(value: unknown): PolicyRefereeTaskEnvelope {
  assertPlainJsonTree(value, "task");
  const task = plainRecord(value, "task", "$");
  rejectUnknownFields(task, TASK_FIELDS, "task", "$");
  if (task.schemaVersion !== POLICY_REFEREE_TASK_SCHEMA) {
    inputError("invalid_version", "task", "$.schemaVersion");
  }
  const intent = canonicalToken(task.intent, "task", "$.intent");
  const mode = task.mode === undefined
    ? undefined
    : canonicalToken(task.mode, "task", "$.mode");
  if (task.evaluationPoint !== "create" && task.evaluationPoint !== "claim") {
    inputError("invalid_enum", "task", "$.evaluationPoint");
  }
  if (
    task.tasksToday !== undefined &&
    (
      !Number.isSafeInteger(task.tasksToday) ||
      (task.tasksToday as number) < 0 ||
      (task.tasksToday as number) > POLICY_REFEREE_MAX_TASKS_TODAY
    )
  ) {
    inputError("invalid_integer", "task", "$.tasksToday");
  }
  return {
    schemaVersion: POLICY_REFEREE_TASK_SCHEMA,
    intent,
    ...(mode === undefined ? {} : { mode }),
    evaluationPoint: task.evaluationPoint,
    ...(task.tasksToday === undefined ? {} : { tasksToday: task.tasksToday as number }),
  };
}

export function parsePolicyRefereeWorkerEnvelope(value: unknown): PolicyRefereeWorkerEnvelope {
  assertPlainJsonTree(value, "worker");
  const worker = plainRecord(value, "worker", "$");
  rejectUnknownFields(worker, WORKER_FIELDS, "worker", "$");
  if (worker.schemaVersion !== POLICY_REFEREE_WORKER_SCHEMA) {
    inputError("invalid_version", "worker", "$.schemaVersion");
  }
  if (!(BROKER_POLICY_WORKER_CLASSES as readonly unknown[]).includes(worker.workerClass)) {
    inputError("invalid_enum", "worker", "$.workerClass");
  }

  let implementation: PolicyRefereeImplementationReadiness | undefined;
  if (worker.implementation !== undefined) {
    const readiness = plainRecord(worker.implementation, "worker", "$.implementation");
    rejectUnknownFields(readiness, IMPLEMENTATION_FIELDS, "worker", "$.implementation");
    if (
      typeof readiness.isImplementationIntent !== "boolean" ||
      typeof readiness.ready !== "boolean"
    ) {
      inputError("invalid_type", "worker", "$.implementation");
    }
    implementation = {
      isImplementationIntent: readiness.isImplementationIntent,
      ready: readiness.ready,
    };
  }

  return {
    schemaVersion: POLICY_REFEREE_WORKER_SCHEMA,
    workerClass: worker.workerClass as PolicyRefereeWorkerEnvelope["workerClass"],
    ...(implementation === undefined ? {} : { implementation }),
  };
}

export function parsePolicyRefereePolicyDocument(value: unknown): BrokerPolicyDocument {
  assertPlainJsonTree(value, "policy");
  let policy: BrokerPolicyDocument;
  try {
    policy = validateBrokerPolicyDocument(value, "cli");
  } catch {
    inputError("invalid_policy", "policy", "$");
  }
  for (const rule of policy.rules) {
    if (
      rule.maxTasksPerDay !== undefined &&
      (
        !Number.isSafeInteger(rule.maxTasksPerDay) ||
        rule.maxTasksPerDay > POLICY_REFEREE_MAX_TASKS_TODAY
      )
    ) {
      inputError("invalid_integer", "policy", "$.rules[].maxTasksPerDay");
    }
    for (const intent of rule.allowIntents ?? []) {
      canonicalToken(intent, "policy", "$.rules[].allowIntents[]");
    }
    for (const mode of rule.denyModes ?? []) {
      canonicalToken(mode, "policy", "$.rules[].denyModes[]");
    }
  }
  return policy;
}

function reasonCodeForDecision(decision: BrokerPolicyDecision): PolicyRefereeReasonCode {
  if (decision.action === "allow") {
    return decision.ruleId === undefined ? "default_allow" : "rule_allow";
  }
  if (decision.action === "require_approval") return "approval_required";
  if (decision.reason.startsWith("no rule matches worker class ")) return "default_deny";
  if (decision.reason.startsWith("mode '")) return "mode_denied";
  if (decision.reason.startsWith("intent '") && decision.reason.includes(" is not allowed for worker class ")) {
    return "intent_not_allowed";
  }
  if (decision.reason.includes(": readiness was not evaluated")) {
    return "implementation_readiness_missing";
  }
  if (decision.reason.includes(" requires a verified implementation capability for worker class ")) {
    return "implementation_capability_unready";
  }
  if (decision.reason.startsWith("daily task budget exhausted for worker class ")) {
    return "daily_budget_exhausted";
  }
  throw new Error("unrecognized evaluator decision");
}

export function projectPolicyRefereeDecision(
  policyMode: BrokerPolicyMode,
  decision: BrokerPolicyDecision,
): PolicyRefereeDecisionEnvelope {
  return {
    schemaVersion: POLICY_REFEREE_DECISION_SCHEMA,
    policyMode,
    action: decision.action,
    ...("ruleId" in decision && decision.ruleId !== undefined ? { ruleId: decision.ruleId } : {}),
    reasonCode: reasonCodeForDecision(decision),
    enforceMode: {
      deny: decision.action === "deny",
      requireApproval: decision.action === "require_approval",
    },
  };
}

export function evaluatePolicyRefereeCli(
  policy: BrokerPolicyDocument,
  task: PolicyRefereeTaskEnvelope,
  worker: PolicyRefereeWorkerEnvelope,
): PolicyRefereeEvaluationResult {
  let counterUsed = false;
  const evaluationInput: BrokerPolicyEvaluationInput = {
    intent: task.intent,
    ...(task.mode === undefined ? {} : { mode: task.mode }),
    workerClass: worker.workerClass,
    evaluationPoint: task.evaluationPoint,
    ...(worker.implementation === undefined ? {} : { implementation: worker.implementation }),
    countTasksToday: () => {
      counterUsed = true;
      if (task.tasksToday === undefined) {
        inputError("required_field", "task", "$.tasksToday");
      }
      return task.tasksToday;
    },
  };
  const evaluatorDecision = evaluateTaskPolicy(evaluationInput, policy);
  if (task.tasksToday !== undefined && !counterUsed) {
    inputError("unexpected_field", "task", "$.tasksToday");
  }
  const decision = projectPolicyRefereeDecision(policy.mode, evaluatorDecision);
  const exitCode = decision.action === "allow"
    ? POLICY_REFEREE_EXIT.allow
    : decision.action === "require_approval"
      ? POLICY_REFEREE_EXIT.requireApproval
      : POLICY_REFEREE_EXIT.deny;
  return { decision, exitCode };
}
