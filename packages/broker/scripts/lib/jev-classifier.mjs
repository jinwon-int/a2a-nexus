// JEV probe-vs-real-work classifier facade (spec: docs/specs/jev-probe-gating/spec.md).
// Env-gated, single-attempt classification at the handler's async stdin CLI
// entry. The API key travels only via an owner-only (0600-class) keyfile and
// is read at call time; endpoint and key values are never embedded here or in
// the deterministic, value-free warning text.

import { accessSync, constants, readFileSync, statSync } from "node:fs";

export const JEV_DISABLE_TOKENS = new Set(["", "none", "null", "undefined"]);
export const JEV_TIMEOUT_DEFAULT_MS = 1500;
export const JEV_TIMEOUT_MIN_MS = 250;
export const JEV_TIMEOUT_MAX_MS = 5000;

const INVALID_CONFIG_WARNING = "jev: classification disabled (invalid-config)";

function safeText(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function validUnitInterval(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function gateEnabled(raw) {
  if (raw === undefined) return false;
  return !JEV_DISABLE_TOKENS.has(String(raw).trim().toLowerCase());
}

function absoluteHttpUrl(value) {
  const text = safeText(value, "");
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return text;
  } catch {
    return null;
  }
}

function readableOwnerOnlyFile(value) {
  const text = safeText(value, "");
  if (!text) return null;
  try {
    const stats = statSync(text);
    if (!stats.isFile()) return null;
    if ((stats.mode & 0o077) !== 0) return null;
    accessSync(text, constants.R_OK);
    return text;
  } catch {
    return null;
  }
}

export function parseJevTimeoutMs(raw) {
  const text = raw === undefined || raw === null ? "" : String(raw).trim();
  if (!text) return JEV_TIMEOUT_DEFAULT_MS;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return JEV_TIMEOUT_DEFAULT_MS;
  return Math.min(JEV_TIMEOUT_MAX_MS, Math.max(JEV_TIMEOUT_MIN_MS, parsed));
}

// Resolves the jev env contract. Returns either
// { enabled: false, reason: "gate-off" | "invalid-config", warnings } or
// { enabled: true, endpoint, keyfilePath, timeoutMs, model, warnings }.
// warnings carries at most one deterministic, value-free line.
// gateVar (G1) lets typed-shadow consumers key the same trio semantics on
// their own gate variable (e.g. A2A_JEV_RECEIPT_SHADOW) — the default stays
// the probe-gating gate so the boolean contract is untouched.
export function resolveJevConfig(env = process.env, gateVar = "A2A_JEV_CLASSIFY") {
  if (!gateEnabled(env[gateVar])) {
    return { enabled: false, reason: "gate-off", warnings: [] };
  }
  const endpoint = absoluteHttpUrl(env.A2A_JEV_ENDPOINT);
  const keyfilePath = readableOwnerOnlyFile(env.A2A_JEV_KEYFILE);
  if (endpoint === null || keyfilePath === null) {
    return {
      enabled: false,
      reason: "invalid-config",
      warnings: [INVALID_CONFIG_WARNING],
    };
  }
  return {
    enabled: true,
    endpoint,
    keyfilePath,
    timeoutMs: parseJevTimeoutMs(env.A2A_JEV_TIMEOUT_MS),
    model: safeText(env.A2A_JEV_MODEL, "") || null,
    warnings: [],
  };
}

async function defaultJevTransport({ endpoint, key, timeoutMs, payload }) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  return { status: response.status, text };
}

// Single-attempt classification. transport({endpoint,key,timeoutMs,payload})
// must resolve to {status:number, text:string}. The keyfile is read at call
// time so rotations between resolve and classify are honored. Outcomes:
// {ok:true,isRealWork:boolean} or {ok:false,reason,attempts,status?} with
// reason in disabled/invalid-task/keyfile-unreadable/timeout/
// transport-error/http-error/invalid-verdict. Never retries.
export async function classifyTaskWithJev(task, config, { transport = defaultJevTransport } = {}) {
  if (!config || config.enabled !== true) {
    return { ok: false, reason: "disabled", attempts: 0 };
  }
  const description = safeText(task?.message, safeText(task?.prompt, ""));
  if (!description) {
    return { ok: false, reason: "invalid-task", attempts: 0 };
  }
  let key = "";
  try {
    key = readFileSync(config.keyfilePath, "utf8").trim();
  } catch {
    return { ok: false, reason: "keyfile-unreadable", attempts: 0 };
  }
  if (!key) {
    return { ok: false, reason: "keyfile-unreadable", attempts: 0 };
  }
  const payload = {
    description,
    intent: safeText(task?.intent, "") || undefined,
    model: config.model || undefined,
  };
  let response;
  try {
    response = await transport({ endpoint: config.endpoint, key, timeoutMs: config.timeoutMs, payload });
  } catch (error) {
    const timedOut = Boolean(error) && (error.name === "TimeoutError" || error.name === "AbortError");
    return { ok: false, reason: timedOut ? "timeout" : "transport-error", attempts: 1 };
  }
  if (!response || typeof response.status !== "number") {
    return { ok: false, reason: "transport-error", attempts: 1 };
  }
  if (response.status < 200 || response.status > 299) {
    return { ok: false, reason: "http-error", status: response.status, attempts: 1 };
  }
  let verdict;
  try {
    verdict = JSON.parse(typeof response.text === "string" ? response.text : "");
  } catch {
    return { ok: false, reason: "invalid-verdict", attempts: 1 };
  }
  const validVerdict = verdict !== null
    && typeof verdict === "object"
    && !Array.isArray(verdict)
    && typeof verdict.is_real_work === "boolean";
  if (!validVerdict) {
    return { ok: false, reason: "invalid-verdict", attempts: 1 };
  }
  return { ok: true, isRealWork: verdict.is_real_work, attempts: 1 };
}

// ── G1 typed-verdict contract (docs/specs/jev-review-evidence-shadow/) ──
// Parallel independent questions over one shared judgment-time state string.
// Questions: [{id, type: "noul"|"choice"|"score", instructions, labels?}]
// (labels: closed choice label set, validated on the response). The wire
// payload carries only {type, instructions} per id — the labels never leave
// the process. Responses are accepted only when every requested id arrives
// with its requested type's shape; anything else invalidates the whole
// verdict (single attempt, never retried).

const TYPED_QUESTION_TYPES = new Set(["noul", "choice", "score"]);

export function normalizeTypedQuestions(questions) {
  if (!Array.isArray(questions) || questions.length === 0) {
    return { ok: false, reason: "invalid-questions" };
  }
  const wire = {};
  const seen = new Set();
  for (const question of questions) {
    if (!isPlainObject(question)) return { ok: false, reason: "invalid-questions" };
    const id = safeText(question.id);
    const type = safeText(question.type).toLowerCase();
    const instructions = safeText(question.instructions);
    if (!id || seen.has(id) || !TYPED_QUESTION_TYPES.has(type) || !instructions) {
      return { ok: false, reason: "invalid-questions" };
    }
    if (type === "choice") {
      if (
        !Array.isArray(question.labels)
        || question.labels.length === 0
        || !question.labels.every((label) => safeText(label))
      ) {
        return { ok: false, reason: "invalid-questions" };
      }
    }
    seen.add(id);
    wire[id] = { type, instructions };
  }
  return { ok: true, wire };
}

// Normalizes a System One answers object against the requested questions.
// Returns {qid: {type, probability?|label?|value?, confidence?}} or null when
// any requested answer is missing, mistyped, or out of range. confidence is
// optional on choice/score (range-checked when present) — probability and
// confidence stay separate fields and are never merged.
function normalizeTypedAnswers(questions, answers) {
  if (!isPlainObject(answers)) return null;
  const normalized = {};
  for (const question of questions) {
    const answer = answers[question.id];
    if (!isPlainObject(answer)) return null;
    if (question.type === "noul") {
      if (!validUnitInterval(answer.noul)) return null;
      normalized[question.id] = { type: "noul", probability: answer.noul };
      continue;
    }
    if (question.type === "choice") {
      if (typeof answer.choice !== "string") return null;
      if (Array.isArray(question.labels) && !question.labels.includes(answer.choice)) return null;
      const entry = { type: "choice", label: answer.choice };
      if (answer.confidence !== undefined) {
        if (!validUnitInterval(answer.confidence)) return null;
        entry.confidence = answer.confidence;
      }
      normalized[question.id] = entry;
      continue;
    }
    if (typeof answer.score !== "number" || !Number.isFinite(answer.score)) return null;
    const entry = { type: "score", value: answer.score };
    if (answer.confidence !== undefined) {
      if (!validUnitInterval(answer.confidence)) return null;
      entry.confidence = answer.confidence;
    }
    normalized[question.id] = entry;
  }
  return normalized;
}

// Single-attempt typed classification. state is the shared judgment-time
// state string assembled by the caller from closed banded fields — the
// facade never receives task bodies or source contents. Mirrors the boolean
// contract's failure discipline: config-gated, keyfile read at call time,
// one bounded attempt, no retry.
export async function classifyTypedWithJev({ config, state, questions, transport = defaultJevTransport }) {
  if (!config || config.enabled !== true) {
    return { ok: false, reason: "disabled", attempts: 0 };
  }
  const stateText = safeText(state);
  if (!stateText) {
    return { ok: false, reason: "invalid-state", attempts: 0 };
  }
  const normalizedQuestions = normalizeTypedQuestions(questions);
  if (!normalizedQuestions.ok) {
    return { ok: false, reason: normalizedQuestions.reason, attempts: 0 };
  }
  let key = "";
  try {
    key = readFileSync(config.keyfilePath, "utf8").trim();
  } catch {
    return { ok: false, reason: "keyfile-unreadable", attempts: 0 };
  }
  if (!key) {
    return { ok: false, reason: "keyfile-unreadable", attempts: 0 };
  }
  const payload = {
    state: stateText,
    questions: normalizedQuestions.wire,
    ...(config.model ? { model: config.model } : {}),
  };
  let response;
  try {
    response = await transport({ endpoint: config.endpoint, key, timeoutMs: config.timeoutMs, payload });
  } catch (error) {
    const timedOut = Boolean(error) && (error.name === "TimeoutError" || error.name === "AbortError");
    return { ok: false, reason: timedOut ? "timeout" : "transport-error", attempts: 1 };
  }
  if (!response || typeof response.status !== "number") {
    return { ok: false, reason: "transport-error", attempts: 1 };
  }
  if (response.status < 200 || response.status > 299) {
    return { ok: false, reason: "http-error", status: response.status, attempts: 1 };
  }
  let parsed;
  try {
    parsed = JSON.parse(typeof response.text === "string" ? response.text : "");
  } catch {
    return { ok: false, reason: "invalid-verdict", attempts: 1 };
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.answers)) {
    return { ok: false, reason: "invalid-verdict", attempts: 1 };
  }
  const answers = normalizeTypedAnswers(questions, parsed.answers);
  if (!answers) {
    return { ok: false, reason: "invalid-verdict", attempts: 1 };
  }
  return {
    ok: true,
    answers,
    attempts: 1,
    model: safeText(parsed.model) || undefined,
  };
}
