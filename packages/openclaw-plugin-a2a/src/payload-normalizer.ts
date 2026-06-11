/**
 * Adapter payload compatibility and normalization layer (Round 13).
 *
 * Normalizes GitHub-mode and general-mode task payloads into one stable
 * internal shape (`NormalizedA2APayload`). Preserves backward compatibility
 * with Round 12 payloads (raw `A2ATaskRequestParams`).
 *
 * Boundary: this module never imports OpenClaw internals. It operates purely
 * on the plugin-local adapter shapes.
 */

// ── Error codes ────────────────────────────────────────────────

export const PayloadNormalizerErrorCodes = {
  INVALID_PAYLOAD_SHAPE: "INVALID_PAYLOAD_SHAPE",
  MISSING_REQUIRED_FIELD: "MISSING_REQUIRED_FIELD",
  UNKNOWN_PAYLOAD_MODE: "UNKNOWN_PAYLOAD_MODE",
  BACKWARD_COMPAT_VIOLATION: "BACKWARD_COMPAT_VIOLATION",
  FIELD_TYPE_MISMATCH: "FIELD_TYPE_MISMATCH",
} as const;

export type PayloadNormalizerErrorCode =
  (typeof PayloadNormalizerErrorCodes)[keyof typeof PayloadNormalizerErrorCodes];

export interface PayloadNormalizerError {
  ok: false;
  error: {
    code: PayloadNormalizerErrorCode;
    message: string;
    field?: string;
  };
}

// ── Normalized payload shape ───────────────────────────────────

export type PayloadMode = "github" | "general" | "team-assignment";

export interface NormalizedTarget {
  sessionKey: string;
  displayKey?: string;
  channel?: string;
}

export interface NormalizedRequester {
  sessionKey: string;
  displayKey?: string;
  channel?: string;
}

export interface NormalizedConstraints {
  timeoutSeconds?: number;
  maxPingPongTurns?: number;
  requireFinal?: boolean;
  allowAnnounce?: boolean;
  priority?: "low" | "normal" | "high";
}

export interface NormalizedA2APayload {
  ok: true;
  intent: string;
  instructions: string;
  summary?: string;
  target: NormalizedTarget;
  requester: NormalizedRequester;
  constraints?: NormalizedConstraints;
  metadata: {
    source: PayloadMode;
    detectedMode: PayloadMode;
    originalShape: Record<string, unknown>;
  };
}

export type PayloadNormalizeResult = NormalizedA2APayload | PayloadNormalizerError;

// ── Validation result ──────────────────────────────────────────

export interface PayloadCompatibilityResult {
  compatible: boolean;
  mode: PayloadMode | null;
  warnings: string[];
}

// ── Helpers ────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBool(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function readRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  return isPlainObject(value) ? value : undefined;
}

function fail(
  code: PayloadNormalizerErrorCode,
  message: string,
  field?: string,
): PayloadNormalizerError {
  return { ok: false, error: { code, message, ...(field ? { field } : {}) } };
}

// ── Mode detection ─────────────────────────────────────────────

/**
 * Detect the payload mode from the raw input shape.
 *
 * - "github": has `repository` and (`action` or `sender` or `issue` or `pull_request`)
 * - "team-assignment": has `assignmentMode` and `targetNodes`
 * - "general": has `sessionKey` and `request` (gateway schema shape)
 * - null: cannot determine
 */
export function detectPayloadMode(input: unknown): PayloadMode | null {
  if (!isPlainObject(input)) {
    return null;
  }

  // Team assignment: has assignmentMode + targetNodes
  if (typeof input.assignmentMode === "string" && Array.isArray(input.targetNodes)) {
    return "team-assignment";
  }

  // GitHub: has repository + (action or sender or issue or pull_request)
  if (isPlainObject(input.repository)) {
    if (
      typeof input.action === "string" ||
      isPlainObject(input.sender) ||
      isPlainObject(input.issue) ||
      isPlainObject(input.pull_request)
    ) {
      return "github";
    }
  }

  // General (gateway schema): has sessionKey + request with method
  if (typeof input.sessionKey === "string" && isPlainObject(input.request)) {
    return "general";
  }

  return null;
}

// ── Normalization: general mode (A2ATaskRequestParams) ─────────

function normalizeGeneralMode(input: Record<string, unknown>): PayloadNormalizeResult {
  const request = readRecord(input, "request");
  if (!request) {
    return fail(PayloadNormalizerErrorCodes.MISSING_REQUIRED_FIELD, "request is required", "request");
  }

  const task = readRecord(request, "task");
  if (!task) {
    return fail(PayloadNormalizerErrorCodes.MISSING_REQUIRED_FIELD, "request.task is required", "request.task");
  }

  const target = readRecord(request, "target");
  if (!target) {
    return fail(PayloadNormalizerErrorCodes.MISSING_REQUIRED_FIELD, "request.target is required", "request.target");
  }

  const targetSessionKey = readString(target, "sessionKey");
  if (!targetSessionKey) {
    return fail(PayloadNormalizerErrorCodes.MISSING_REQUIRED_FIELD, "request.target.sessionKey is required", "request.target.sessionKey");
  }

  const instructions = readString(task, "instructions");
  if (!instructions) {
    return fail(PayloadNormalizerErrorCodes.MISSING_REQUIRED_FIELD, "request.task.instructions is required", "request.task.instructions");
  }

  const intent = readString(task, "intent") ?? "delegate";
  const summary = readString(task, "summary");
  const targetDisplayKey = readString(target, "displayKey");
  const targetChannel = readString(target, "channel");

  const requesterBlock = readRecord(request, "requester");
  const sessionKey = readString(input, "sessionKey") ?? "";
  const resolvedRequesterSessionKey = requesterBlock
    ? (readString(requesterBlock, "sessionKey") ?? sessionKey)
    : sessionKey;
  if (!resolvedRequesterSessionKey) {
    // The normalized type requires a non-empty requester.sessionKey; emitting
    // "" pushed an invalid requester downstream to the broker.
    return fail(
      PayloadNormalizerErrorCodes.MISSING_REQUIRED_FIELD,
      "requester.sessionKey (or top-level sessionKey) is required",
      "requester.sessionKey",
    );
  }
  const requester: NormalizedRequester = {
    sessionKey: resolvedRequesterSessionKey,
    ...(requesterBlock?.displayKey ? { displayKey: readString(requesterBlock, "displayKey") } : {}),
    ...(requesterBlock?.channel ? { channel: readString(requesterBlock, "channel") } : {}),
  };

  const constraintsBlock = readRecord(request, "constraints");
  const constraints: NormalizedConstraints | undefined = constraintsBlock
    ? {
        ...(readNumber(constraintsBlock, "timeoutSeconds") !== undefined
          ? { timeoutSeconds: readNumber(constraintsBlock, "timeoutSeconds") }
          : {}),
        ...(readNumber(constraintsBlock, "maxPingPongTurns") !== undefined
          ? { maxPingPongTurns: readNumber(constraintsBlock, "maxPingPongTurns") }
          : {}),
        ...(readBool(constraintsBlock, "requireFinal") !== undefined
          ? { requireFinal: readBool(constraintsBlock, "requireFinal") }
          : {}),
        ...(readBool(constraintsBlock, "allowAnnounce") !== undefined
          ? { allowAnnounce: readBool(constraintsBlock, "allowAnnounce") }
          : {}),
        ...(typeof constraintsBlock.priority === "string" &&
        ["low", "normal", "high"].includes(constraintsBlock.priority)
          ? { priority: constraintsBlock.priority as "low" | "normal" | "high" }
          : {}),
      }
    : undefined;

  return {
    ok: true,
    intent,
    instructions,
    ...(summary ? { summary } : {}),
    target: {
      sessionKey: targetSessionKey,
      ...(targetDisplayKey ? { displayKey: targetDisplayKey } : {}),
      ...(targetChannel ? { channel: targetChannel } : {}),
    },
    requester,
    ...(constraints ? { constraints } : {}),
    metadata: {
      source: "general",
      detectedMode: "general",
      originalShape: input,
    },
  };
}

// ── Normalization: team-assignment mode ────────────────────────

function normalizeTeamAssignmentMode(input: Record<string, unknown>): PayloadNormalizeResult {
  const mode = readString(input, "assignmentMode");
  if (!mode) {
    return fail(PayloadNormalizerErrorCodes.MISSING_REQUIRED_FIELD, "assignmentMode is required", "assignmentMode");
  }

  const targets = input.targetNodes;
  if (!Array.isArray(targets) || targets.length === 0) {
    return fail(PayloadNormalizerErrorCodes.MISSING_REQUIRED_FIELD, "targetNodes must be a non-empty array", "targetNodes");
  }

  const instructions = readString(input, "instructions");
  if (!instructions) {
    return fail(PayloadNormalizerErrorCodes.MISSING_REQUIRED_FIELD, "instructions is required", "instructions");
  }

  const requesterBlock = readRecord(input, "requester");
  if (!requesterBlock) {
    return fail(PayloadNormalizerErrorCodes.MISSING_REQUIRED_FIELD, "requester is required", "requester");
  }

  const requesterSessionKey = readString(requesterBlock, "sessionKey");
  if (!requesterSessionKey) {
    return fail(PayloadNormalizerErrorCodes.MISSING_REQUIRED_FIELD, "requester.sessionKey is required", "requester.sessionKey");
  }

  const firstTarget = typeof targets[0] === "string" ? targets[0].trim() : "";
  if (!firstTarget) {
    return fail(PayloadNormalizerErrorCodes.MISSING_REQUIRED_FIELD, "targetNodes first entry must be a non-empty string", "targetNodes[0]");
  }
  const droppedTargetNodes = targets
    .slice(1)
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());

  const summary = readString(input, "summary");
  const requester: NormalizedRequester = {
    sessionKey: requesterSessionKey,
    ...(readString(requesterBlock, "displayKey") ? { displayKey: readString(requesterBlock, "displayKey") } : {}),
    ...(readString(requesterBlock, "channel") ? { channel: readString(requesterBlock, "channel") } : {}),
  };

  const constraintsBlock = readRecord(input, "constraints");
  const constraints: NormalizedConstraints | undefined = constraintsBlock
    ? {
        ...(readNumber(constraintsBlock, "timeoutSeconds") !== undefined
          ? { timeoutSeconds: readNumber(constraintsBlock, "timeoutSeconds") }
          : {}),
        ...(readNumber(constraintsBlock, "maxPingPongTurns") !== undefined
          ? { maxPingPongTurns: readNumber(constraintsBlock, "maxPingPongTurns") }
          : {}),
        ...(readBool(constraintsBlock, "requireFinal") !== undefined
          ? { requireFinal: readBool(constraintsBlock, "requireFinal") }
          : {}),
        ...(readBool(constraintsBlock, "allowAnnounce") !== undefined
          ? { allowAnnounce: readBool(constraintsBlock, "allowAnnounce") }
          : {}),
        ...(typeof constraintsBlock.priority === "string" &&
        ["low", "normal", "high"].includes(constraintsBlock.priority)
          ? { priority: constraintsBlock.priority as "low" | "normal" | "high" }
          : {}),
      }
    : undefined;

  return {
    ok: true,
    intent: "delegate",
    instructions,
    ...(summary ? { summary } : {}),
    target: {
      sessionKey: firstTarget,
      displayKey: firstTarget,
    },
    requester,
    ...(constraints ? { constraints } : {}),
    metadata: {
      source: "team-assignment",
      detectedMode: "team-assignment",
      originalShape: input,
      // Single-target normalization keeps only targetNodes[0]; surface the
      // rest so multi-target assignments are not dropped silently.
      ...(droppedTargetNodes.length > 0 ? { droppedTargetNodes } : {}),
    },
  };
}

// ── Normalization: github mode ─────────────────────────────────

function normalizeGitHubMode(input: Record<string, unknown>): PayloadNormalizeResult {
  const repo = readRecord(input, "repository");
  if (!repo) {
    return fail(PayloadNormalizerErrorCodes.MISSING_REQUIRED_FIELD, "repository is required for github mode", "repository");
  }

  const action = readString(input, "action") ?? "unknown";
  const repoFullName = readString(repo, "full_name") ?? readString(repo, "name") ?? "unknown";

  // Build instructions from issue/PR body
  const issue = readRecord(input, "issue");
  const pr = readRecord(input, "pull_request");
  const subject = issue ?? pr;
  const title = subject ? (readString(subject, "title") ?? "") : "";
  const body = subject ? (readString(subject, "body") ?? "") : "";
  const number = subject ? (readNumber(subject, "number") ?? 0) : 0;

  const sender = readRecord(input, "sender");
  const senderLogin = sender ? (readString(sender, "login") ?? "unknown") : "unknown";

  // Determine intent from action
  let intent = "notify";
  if (action === "opened" || action === "created") {
    intent = "delegate";
  } else if (action === "assigned" || action === "labeled") {
    intent = "delegate";
  } else if (action === "closed" && pr) {
    intent = "notify";
  }

  const instructions = title
    ? `[${repoFullName}#${number}] ${action}: ${title}${body ? "\n\n" + body : ""}`
    : `GitHub ${action} event on ${repoFullName}`;

  return {
    ok: true,
    intent,
    instructions,
    summary: `${action} on ${repoFullName}${number ? `#${number}` : ""}`,
    target: {
      sessionKey: repoFullName,
      displayKey: repoFullName,
    },
    requester: {
      sessionKey: senderLogin,
      displayKey: senderLogin,
    },
    metadata: {
      source: "github",
      detectedMode: "github",
      originalShape: input,
    },
  };
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Normalize an incoming payload into the stable internal shape.
 * Auto-detects mode if not provided. Returns a discriminated result.
 */
export function normalizeA2APayload(input: unknown, mode?: PayloadMode): PayloadNormalizeResult {
  if (!isPlainObject(input)) {
    return fail(PayloadNormalizerErrorCodes.INVALID_PAYLOAD_SHAPE, "payload must be a non-null object");
  }

  const detectedMode = mode ?? detectPayloadMode(input);
  if (!detectedMode) {
    return fail(PayloadNormalizerErrorCodes.UNKNOWN_PAYLOAD_MODE, "cannot determine payload mode from input shape");
  }

  switch (detectedMode) {
    case "general":
      return normalizeGeneralMode(input);
    case "team-assignment":
      return normalizeTeamAssignmentMode(input);
    case "github":
      return normalizeGitHubMode(input);
    default:
      return fail(PayloadNormalizerErrorCodes.UNKNOWN_PAYLOAD_MODE, `unsupported payload mode: ${detectedMode}`);
  }
}

/**
 * Check whether a payload is compatible with the normalizer.
 * Returns mode and warnings without throwing or failing.
 */
export function validatePayloadCompatibility(input: unknown): PayloadCompatibilityResult {
  const warnings: string[] = [];

  if (!isPlainObject(input)) {
    return { compatible: false, mode: null, warnings: ["payload is not a plain object"] };
  }

  const mode = detectPayloadMode(input);
  if (!mode) {
    return { compatible: false, mode: null, warnings: ["cannot determine payload mode"] };
  }

  // Check for unknown extra fields that might indicate a newer schema
  if (mode === "team-assignment") {
    const knownKeys = new Set([
      "assignmentMode", "targetNodes", "instructions", "summary",
      "requester", "constraints", "lanes", "workMode",
    ]);
    for (const key of Object.keys(input)) {
      if (!knownKeys.has(key)) {
        warnings.push(`unknown field in team-assignment payload: ${key}`);
      }
    }
  }

  if (mode === "general") {
    if (!isPlainObject(input.request)) {
      warnings.push("general-mode payload missing request object");
    }
  }

  if (mode === "github") {
    if (!isPlainObject(input.repository)) {
      warnings.push("github-mode payload missing repository object");
    }
  }

  // Run normalize to check for errors
  const result = normalizeA2APayload(input, mode);
  if (!result.ok) {
    warnings.push(`${result.error.code}: ${result.error.message}`);
  }

  return {
    compatible: result.ok,
    mode,
    warnings,
  };
}
