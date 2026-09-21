// JEV probe-observation inputs (fixes #2219: the A2A_JEV_CLASSIFY observation
// previously posted a {description, intent} payload that matches no deployed
// jev contract — the live /v1/systemone contract requires {state, model,
// questions}). Spec: docs/specs/jev-probe-gating/spec.md; privacy rules mirror
// docs/specs/jev-review-evidence-shadow/ — the task body, prompt, source
// contents, and free text never enter the state string. Everything here is a
// closed band or token derived from judgment-time fields.

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function safeToken(value, fallback = "unknown") {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-z0-9_.-]{1,40}$/.test(text) ? text : fallback;
}

function countBand(value) {
  const n = typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  if (n === 0) return "0";
  if (n <= 3) return "1-3";
  if (n <= 10) return "4-10";
  if (n <= 50) return "11-50";
  return "50+";
}

// Same word bands as the probe-classification corpus
// (docs/specs/jev-probe-classification-corpus/): the count is derived from the
// message locally — the message text itself never leaves the process.
function wordsBand(text) {
  const words = typeof text === "string" ? text.trim().split(/\s+/).filter(Boolean).length : 0;
  if (words === 0) return "0-3";
  if (words <= 3) return "0-3";
  if (words <= 20) return "4-20";
  if (words <= 100) return "21-100";
  return "100+";
}

function stateString(record) {
  return Object.entries(record).map(([key, value]) => `${key}=${value}`).join(" ");
}

// Closed banded judgment-time inputs for the probe-observation question.
// Undefined when the task carries no usable judgment-time surface.
export function probeObservationInputs(task) {
  if (!isPlainObject(task)) return undefined;
  const payload = isPlainObject(task.payload) ? task.payload : {};
  const artifactCount = Array.isArray(task.artifactIds) ? task.artifactIds.length : 0;
  return {
    point: "probe",
    intent: safeToken(task.intent),
    artifact_ids: countBand(artifactCount),
    payload_keys: countBand(Object.keys(payload).length),
    payload_present: Object.keys(payload).length > 0 ? "yes" : "no",
    words_band: wordsBand(task.message),
    requester: safeToken(task?.requester?.id),
    requester_kind: safeToken(task?.requester?.kind),
  };
}

// Single typed observation question: a noul probability that this task is a
// pipeline health-check probe. The class definition is fixed text — no task
// content is embedded.
export function probeObservationQuestions() {
  return [
    {
      id: "is_probe",
      type: "noul",
      instructions:
        "This A2A analyze task looks like a pipeline health-check probe: a single short word or known "
        + "health-check phrasing (probe, check, ping), no indexed artifact targets, no attached evidence, "
        + "and a requester from the pipeline infrastructure itself. Probability that this task is such a probe.",
    },
  ];
}

export function probeObservationState(task) {
  const inputs = probeObservationInputs(task);
  return inputs ? stateString(inputs) : "";
}
