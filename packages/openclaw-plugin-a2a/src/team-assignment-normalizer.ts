/**
 * Team assignment normalizer (plugin adapter side).
 *
 * Translates a raw team-assignment intent (from /a2a assign team or
 * programmatic callers) into one or more validated A2ATaskRequestParams,
 * the same shape the a2a.task.request gateway handler accepts.
 *
 * Boundary: this module never imports OpenClaw internals. The output is the
 * plugin gateway schema, so the broker only ever sees normalized A2A task
 * requests — no leakage of OpenClaw session/runtime types.
 */

import type { A2ATaskRequestParams } from "./gateway-schema.js";
import { isPlainObject } from "./value-guards.js";

export const TeamAssignmentModes = ["fanout", "split", "review", "swarm"] as const;
export type TeamAssignmentMode = (typeof TeamAssignmentModes)[number];

export interface TeamAssignmentRequester {
  sessionKey: string;
  displayKey?: string;
  channel?: string;
}

export interface TeamAssignmentConstraints {
  timeoutSeconds?: number;
  maxPingPongTurns?: number;
  requireFinal?: boolean;
  allowAnnounce?: boolean;
  priority?: "low" | "normal" | "high";
}

export interface TeamAssignmentInput {
  assignmentMode: TeamAssignmentMode;
  targetNodes: string[];
  instructions: string;
  summary?: string;
  requester: TeamAssignmentRequester;
  constraints?: TeamAssignmentConstraints;
  lanes?: string[];
  workMode?: string;
}

export interface TeamAssignmentResult {
  requests: A2ATaskRequestParams[];
}

export const TeamAssignmentErrorCodes = {
  INVALID_INPUT_SHAPE: "INVALID_INPUT_SHAPE",
  INVALID_ASSIGNMENT_MODE: "INVALID_ASSIGNMENT_MODE",
  INVALID_TARGET_NODES: "INVALID_TARGET_NODES",
  INVALID_INSTRUCTIONS: "INVALID_INSTRUCTIONS",
  INVALID_REQUESTER: "INVALID_REQUESTER",
  SECRET_LEAK_DETECTED: "SECRET_LEAK_DETECTED",
} as const;

export type TeamAssignmentErrorCode =
  (typeof TeamAssignmentErrorCodes)[keyof typeof TeamAssignmentErrorCodes];

export interface TeamAssignmentValidationError {
  code: TeamAssignmentErrorCode;
  message: string;
}

export type TeamAssignmentValidation =
  | { valid: true; data: TeamAssignmentInput }
  | { valid: false; error: TeamAssignmentValidationError };

const VALID_MODES: ReadonlySet<string> = new Set(TeamAssignmentModes);

const ALLOWED_INPUT_KEYS = new Set([
  "assignmentMode",
  "targetNodes",
  "instructions",
  "summary",
  "requester",
  "constraints",
  "lanes",
  "workMode",
]);

const ALLOWED_REQUESTER_KEYS = new Set(["sessionKey", "displayKey", "channel"]);

const ALLOWED_CONSTRAINT_KEYS = new Set([
  "timeoutSeconds",
  "maxPingPongTurns",
  "requireFinal",
  "allowAnnounce",
  "priority",
]);

const NODE_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:@\-+]{0,127})$/;

const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /\bgh[opsur]_[A-Za-z0-9]{20,}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bauthorization\s*:\s*bearer\s+[A-Za-z0-9._\-]+/i,
  /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*\S+/i,
];

function bad(
  code: TeamAssignmentErrorCode,
  message: string,
): { valid: false; error: TeamAssignmentValidationError } {
  return { valid: false, error: { code, message } };
}

function trimNonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}


function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function detectSecret(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

export function validateTeamAssignmentInput(input: unknown): TeamAssignmentValidation {
  if (!isPlainObject(input)) {
    return bad(
      TeamAssignmentErrorCodes.INVALID_INPUT_SHAPE,
      "team assignment input must be an object",
    );
  }
  for (const key of Object.keys(input)) {
    if (!ALLOWED_INPUT_KEYS.has(key)) {
      return bad(
        TeamAssignmentErrorCodes.INVALID_INPUT_SHAPE,
        `unknown field in team assignment input: ${key}`,
      );
    }
  }

  const rawMode = input.assignmentMode;
  if (typeof rawMode !== "string" || !VALID_MODES.has(rawMode)) {
    const got = typeof rawMode === "string" ? rawMode : typeof rawMode;
    return bad(
      TeamAssignmentErrorCodes.INVALID_ASSIGNMENT_MODE,
      `assignmentMode must be one of: ${TeamAssignmentModes.join(", ")} (got ${got})`,
    );
  }
  const assignmentMode = rawMode as TeamAssignmentMode;

  const rawTargets = input.targetNodes;
  if (!Array.isArray(rawTargets) || rawTargets.length === 0) {
    return bad(
      TeamAssignmentErrorCodes.INVALID_TARGET_NODES,
      "targetNodes must be a non-empty array of node id strings",
    );
  }
  if (!isStringArray(rawTargets)) {
    return bad(
      TeamAssignmentErrorCodes.INVALID_TARGET_NODES,
      "targetNodes must contain only strings",
    );
  }
  const targetNodes: string[] = [];
  const seen = new Set<string>();
  for (const node of rawTargets) {
    const trimmed = node.trim();
    if (!trimmed) {
      return bad(
        TeamAssignmentErrorCodes.INVALID_TARGET_NODES,
        "targetNodes contains an empty entry",
      );
    }
    if (!NODE_ID_PATTERN.test(trimmed)) {
      return bad(
        TeamAssignmentErrorCodes.INVALID_TARGET_NODES,
        `targetNodes contains an invalid node id: ${trimmed}`,
      );
    }
    if (seen.has(trimmed)) {
      return bad(
        TeamAssignmentErrorCodes.INVALID_TARGET_NODES,
        `targetNodes contains duplicate entry: ${trimmed}`,
      );
    }
    seen.add(trimmed);
    targetNodes.push(trimmed);
  }

  const instructions = trimNonEmpty(input.instructions);
  if (!instructions) {
    return bad(
      TeamAssignmentErrorCodes.INVALID_INSTRUCTIONS,
      "instructions must be a non-empty string",
    );
  }

  let summary: string | undefined;
  if (input.summary !== undefined) {
    summary = trimNonEmpty(input.summary);
    if (!summary) {
      return bad(
        TeamAssignmentErrorCodes.INVALID_INPUT_SHAPE,
        "summary must be a non-empty string when provided",
      );
    }
  }

  if (!isPlainObject(input.requester)) {
    return bad(TeamAssignmentErrorCodes.INVALID_REQUESTER, "requester is required");
  }
  for (const key of Object.keys(input.requester)) {
    if (!ALLOWED_REQUESTER_KEYS.has(key)) {
      return bad(
        TeamAssignmentErrorCodes.INVALID_REQUESTER,
        `unknown field in requester: ${key}`,
      );
    }
  }
  const requesterSessionKey = trimNonEmpty(input.requester.sessionKey);
  if (!requesterSessionKey) {
    return bad(
      TeamAssignmentErrorCodes.INVALID_REQUESTER,
      "requester.sessionKey is required",
    );
  }
  let requesterDisplayKey: string | undefined;
  if (input.requester.displayKey !== undefined) {
    requesterDisplayKey = trimNonEmpty(input.requester.displayKey);
    if (!requesterDisplayKey) {
      return bad(
        TeamAssignmentErrorCodes.INVALID_REQUESTER,
        "requester.displayKey must be non-empty when provided",
      );
    }
  }
  let requesterChannel: string | undefined;
  if (input.requester.channel !== undefined) {
    requesterChannel = trimNonEmpty(input.requester.channel);
    if (!requesterChannel) {
      return bad(
        TeamAssignmentErrorCodes.INVALID_REQUESTER,
        "requester.channel must be non-empty when provided",
      );
    }
  }
  const requester: TeamAssignmentRequester = {
    sessionKey: requesterSessionKey,
    ...(requesterDisplayKey ? { displayKey: requesterDisplayKey } : {}),
    ...(requesterChannel ? { channel: requesterChannel } : {}),
  };

  let constraints: TeamAssignmentConstraints | undefined;
  if (input.constraints !== undefined) {
    if (!isPlainObject(input.constraints)) {
      return bad(
        TeamAssignmentErrorCodes.INVALID_INPUT_SHAPE,
        "constraints must be an object when provided",
      );
    }
    for (const key of Object.keys(input.constraints)) {
      if (!ALLOWED_CONSTRAINT_KEYS.has(key)) {
        return bad(
          TeamAssignmentErrorCodes.INVALID_INPUT_SHAPE,
          `unknown field in constraints: ${key}`,
        );
      }
    }
    const c = input.constraints;
    constraints = {};
    if (c.timeoutSeconds !== undefined) {
      if (
        typeof c.timeoutSeconds !== "number" ||
        !Number.isInteger(c.timeoutSeconds) ||
        c.timeoutSeconds < 1
      ) {
        return bad(
          TeamAssignmentErrorCodes.INVALID_INPUT_SHAPE,
          "constraints.timeoutSeconds must be a positive integer",
        );
      }
      constraints.timeoutSeconds = c.timeoutSeconds;
    }
    if (c.maxPingPongTurns !== undefined) {
      if (
        typeof c.maxPingPongTurns !== "number" ||
        !Number.isInteger(c.maxPingPongTurns) ||
        c.maxPingPongTurns < 0
      ) {
        return bad(
          TeamAssignmentErrorCodes.INVALID_INPUT_SHAPE,
          "constraints.maxPingPongTurns must be a non-negative integer",
        );
      }
      constraints.maxPingPongTurns = c.maxPingPongTurns;
    }
    if (c.requireFinal !== undefined) {
      if (typeof c.requireFinal !== "boolean") {
        return bad(
          TeamAssignmentErrorCodes.INVALID_INPUT_SHAPE,
          "constraints.requireFinal must be boolean",
        );
      }
      constraints.requireFinal = c.requireFinal;
    }
    if (c.allowAnnounce !== undefined) {
      if (typeof c.allowAnnounce !== "boolean") {
        return bad(
          TeamAssignmentErrorCodes.INVALID_INPUT_SHAPE,
          "constraints.allowAnnounce must be boolean",
        );
      }
      constraints.allowAnnounce = c.allowAnnounce;
    }
    if (c.priority !== undefined) {
      if (c.priority !== "low" && c.priority !== "normal" && c.priority !== "high") {
        return bad(
          TeamAssignmentErrorCodes.INVALID_INPUT_SHAPE,
          "constraints.priority must be one of: low, normal, high",
        );
      }
      constraints.priority = c.priority;
    }
  }

  let lanes: string[] | undefined;
  if (input.lanes !== undefined) {
    if (!isStringArray(input.lanes)) {
      return bad(
        TeamAssignmentErrorCodes.INVALID_INPUT_SHAPE,
        "lanes must be an array of strings when provided",
      );
    }
    const trimmedLanes: string[] = [];
    for (const lane of input.lanes) {
      const trimmed = lane.trim();
      if (!trimmed) {
        return bad(
          TeamAssignmentErrorCodes.INVALID_INPUT_SHAPE,
          "lanes contains an empty entry",
        );
      }
      trimmedLanes.push(trimmed);
    }
    lanes = trimmedLanes;
  }

  let workMode: string | undefined;
  if (input.workMode !== undefined) {
    workMode = trimNonEmpty(input.workMode);
    if (!workMode) {
      return bad(
        TeamAssignmentErrorCodes.INVALID_INPUT_SHAPE,
        "workMode must be a non-empty string when provided",
      );
    }
  }

  // Defense-in-depth: refuse any payload that looks like it carries a token,
  // raw credential, or other secret. The plugin must not relay these to the
  // broker even by accident.
  // requester.* and targetNodes are forwarded to the broker verbatim by
  // buildRequest, so they must be scanned too — a displayKey of
  // "api_key=sk-..." previously passed through unchecked.
  const scanFields = [
    instructions,
    summary,
    ...(lanes ?? []),
    ...(workMode ? [workMode] : []),
    requesterSessionKey,
    ...(requesterDisplayKey ? [requesterDisplayKey] : []),
    ...(requesterChannel ? [requesterChannel] : []),
    ...targetNodes,
  ];
  for (const value of scanFields) {
    if (value && detectSecret(value)) {
      return bad(
        TeamAssignmentErrorCodes.SECRET_LEAK_DETECTED,
        "team assignment input appears to contain a credential, token, or private key",
      );
    }
  }

  const data: TeamAssignmentInput = {
    assignmentMode,
    targetNodes,
    instructions,
    ...(summary ? { summary } : {}),
    requester,
    ...(constraints ? { constraints } : {}),
    ...(lanes ? { lanes } : {}),
    ...(workMode ? { workMode } : {}),
  };
  return { valid: true, data };
}

export function normalizeTeamAssignment(input: TeamAssignmentInput): TeamAssignmentResult {
  // Defensive re-check: programmatic callers may bypass the validator entirely,
  // and we never want a malformed task to reach the broker.
  const check = validateTeamAssignmentInput(input);
  if (!check.valid) {
    throw new Error(`[${check.error.code}] ${check.error.message}`);
  }
  const data = check.data;

  if (data.assignmentMode === "fanout") {
    return {
      requests: data.targetNodes.map((node) => buildRequest(data, [node])),
    };
  }
  return { requests: [buildRequest(data, data.targetNodes)] };
}

function buildRequest(
  input: TeamAssignmentInput,
  targets: string[],
): A2ATaskRequestParams {
  const primary = targets[0];
  const taskInput: Record<string, unknown> = {
    assignmentMode: input.assignmentMode,
    assignmentTargets: targets,
    ...(input.lanes ? { lanes: input.lanes } : {}),
    ...(input.workMode ? { workMode: input.workMode } : {}),
  };
  return {
    sessionKey: input.requester.sessionKey,
    request: {
      method: "a2a.task.request",
      target: {
        sessionKey: primary,
        displayKey: primary,
      },
      requester: {
        sessionKey: input.requester.sessionKey,
        displayKey: input.requester.displayKey ?? input.requester.sessionKey,
        ...(input.requester.channel ? { channel: input.requester.channel } : {}),
      },
      task: {
        intent: "delegate",
        instructions: input.instructions,
        ...(input.summary ? { summary: input.summary } : {}),
        input: taskInput,
      },
      ...(input.constraints ? { constraints: input.constraints } : {}),
    },
  };
}

export type TeamAssignmentBuildResult =
  | { ok: true; requests: A2ATaskRequestParams[] }
  | { ok: false; error: TeamAssignmentValidationError };

/**
 * Convenience wrapper combining validation and normalization.
 * Returns a discriminated result so callers (e.g. gateway handlers) can
 * map errors to a2a error codes without having to throw.
 */
export function buildTeamAssignmentRequests(input: unknown): TeamAssignmentBuildResult {
  const check = validateTeamAssignmentInput(input);
  if (!check.valid) {
    return { ok: false, error: check.error };
  }
  return { ok: true, requests: normalizeTeamAssignment(check.data).requests };
}
