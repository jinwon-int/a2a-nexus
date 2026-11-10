import { readFileSync } from "node:fs";

export const ANALYSIS_EXECUTION_TELEMETRY_VERSION = "a2a.analysis-execution-telemetry.v1";

const MAX_PROGRESS_BYTES = 4 * 1024 * 1024;
const MAX_PROGRESS_EVENTS = 100_000;

/**
 * Bounded enum for `output_schema_retry` reasons (#1815 item 1): the marker
 * carries the validator's error strings, which are classified here — never
 * relayed raw — so lane telemetry stays content-free while still naming the
 * dominant failure shape (extra property / missing field / invalid value /
 * no JSON candidate at all / provider failure / other).
 */
export const SCHEMA_RETRY_REASONS = Object.freeze([
  "extra_property",
  "missing_field",
  "invalid_value",
  "no_json_candidate",
  "provider_failure",
  "other",
]);

/**
 * Classify one retry marker's error list into the bounded enum. The first
 * matching rule wins; an explicit empty error list means the model's text
 * contained no extractable JSON candidate at all (markdown/wrapper shape).
 *
 * #1815 7b: a missing or non-array `errors` field (or a list with no string
 * entries) carries no validator evidence at all, so it is `other` — it must
 * not be folded into `no_json_candidate`, which would bias the distribution.
 */
export function classifySchemaRetryErrors(errors) {
  if (!Array.isArray(errors)) return "other";
  if (errors.length === 0) return "no_json_candidate";
  const listed = errors.filter((item) => typeof item === "string");
  if (listed.length === 0) return "other";
  const text = listed.join("\n");
  // #1815 7a: provider-side failure text is matched only on lines that are not
  // validator errors. Validator errors start with a JSON-pointer path
  // ("/timeoutMs: Expected number", "/provider: must be string"); a field name
  // containing provider/timeout is a schema violation, not a provider failure.
  const nonPathText = listed.filter((line) => !line.trimStart().startsWith("/")).join("\n");
  if (/provider|request failed|rate limit|timeout/i.test(nonPathText)) return "provider_failure";
  if (/not parseable JSON/i.test(text)) return "no_json_candidate";
  // additionalProperties:false violations. Deployed-field shapes first — the
  // pinned piri's TypeBox Compile emits "must not have additional
  // properties" (verified against retained worker-host clinical-lane progress
  // files, 2026-08-16; this is the dominant #1815 content_clinical retry
  // shape). Older TypeBox said "Unexpected property/external member/property
  // key"; keep those plus the ajv-style phrasing for forward/backward cover.
  if (/must not have additional propert|additionalProperties|Unexpected (property|external member|property key)/i.test(text)) {
    return "extra_property";
  }
  // "Required property" / "Expected required property".
  if (/required property/i.test(text)) return "missing_field";
  // Value-shape violations carry a JSON path or an "Expected …" predicate
  // (enum/type/format mismatches on a named field).
  if (/^\//m.test(text) || /Expected/i.test(text)) return "invalid_value";
  // Anything else is an unclassified retry shape — still bounded.
  return "other";
}

function countSchemaRetryReasons(reasons) {
  return reasons.length > 0
    ? reasons.reduce((acc, reason) => {
      acc[reason] = (acc[reason] ?? 0) + 1;
      return acc;
    }, {})
    : undefined;
}

// #2543: only a number or a non-blank numeric string is a measurement.
// `Number()` turns null, "", false and [] into 0 (and true into 1), which
// recorded an unknown cost as a known 0 USD and let sumExecutionTelemetry
// report a partial total as if every invocation had been priced.
function finiteNonNegative(value) {
  if (typeof value !== "number" && !(typeof value === "string" && value.trim() !== "")) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function nonNegativeInteger(value) {
  const parsed = finiteNonNegative(value);
  return parsed === undefined ? undefined : Math.floor(parsed);
}

function compact(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

export function claudeExecutionTelemetry(outer) {
  if (!outer || typeof outer !== "object" || Array.isArray(outer)) return undefined;
  const usage = outer.usage && typeof outer.usage === "object" && !Array.isArray(outer.usage)
    ? outer.usage
    : {};
  const telemetry = compact({
    schemaVersion: ANALYSIS_EXECUTION_TELEMETRY_VERSION,
    source: "claude_cli_envelope",
    elapsedMs: nonNegativeInteger(outer.duration_ms),
    modelRequests: nonNegativeInteger(outer.num_turns),
    inputTokens: nonNegativeInteger(usage.input_tokens),
    outputTokens: nonNegativeInteger(usage.output_tokens),
    cacheReadInputTokens: nonNegativeInteger(usage.cache_read_input_tokens),
    cacheCreationInputTokens: nonNegativeInteger(usage.cache_creation_input_tokens),
    costUsd: finiteNonNegative(outer.total_cost_usd),
  });
  return Object.keys(telemetry).length > 2 ? telemetry : undefined;
}

export function piriExecutionTelemetry(progressPath, elapsedMs) {
  const counts = {
    progressEvents: 0,
    modelRequests: 0,
    toolCalls: 0,
    autoRetries: 0,
    schemaRetries: 0,
  };
  const schemaRetryReasons = [];
  let truncated = false;
  let usageMarker;
  try {
    const raw = readFileSync(progressPath);
    truncated = raw.byteLength > MAX_PROGRESS_BYTES;
    const text = raw.subarray(0, MAX_PROGRESS_BYTES).toString("utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      if (counts.progressEvents >= MAX_PROGRESS_EVENTS) {
        truncated = true;
        break;
      }
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      counts.progressEvents += 1;
      if (event.type === "turn_start") counts.modelRequests += 1;
      if (event.type === "tool_execution_start") counts.toolCalls += 1;
      if (event.type === "auto_retry_start") counts.autoRetries += 1;
      if (event.type === "marker" && event.marker === "output_schema_retry") {
        counts.schemaRetries += 1;
        // #1815 item 1: classify the retry reason from the validator errors
        // carried on the marker (bounded enum, content-free).
        schemaRetryReasons.push(
          classifySchemaRetryErrors(event.errors ?? event.data?.errors ?? event.payload?.errors),
        );
      }
      if (event.type === "marker" && event.marker === "usage") usageMarker = event;
    }
  } catch {
    // A missing progress file remains visible as zero observed events. The
    // bridge still reports elapsed time and the source used for accounting.
  }
  // jinwon-int/piri#14: the terminal usage marker carries the run's aggregate
  // provider usage. Its request count covers every assistant response (tool
  // loops and schema retries included), so prefer it over turn_start counting.
  const markerUsage = usageMarker
    ? compact({
        modelRequests: nonNegativeInteger(usageMarker.requests),
        inputTokens: nonNegativeInteger(usageMarker.inputTokens),
        outputTokens: nonNegativeInteger(usageMarker.outputTokens),
        cacheReadInputTokens: nonNegativeInteger(usageMarker.cacheReadTokens),
        cacheCreationInputTokens: nonNegativeInteger(usageMarker.cacheWriteTokens),
        costUsd: finiteNonNegative(usageMarker.costUsd),
      })
    : {};
  return {
    schemaVersion: ANALYSIS_EXECUTION_TELEMETRY_VERSION,
    source: "piri_progress_file",
    elapsedMs: nonNegativeInteger(elapsedMs) ?? 0,
    ...counts,
    ...(countSchemaRetryReasons(schemaRetryReasons) ? { schemaRetryReasons: countSchemaRetryReasons(schemaRetryReasons) } : {}),
    ...markerUsage,
    ...(truncated ? { truncated: true } : {}),
  };
}

/**
 * Parse exactly one `<NAME>=<json object>` record from danso stderr. The danso
 * process contract (docs/v0.md "Process contract") emits each record exactly
 * once; a missing, duplicated, or malformed record yields undefined rather than
 * a guess, so telemetry never double-counts or invents numbers.
 */
export function parseDansoStderrRecord(stderr, name) {
  const prefix = `${name}=`;
  const lines = String(stderr ?? "").split("\n").filter((line) => line.startsWith(prefix));
  if (lines.length !== 1) return undefined;
  try {
    const parsed = JSON.parse(lines[0].slice(prefix.length));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * #2295: danso reports per-run usage on stderr (`PIRI_USAGE`, Piri-compatible
 * fields) plus a body-free `DANSO_TIMING` record. danso encodes unknown cost
 * as zero for Piri schema compatibility — that is not a claim the run was free,
 * so costUsd is deliberately not carried.
 */
export function dansoExecutionTelemetry(stderr, elapsedMs) {
  const usage = parseDansoStderrRecord(stderr, "PIRI_USAGE") ?? {};
  const timing = parseDansoStderrRecord(stderr, "DANSO_TIMING") ?? {};
  return compact({
    schemaVersion: ANALYSIS_EXECUTION_TELEMETRY_VERSION,
    source: "danso_cli_usage",
    elapsedMs: nonNegativeInteger(elapsedMs) ?? 0,
    modelRequests: nonNegativeInteger(usage.requests),
    inputTokens: nonNegativeInteger(usage.inputTokens),
    outputTokens: nonNegativeInteger(usage.outputTokens),
    cacheReadInputTokens: nonNegativeInteger(usage.cacheReadTokens),
    cacheCreationInputTokens: nonNegativeInteger(usage.cacheWriteTokens),
    toolCalls: nonNegativeInteger(timing.tool_calls),
  });
}

/**
 * #2518: `codex exec --json` reports usage on each `turn.completed` event as
 * `usage: { input_tokens, cached_input_tokens, cache_write_input_tokens,
 * output_tokens, reasoning_output_tokens }` (codex-cli 0.159 exec event
 * schema). OpenAI semantics: `input_tokens` INCLUDES the cached and
 * cache-write tokens (the CLI's own `total_tokens` is input + output) and
 * `output_tokens` includes reasoning. The telemetry contract wants uncached
 * input in `inputTokens`, so the cached part moves to `cacheReadInputTokens`
 * and the cache-write part to `cacheCreationInputTokens` (the broker adds
 * that back to input). The exec stream carries no price, so costUsd is never
 * set. Tokens are omitted (not zeroed) when no usage event was seen — a
 * failed turn (`turn.failed`) carries no usage, and absence must stay
 * distinguishable from a free run.
 */
const CODEX_TOOL_ITEM_TYPES = new Set(["command_execution", "mcp_tool_call", "web_search", "file_change"]);

export function codexExecutionTelemetry(stdout, elapsedMs) {
  let turns = 0;
  let toolCalls = 0;
  let input = 0;
  let cached = 0;
  let cacheWrite = 0;
  let output = 0;
  let truncated = false;
  let events = 0;
  const text = String(stdout ?? "");
  const bounded = text.length > MAX_PROGRESS_BYTES ? text.slice(0, MAX_PROGRESS_BYTES) : text;
  if (bounded.length < text.length) truncated = true;
  for (const line of bounded.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    if (events >= MAX_PROGRESS_EVENTS) {
      truncated = true;
      break;
    }
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    events += 1;
    if (event?.type === "item.completed" && CODEX_TOOL_ITEM_TYPES.has(event?.item?.type)) toolCalls += 1;
    if (event?.type !== "turn.completed") continue;
    const usage = event.usage && typeof event.usage === "object" && !Array.isArray(event.usage) ? event.usage : null;
    if (!usage) continue;
    const turnInput = nonNegativeInteger(usage.input_tokens) ?? 0;
    const turnCached = Math.min(nonNegativeInteger(usage.cached_input_tokens) ?? 0, turnInput);
    const turnCacheWrite = Math.min(nonNegativeInteger(usage.cache_write_input_tokens) ?? 0, turnInput - turnCached);
    turns += 1;
    input += turnInput;
    cached += turnCached;
    cacheWrite += turnCacheWrite;
    output += nonNegativeInteger(usage.output_tokens) ?? 0;
  }
  return compact({
    schemaVersion: ANALYSIS_EXECUTION_TELEMETRY_VERSION,
    source: "codex_exec_jsonl",
    elapsedMs: nonNegativeInteger(elapsedMs) ?? 0,
    ...(turns > 0
      ? {
          inputTokens: input - cached - cacheWrite,
          outputTokens: output,
          cacheReadInputTokens: cached,
          cacheCreationInputTokens: cacheWrite > 0 ? cacheWrite : undefined,
        }
      : {}),
    toolCalls,
    truncated: truncated ? true : undefined,
  });
}

/**
 * #2518: Hermes keeps per-session usage in its state.db `sessions` row
 * (`input_tokens` = uncached input, plus `cache_read_tokens`,
 * `cache_write_tokens`, `output_tokens`, `api_call_count`, `tool_call_count`,
 * `estimated_cost_usd` / `actual_cost_usd` with `cost_status` in
 * actual|estimated|included|unknown). The rows are the sessions this bridge
 * run produced (one per attempt, plus compression continuations). Cost is
 * Hermes' own figure — actual when reported, else its estimate — and is
 * carried only when EVERY row has an actual or estimated status with a
 * finite amount; `included` (subscription) and `unknown` leave cost unknown
 * rather than claiming the run was free. A row without the usage columns
 * (older Hermes) contributes no tokens.
 */
export function hermesExecutionTelemetry(rows, elapsedMs) {
  const list = Array.isArray(rows) ? rows.filter((row) => row && typeof row === "object" && !Array.isArray(row)) : [];
  let tokenRows = 0;
  const sums = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, tools: 0 };
  let costTotal = 0;
  let costKnown = list.length > 0;
  for (const row of list) {
    const input = nonNegativeInteger(row.input_tokens);
    const output = nonNegativeInteger(row.output_tokens);
    if (input !== undefined || output !== undefined) tokenRows += 1;
    sums.input += input ?? 0;
    sums.output += output ?? 0;
    sums.cacheRead += nonNegativeInteger(row.cache_read_tokens) ?? 0;
    sums.cacheWrite += nonNegativeInteger(row.cache_write_tokens) ?? 0;
    sums.requests += nonNegativeInteger(row.api_call_count) ?? 0;
    sums.tools += nonNegativeInteger(row.tool_call_count) ?? 0;
    const status = typeof row.cost_status === "string" ? row.cost_status : "";
    const amount = status === "actual"
      ? finiteNonNegative(row.actual_cost_usd) ?? finiteNonNegative(row.estimated_cost_usd)
      : status === "estimated"
        ? finiteNonNegative(row.estimated_cost_usd)
        : undefined;
    if (amount === undefined) costKnown = false;
    else costTotal += amount;
  }
  return compact({
    schemaVersion: ANALYSIS_EXECUTION_TELEMETRY_VERSION,
    source: "hermes_state_db",
    elapsedMs: nonNegativeInteger(elapsedMs) ?? 0,
    ...(tokenRows > 0
      ? {
          modelRequests: sums.requests,
          inputTokens: sums.input,
          outputTokens: sums.output,
          cacheReadInputTokens: sums.cacheRead,
          cacheCreationInputTokens: sums.cacheWrite,
          toolCalls: sums.tools,
        }
      : {}),
    costUsd: costKnown && tokenRows > 0 ? costTotal : undefined,
  });
}

const SUMMABLE_TELEMETRY_FIELDS = [
  "elapsedMs",
  "modelRequests",
  "inputTokens",
  "outputTokens",
  "cacheReadInputTokens",
  "cacheCreationInputTokens",
  "progressEvents",
  "toolCalls",
  "autoRetries",
  "schemaRetries",
];

// #2545: schemaRetryReasons is a per-reason count map; merge it key by key over
// the invocations that reported it, then re-apply the bounded-enum guard.
function sumSchemaRetryReasons(present) {
  const maps = present.map((item) => item.schemaRetryReasons).filter(Boolean);
  if (maps.length === 0) return undefined;
  const merged = {};
  for (const map of maps) {
    for (const [reason, count] of Object.entries(map)) merged[reason] = (merged[reason] ?? 0) + count;
  }
  return normalizeSchemaRetryReasons(merged);
}

/**
 * #2518: one telemetry object for a lane that made several runtime
 * invocations (patch single-shot + corrective retry). Counts are summed over
 * the invocations that reported them. Cost is known only when every
 * invocation produced telemetry with a cost — an invocation without an
 * envelope (spawn error, kill) makes the sum a lower bound, so the cost is
 * left unknown instead of under-reporting a "known" figure. `null` entries
 * stand for invocations that produced no telemetry.
 */
export function sumExecutionTelemetry(items, source) {
  if (!Array.isArray(items) || items.length === 0) return undefined;
  const present = items.map((item) => normalizeAnalysisExecutionTelemetry(item)).filter(Boolean);
  if (present.length === 0) return undefined;
  const summed = {};
  for (const field of SUMMABLE_TELEMETRY_FIELDS) {
    const values = present.map((item) => item[field]).filter((value) => value !== undefined);
    if (values.length > 0) summed[field] = values.reduce((total, value) => total + value, 0);
  }
  const allCosted = present.length === items.length && present.every((item) => item.costUsd !== undefined);
  return compact({
    schemaVersion: ANALYSIS_EXECUTION_TELEMETRY_VERSION,
    source: source ?? present[0].source,
    ...summed,
    costUsd: allCosted ? present.reduce((total, item) => total + item.costUsd, 0) : undefined,
    schemaRetryReasons: sumSchemaRetryReasons(present),
    truncated: present.some((item) => item.truncated === true) ? true : undefined,
  });
}

/**
 * #2518: stderr side channel for bridges whose terminal result is assembled
 * by another process (docker runner, host patch handler): one
 * `a2a_execution_telemetry=<json>` line written by the bridge itself, never
 * by the model. The last well-formed line wins; the value is normalized.
 */
export const EXECUTION_TELEMETRY_STDERR_PREFIX = "a2a_execution_telemetry=";

export function parseExecutionTelemetryLine(stderr) {
  const lines = String(stderr ?? "").split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith(EXECUTION_TELEMETRY_STDERR_PREFIX)) continue;
    try {
      const normalized = normalizeAnalysisExecutionTelemetry(JSON.parse(line.slice(EXECUTION_TELEMETRY_STDERR_PREFIX.length)));
      if (normalized) return normalized;
    } catch {
      // keep scanning older lines
    }
  }
  return undefined;
}

/** Producer sources accepted by the normalizer (mirrored in broker task-stats). */
export const ANALYSIS_EXECUTION_TELEMETRY_SOURCES = Object.freeze([
  "claude_cli_envelope",
  "piri_progress_file",
  "danso_cli_usage",
  "codex_exec_jsonl",
  "hermes_state_db",
]);

export function normalizeAnalysisExecutionTelemetry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (value.schemaVersion !== ANALYSIS_EXECUTION_TELEMETRY_VERSION) return undefined;
  if (!ANALYSIS_EXECUTION_TELEMETRY_SOURCES.includes(value.source)) return undefined;
  return compact({
    schemaVersion: ANALYSIS_EXECUTION_TELEMETRY_VERSION,
    source: value.source,
    elapsedMs: nonNegativeInteger(value.elapsedMs),
    modelRequests: nonNegativeInteger(value.modelRequests),
    inputTokens: nonNegativeInteger(value.inputTokens),
    outputTokens: nonNegativeInteger(value.outputTokens),
    cacheReadInputTokens: nonNegativeInteger(value.cacheReadInputTokens),
    cacheCreationInputTokens: nonNegativeInteger(value.cacheCreationInputTokens),
    costUsd: finiteNonNegative(value.costUsd),
    progressEvents: nonNegativeInteger(value.progressEvents),
    toolCalls: nonNegativeInteger(value.toolCalls),
    autoRetries: nonNegativeInteger(value.autoRetries),
    schemaRetries: nonNegativeInteger(value.schemaRetries),
    schemaRetryReasons: normalizeSchemaRetryReasons(value.schemaRetryReasons),
    truncated: value.truncated === true ? true : undefined,
  });
}

/** Accept only bounded-enum keys with non-negative integer counts. */
function normalizeSchemaRetryReasons(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const allowed = new Set(SCHEMA_RETRY_REASONS);
  const entries = Object.entries(value).filter(
    ([key, count]) => allowed.has(key) && nonNegativeInteger(count) !== undefined,
  );
  return entries.length > 0
    ? Object.fromEntries(entries.map(([key, count]) => [key, nonNegativeInteger(count)]))
    : undefined;
}
