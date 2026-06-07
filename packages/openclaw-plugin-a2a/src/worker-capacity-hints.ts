/**
 * Worker capacity hint extraction (R31, plugin-a2a#347).
 *
 * Reads broker worker capability summaries from task payload metadata and
 * produces sanitized hints for A2A status responses and Terminal Brief
 * context.  Never leaks raw host data, secrets, or internal metrics.
 *
 * Parent: jinwon-int/a2a-plane#380
 * Run: a2a-r31-worker-capability-profiles-20260516T1825Z
 *
 * Hermes/Android native worker metadata (R33, plugin-a2a#452):
 * - Added `runtimeFlavor` field to distinguish termux-hermes from gateway workers.
 * - Added `gatewayRequired` field to indicate whether a full Gateway is required
 *   on-device, without implying OpenClaw Gateway ownership.
 * - Provider accepted/send evidence remains separate from operator-visible/
 *   current-session-visible/Terminal ACK evidence throughout the projection.
 * - All existing tests continue to pass with no behavior change for gateway workers.
 */

// ── Sanitized capacity hint type ─────────────────────────────

/**
 * Worker capacity status vocabulary — what the broker knows about
 * the assigned worker's ability to accept and complete tasks.
 *
 * - `healthy`: worker is responsive and within normal capacity.
 * - `stale`: worker has not been seen recently (> heartbeat timeout).
 * - `capacity_limited`: worker is overloaded, slow, or at capacity.
 * - `unknown`: no capability data available from the broker.
 */
export type WorkerCapacityStatus =
  | "healthy"
  | "stale"
  | "capacity_limited"
  | "unknown";

/**
 * Worker runtime flavor — distinguishes Hermes/Android native workers
 * from standard OpenClaw Gateway workers.
 *
 * - `gateway`: standard OpenClaw Gateway worker (default when absent).
 * - `termux-hermes`: Hermes native worker running on Android/Termux
 *    without a full OpenClaw Gateway on-device.
 * - `unknown`: runtime flavor not reported by the broker.
 */
export type WorkerRuntimeFlavor =
  | "gateway"
  | "termux-hermes"
  | "unknown";

/**
 * Sanitized worker capacity hint.  Never contains raw host data,
 * secrets, session keys, or internal metrics.
 */
export interface WorkerCapacityHint {
  /** Sanitized capacity status. */
  status: WorkerCapacityStatus;
  /** Epoch ms of last broker-reported worker activity, if available. */
  lastSeenAt?: number;
  /** Human-readable summary safe for operator display. */
  note?: string;
  /**
   * Worker runtime flavor, if reported by the broker.
   *
   * Hermes/Android native workers report `runtimeFlavor=termux-hermes`
   * and `gatewayRequired=false` to indicate they run without a full
   * OpenClaw Gateway on-device.  The flavor is extracted from the broker
   * capability payload and surfaced here so operator status projections
   * can display the correct worker type without implying Gateway ownership.
   */
  runtimeFlavor?: WorkerRuntimeFlavor;
  /**
   * Whether the worker requires a full OpenClaw Gateway on-device.
   *
   * - `false` for Hermes/Android native workers (gateway not required).
   * - `true` or `undefined` for standard Gateway workers.
   */
  gatewayRequired?: boolean;
}

// ── Raw broker payload keys we look for ──────────────────────

const CAPACITY_KEY_CANDIDATES = [
  "workerCapability",
  "workerCapacity",
  "workerCapabilities",
] as const;

const CAPACITY_STATUS_HEALTHY = new Set([
  "healthy", "live", "active", "online", "ready",
]);

const CAPACITY_STATUS_STALE = new Set([
  "stale", "offline", "dead", "lost", "unreachable",
]);

const CAPACITY_STATUS_CAPACITY_LIMITED = new Set([
  "capacity_limited", "overloaded", "slow", "at_capacity", "busy",
]);

// ── Extraction ───────────────────────────────────────────────

/**
 * Attempt to extract a sanitized WorkerCapacityHint from a broker
 * task payload or metadata record.
 *
 * The broker MAY include worker capability summaries as structured
 * objects in the task payload under keys such as "workerCapability",
 * "workerCapacity", or "workerCapabilities".  This function reads
 * those keys when present and produces a safe projection.
 *
 * When no capability data is found, returns undefined — the caller
 * should treat this as "unknown" capacity status.
 */
export function extractWorkerCapacityHint(
  source: Record<string, unknown> | undefined,
): WorkerCapacityHint | undefined {
  if (!source) {
    return undefined;
  }

  for (const key of CAPACITY_KEY_CANDIDATES) {
    const value = source[key];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const record = value as Record<string, unknown>;
    const hint = normalizeCapacityHint(record);
    if (hint) {
      return hint;
    }
  }

  // Fallback: check for worker status flat fields in the source
  const workerStatus = readStringField(source, "workerStatus");
  if (workerStatus) {
    const status = mapWorkerStatusToCapacityStatus(workerStatus);
    const lastSeenAt = readTimestampField(source, "workerLastSeenAt")
      ?? readTimestampField(source, "lastSeenAt");
    return {
      status,
      ...(lastSeenAt !== undefined ? { lastSeenAt } : {}),
      note: buildFallbackNote(status),
    };
  }

  return undefined;
}

/**
 * Extract capacity hints from a complete task record, checking both
 * the top-level payload and the nested taskInput/metadata fields.
 *
 * Prefers the payload-level capability object, then falls back to
 * nested metadata within taskInput.
 */
export function extractWorkerCapacityHintFromTask(
  payload: Record<string, unknown> | undefined,
  taskInput?: Record<string, unknown> | undefined,
): WorkerCapacityHint | undefined {
  if (payload) {
    const fromPayload = extractWorkerCapacityHint(payload);
    if (fromPayload) {
      return fromPayload;
    }
  }

  if (taskInput) {
    const fromInput = extractWorkerCapacityHint(taskInput);
    if (fromInput) {
      return fromInput;
    }
  }

  return undefined;
}

// ── Formatting ───────────────────────────────────────────────

/**
 * Build a short human-readable capacity line for use in closeout
 * reports and Terminal Brief text.  Helps closeout reports distinguish:
 *
 * - worker slow/capacity-limited
 * - task failed
 * - task stuck/no receipt
 * - profile stale/unknown
 * - Hermes native worker (termux-hermes) vs Gateway worker
 *
 * When a non-gateway runtime flavor is present, it is prefixed so
 * operator status displays can distinguish Hermes native workers
 * from Gateway workers without implying Gateway ownership.
 *
 * When gatewayRequired=false is present (Hermes native worker),
 * a "(gateway-optional)" suffix is appended to the status line.
 */
export function formatWorkerCapacityHint(
  hint: WorkerCapacityHint | undefined,
): string | undefined {
  if (!hint) {
    return undefined;
  }

  // Prefix the flavor tag when the worker is a known non-gateway runtime
  const flavorTag = hint.runtimeFlavor && hint.runtimeFlavor !== "gateway"
    ? `${hint.runtimeFlavor} `
    : "";

  // Append "gateway-optional" note for Hermes native workers
  const gatewayNote = hint.gatewayRequired === false
    ? " (gateway-optional)"
    : "";

  if (hint.status === "healthy") {
    return `${flavorTag}worker profile: healthy${gatewayNote}`;
  }

  if (hint.status === "stale") {
    const age = hint.lastSeenAt
      ? `last seen ${formatAge(hint.lastSeenAt)}`
      : "never seen";
    return `${flavorTag}worker profile: stale — ${age}${gatewayNote}`;
  }

  if (hint.status === "capacity_limited") {
    const safeNote = sanitizeNote(hint.note);
    const extra = safeNote ? ` — ${safeNote}` : "";
    return `${flavorTag}worker profile: capacity limited${extra}${gatewayNote}`;
  }

  return `${flavorTag}worker profile: unknown${gatewayNote}`;
}

/**
 * Build a compact capacity hint suitable for Terminal Brief evidence.
 */
export function buildCapacityHintEvidenceLine(
  hint: WorkerCapacityHint | undefined,
): string | undefined {
  if (!hint) {
    return undefined;
  }
  return formatWorkerCapacityHint(hint);
}

// ── Internal helpers ─────────────────────────────────────────

function normalizeCapacityHint(
  raw: Record<string, unknown>,
): WorkerCapacityHint | undefined {
  const rawStatus = readStringField(raw, "status") ?? readStringField(raw, "state");
  if (!rawStatus) {
    return undefined;
  }

  const status = normalizeCapacityStatus(rawStatus);
  const lastSeenAt = readTimestampField(raw, "lastSeenAt")
    ?? readTimestampField(raw, "lastHeartbeatAt")
    ?? readTimestampField(raw, "lastSeen");
  const note = buildSafeNote(raw);

  // Extract Hermes/Android native worker metadata from the capability payload
  const runtimeFlavor = extractRuntimeFlavor(raw);
  const gatewayRequired = extractGatewayRequired(raw);

  return {
    status,
    ...(lastSeenAt !== undefined ? { lastSeenAt } : {}),
    ...(note ? { note } : {}),
    ...(runtimeFlavor !== undefined ? { runtimeFlavor } : {}),
    ...(gatewayRequired !== undefined ? { gatewayRequired } : {}),
  };
}

function normalizeCapacityStatus(raw: string): WorkerCapacityStatus {
  const lower = raw.toLowerCase().trim();
  if (CAPACITY_STATUS_HEALTHY.has(lower)) return "healthy";
  if (CAPACITY_STATUS_CAPACITY_LIMITED.has(lower)) return "capacity_limited";
  if (CAPACITY_STATUS_STALE.has(lower)) return "stale";
  return "unknown";
}

function mapWorkerStatusToCapacityStatus(workerStatus: string): WorkerCapacityStatus {
  return normalizeCapacityStatus(workerStatus);
}

/**
 * Extract runtime flavor from a capability payload.
 *
 * Recognizes:
 * - "termux-hermes" → `termux-hermes`
 * - "gateway" or absent → `gateway`
 * - anything else → `unknown`
 *
 * Returns undefined when the field is absent, preserving backward
 * compatibility for existing gateway workers.
 */
function extractRuntimeFlavor(
  raw: Record<string, unknown>,
): WorkerRuntimeFlavor | undefined {
  const flavor = readStringField(raw, "runtimeFlavor");
  if (!flavor) {
    return undefined;
  }
  const lower = flavor.toLowerCase().trim();
  if (lower === "termux-hermes") return "termux-hermes";
  if (lower === "gateway") return "gateway";
  return "unknown";
}

/**
 * Extract gatewayRequired flag from a capability payload.
 *
 * Hermes native workers set this to `false` to indicate they run
 * without a full OpenClaw Gateway on-device.
 *
 * Accepts both native boolean and string-boolean for JSON-serialized
 * broker payloads.  Returns undefined when absent to preserve backward
 * compatibility for existing gateway workers.
 */
function extractGatewayRequired(
  raw: Record<string, unknown>,
): boolean | undefined {
  const value = raw["gatewayRequired"];
  if (typeof value === "boolean") {
    return value;
  }
  // Accept string booleans for JSON-serialized broker payloads
  if (typeof value === "string") {
    const lower = value.toLowerCase().trim();
    if (lower === "true") return true;
    if (lower === "false") return false;
  }
  return undefined;
}

function buildSafeNote(raw: Record<string, unknown>): string | undefined {
  const loadLevel = readStringField(raw, "loadLevel");
  if (loadLevel) {
    const normalized = loadLevel.toLowerCase().trim();
    if (["low", "medium", "high"].includes(normalized)) {
      return `load: ${normalized}`;
    }
  }

  const taskCapacity = readNumberField(raw, "taskCapacity");
  const activeTasks = readNumberField(raw, "activeTasks");
  if (taskCapacity !== undefined || activeTasks !== undefined) {
    const cap = taskCapacity ?? "?";
    const active = activeTasks ?? "?";
    return `tasks: ${active}/${cap}`;
  }

  return undefined;
}

function buildFallbackNote(status: WorkerCapacityStatus): string | undefined {
  switch (status) {
    case "stale":
      return "no recent heartbeat";
    case "capacity_limited":
      return "worker at or near capacity";
    default:
      return undefined;
  }
}

function sanitizeNote(note: string | undefined): string | undefined {
  if (!note) {
    return undefined;
  }
  if (/token|secret|password|key|\/home\/|\/root\/|\/tmp\/|\/var\//i.test(note)) {
    return undefined;
  }
  const compact = note.replace(/\s+/g, " ").trim();
  return compact.length > 80 ? compact.slice(0, 80) : compact;
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return undefined;
}

function readNumberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  return undefined;
}

function readTimestampField(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function formatAge(timestampMs: number): string {
  const elapsed = Date.now() - timestampMs;
  if (elapsed < 0) {
    return "just now";
  }
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 1) {
    return "moments ago";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) {
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m ago` : `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return days === 1 ? "1d ago" : `${days}d ago`;
}
