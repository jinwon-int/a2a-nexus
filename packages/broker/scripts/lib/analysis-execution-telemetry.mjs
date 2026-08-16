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
 * matching rule wins; an empty error list means the model's text contained no
 * extractable JSON candidate at all (markdown/wrapper shape).
 */
export function classifySchemaRetryErrors(errors) {
  const listed = Array.isArray(errors) ? errors.filter((item) => typeof item === "string") : [];
  if (listed.length === 0) return "no_json_candidate";
  const text = listed.join("\n");
  if (/provider|request failed|rate limit|timeout/i.test(text)) return "provider_failure";
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

function finiteNonNegative(value) {
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

export function normalizeAnalysisExecutionTelemetry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (value.schemaVersion !== ANALYSIS_EXECUTION_TELEMETRY_VERSION) return undefined;
  if (!["claude_cli_envelope", "piri_progress_file"].includes(value.source)) return undefined;
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
