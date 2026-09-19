/**
 * A2A routing advice foundation — pure, offline, no-I/O advisory library
 * (#2196, offline foundation slice 1).
 *
 * This module answers ONE advisory question: given a versioned, closed input
 * (request text + candidate template ids + trusted host context), which of the
 * seven known routing templates could plausibly apply, and which trusted host
 * fields would the chosen template still require?
 *
 * It is ADVICE METADATA ONLY:
 *   - `advisoryOnly` is always true and `dispatchAllowed` is always false in
 *     every descriptor this module returns; nothing here dispatches, prepares,
 *     admits, or authorizes a task, elevates readiness, or selects workers.
 *   - Catalog metadata with literal capability requirements is advice, NOT
 *     readiness proof (#1597 canary and dispatcher validation stay canonical).
 *   - Trusted host context is explicit caller-owned data, never parsed from
 *     request text, and NOT authentication or permission proof.
 *
 * Purity contract: zero imports; no filesystem, network, process, or clock
 * effects; no import of the dispatcher or any provider; no module state that
 * survives a call. The template catalog is deep-frozen and owned by this
 * module; lookups return defensive copies, so caller mutation cannot change
 * future behavior. Validation errors are stable codes with generic messages —
 * they never reflect request text.
 *
 * Failure boundary: provider/timeout failures are deliberately NOT
 * representable in the output contract (there is no such reason code); they
 * belong to the later adapter result envelope. This module never sees or
 * produces model calls.
 *
 * Source contract vs live deployment: everything here is exercised offline by
 * scripts/lib/a2a-routing-advice.test.mjs. Nothing is deployed or wired into
 * live routing; see docs/specs/a2a-routing-classifier/spec.md.
 */

// ─── Versioned contract constants ───────────────────────────────────────────

/** Versioned closed input contract. */
export const ROUTING_INPUT_SCHEMA_VERSION = 'a2a.routing-input.v1';
/** Versioned closed advisory output contract. */
export const ROUTING_ADVICE_SCHEMA_VERSION = 'a2a.routing-advice.v1';
/** Immutable template catalog this module owns. */
export const ROUTING_CATALOG_VERSION = 'a2a.routing-templates.v1';
/** Routing policy version stamped on validated advice and descriptors. */
export const ROUTING_POLICY_VERSION = 'a2a.routing-policy.v1';

/** requestText bound, counted in Unicode codepoints (not bytes/UTF-16 units). */
export const MAX_REQUEST_TEXT_CODEPOINTS = 4000;
/** Any contract version string is nonblank and at most this many codepoints. */
export const MAX_VERSION_CODEPOINTS = 64;

/** Closed interaction vocabulary (trusted host context, never model-chosen). */
export const ROUTING_INTERACTIONS = Object.freeze([
  'user_request',
  'control',
  'external_event',
  'attachment',
]);

/** Closed operation vocabulary. `unspecified` is restrictive, never authorizing. */
export const ROUTING_OPERATIONS = Object.freeze([
  'new_task',
  'observe_existing',
  'resume_existing',
  'unspecified',
]);

/** Closed access vocabulary. `unspecified` never allows writes. */
export const ROUTING_ACCESS_LEVELS = Object.freeze([
  'read_only',
  'write_allowed',
  'unspecified',
]);

/** Closed decision vocabulary of the advisory output. */
export const ROUTING_DECISIONS = Object.freeze([
  'recommend',
  'not_a2a',
  'defer',
]);

/**
 * Fixed reason-code enum. Deliberately NO provider-failure/timeout code: such
 * failures are never representable as a successful advisory outcome here.
 */
export const ROUTING_REASON_CODES = Object.freeze([
  'template_match',
  'not_applicable',
  'ambiguous',
  'insufficient_context',
  'no_candidate',
  'unsupported_template',
  'uncertain',
]);

/** decision → allowed reasonCode values (anything else is invalid output). */
export const REASON_CODES_BY_DECISION = Object.freeze({
  recommend: Object.freeze(['template_match']),
  not_a2a: Object.freeze(['not_applicable']),
  defer: Object.freeze(['ambiguous', 'insufficient_context', 'no_candidate', 'unsupported_template', 'uncertain']),
});

// ─── Immutable template catalog (owned by this module) ──────────────────────

const TEMPLATES = {
  new_patch: {
    id: 'new_patch',
    operation: 'new_task',
    assignmentKind: 'patch',
    intent: 'propose_patch',
    mode: 'github-propose-patch',
    requiredHostAccess: 'write_allowed',
    mintsNewId: true,
  },
  docs_patch: {
    id: 'docs_patch',
    operation: 'new_task',
    assignmentKind: 'patch',
    intent: 'propose_patch',
    mode: 'github-propose-patch',
    requiredHostAccess: 'write_allowed',
    mintsNewId: true,
  },
  new_analysis: {
    id: 'new_analysis',
    operation: 'new_task',
    assignmentKind: 'analysis',
    intent: 'analyze',
    mode: 'analysis-only',
    requiredHostAccess: 'read_only',
    mintsNewId: true,
  },
  docs_analysis: {
    id: 'docs_analysis',
    operation: 'new_task',
    assignmentKind: 'analysis',
    intent: 'analyze',
    mode: 'analysis-only',
    requiredHostAccess: 'read_only',
    mintsNewId: true,
  },
  review_readonly: {
    id: 'review_readonly',
    operation: 'new_task',
    assignmentKind: 'analysis',
    intent: 'analyze',
    mode: 'github-verify',
    requiredHostAccess: 'read_only',
    mintsNewId: true,
  },
  // Existing-task templates carry NO assignmentKind/intent/mode and NEVER mint
  // an identifier; existing references are host-owned and never appear in
  // model output.
  observe_existing: {
    id: 'observe_existing',
    operation: 'observe_existing',
    requiredHostAccess: 'read_only',
    mintsNewId: false,
  },
  resume_existing: {
    id: 'resume_existing',
    operation: 'resume_existing',
    requiredHostAccess: 'read_only',
    mintsNewId: false,
  },
};

/** Fixed catalog order (the seven template ids). */
export const ROUTING_TEMPLATE_IDS = Object.freeze([
  'new_patch',
  'docs_patch',
  'new_analysis',
  'docs_analysis',
  'review_readonly',
  'observe_existing',
  'resume_existing',
]);

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

/** Deep-frozen catalog. Callers MUST NOT mutate it (frozen in strict mode). */
export const ROUTING_TEMPLATES = deepFreeze(TEMPLATES);

/**
 * Pinned template lookup owned by code. Returns a defensive, unfrozen copy so
 * caller-side mutation of the return value cannot change future behavior.
 */
export function getRoutingTemplate(templateId) {
  if (typeof templateId !== 'string') return null;
  const template = ROUTING_TEMPLATES[templateId];
  return template ? structuredClone(template) : null;
}

/**
 * Required-host-field metadata per template. Preserves the ACTUAL mapping:
 *  - patch fields are the literal `scripts/lib/task-assign-entrypoint.mjs`
 *    missing-field names;
 *  - analysis adds host-provided source/ownership contracts (normalization
 *    alone does NOT make an analysis assignment-ready);
 *  - review additionally needs host-provided PR/revision/workspace metadata
 *    (github-verify lane contract);
 *  - existing-task templates need host-validated existing references.
 * These are host-field NAMES only; the descriptor never invents
 * repo/source/scope/tests/ids and never copies arbitrary model fields.
 */
const REQUIRED_HOST_FIELDS = deepFreeze({
  new_patch: Object.freeze([
    'requestId',
    'objective',
    'requestRef',
    'target.repo',
    'target.declaredScope.paths',
    'target.repoTests',
  ]),
  docs_patch: Object.freeze([
    'requestId',
    'objective',
    'requestRef',
    'target.repo',
    'target.declaredScope.paths',
    'target.repoTests',
  ]),
  new_analysis: Object.freeze([
    'requestId',
    'objective',
    'requestRef',
    'host.sourceCarriers',
    'host.ownershipContracts',
  ]),
  docs_analysis: Object.freeze([
    'requestId',
    'objective',
    'requestRef',
    'host.sourceCarriers',
    'host.ownershipContracts',
  ]),
  review_readonly: Object.freeze([
    'requestId',
    'objective',
    'requestRef',
    'host.pullRequestReference',
    'host.revision',
    'host.workspaceMetadata',
  ]),
  observe_existing: Object.freeze(['existingTaskReference']),
  resume_existing: Object.freeze(['existingRequestReference']),
});

/** Descriptor invariants, exported for callers and tests. */
export const ADVISORY_ONLY = true;
export const DISPATCH_ALLOWED = false;

// ─── Structured errors (stable codes, generic messages, no text echo) ───────

export class RoutingAdviceError extends Error {
  /**
   * @param {string} code stable machine-readable code (fixed vocabulary)
   * @param {{code:string,path?:string,message:string}[]} errors batched items
   */
  constructor(code, errors) {
    super(`routing advice contract violation (${code}); see errors[] for stable codes`);
    this.name = 'RoutingAdviceError';
    this.code = code;
    this.errors = Object.freeze((errors ?? []).map((e) => Object.freeze({ ...e })));
  }
}

const MAX_PATH_KEY_CODEPOINTS = 80;

function boundKey(key) {
  const s = String(key);
  return [...s].length <= MAX_PATH_KEY_CODEPOINTS ? s : `${[...s].slice(0, MAX_PATH_KEY_CODEPOINTS).join('')}…`;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function codepointLength(s) {
  return [...s].length;
}

function isValidVersionString(s) {
  return typeof s === 'string' && s.trim().length > 0 && codepointLength(s) <= MAX_VERSION_CODEPOINTS;
}

// ─── Input validation (`a2a.routing-input.v1`) ──────────────────────────────

const INPUT_FIELDS = Object.freeze([
  'schemaVersion',
  'requestText',
  'catalogVersion',
  'candidateTemplateIds',
  'hostContext',
]);

const HOST_CONTEXT_FIELDS = Object.freeze(['interaction', 'operation', 'access']);

/**
 * Validate the versioned closed routing input. Batched structured errors;
 * never throws; error messages never reflect request text.
 *
 * @returns {{ok:true,value:object}|{ok:false,errors:object[]}}
 */
export function validateRoutingInput(input) {
  const errors = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ code: 'invalid_input_shape', path: 'input', message: 'input must be a plain object' }] };
  }

  for (const key of Object.keys(input)) {
    if (!INPUT_FIELDS.includes(key)) {
      errors.push({ code: 'unknown_field', path: `input.${boundKey(key)}`, message: 'unexpected field' });
    }
  }
  for (const field of INPUT_FIELDS) {
    if (!(field in input)) {
      errors.push({ code: 'missing_field', path: `input.${field}`, message: 'required field is missing' });
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  if (input.schemaVersion !== ROUTING_INPUT_SCHEMA_VERSION) {
    errors.push({ code: 'invalid_schema_version', path: 'input.schemaVersion', message: `schemaVersion must be exactly ${ROUTING_INPUT_SCHEMA_VERSION}` });
  }

  const text = input.requestText;
  if (typeof text !== 'string' || text.trim().length === 0) {
    errors.push({ code: 'invalid_request_text', path: 'input.requestText', message: 'requestText must be a nonblank string' });
  } else if (codepointLength(text) > MAX_REQUEST_TEXT_CODEPOINTS) {
    errors.push({ code: 'invalid_request_text', path: 'input.requestText', message: `requestText exceeds ${MAX_REQUEST_TEXT_CODEPOINTS} codepoints` });
  }

  if (input.catalogVersion !== ROUTING_CATALOG_VERSION) {
    errors.push({ code: 'invalid_catalog_version', path: 'input.catalogVersion', message: `catalogVersion must be exactly ${ROUTING_CATALOG_VERSION}` });
  }

  const candidates = input.candidateTemplateIds;
  if (!Array.isArray(candidates)) {
    errors.push({ code: 'invalid_candidate_template_ids', path: 'input.candidateTemplateIds', message: 'candidateTemplateIds must be an array of known template ids (empty allowed)' });
  } else {
    const seen = new Set();
    candidates.forEach((id, i) => {
      if (typeof id !== 'string' || !ROUTING_TEMPLATE_IDS.includes(id)) {
        errors.push({ code: 'unknown_template_id', path: `input.candidateTemplateIds[${i}]`, message: 'template id is not in the seven-template catalog' });
        return;
      }
      if (seen.has(id)) {
        errors.push({ code: 'duplicate_template_id', path: `input.candidateTemplateIds[${i}]`, message: 'candidate template ids must be unique' });
      }
      seen.add(id);
    });
  }

  const ctx = input.hostContext;
  if (!isPlainObject(ctx)) {
    errors.push({ code: 'invalid_host_context', path: 'input.hostContext', message: 'hostContext must be a plain object with exactly interaction, operation and access' });
  } else {
    for (const key of Object.keys(ctx)) {
      if (!HOST_CONTEXT_FIELDS.includes(key)) {
        errors.push({ code: 'unknown_field', path: `input.hostContext.${boundKey(key)}`, message: 'unexpected field' });
      }
    }
    for (const field of HOST_CONTEXT_FIELDS) {
      if (!(field in ctx)) {
        errors.push({ code: 'missing_field', path: `input.hostContext.${field}`, message: 'required host context field is missing' });
      }
    }
    if ('interaction' in ctx && !ROUTING_INTERACTIONS.includes(ctx.interaction)) {
      errors.push({ code: 'invalid_host_context_field', path: 'input.hostContext.interaction', message: `interaction must be one of ${ROUTING_INTERACTIONS.join('|')}` });
    }
    if ('operation' in ctx && !ROUTING_OPERATIONS.includes(ctx.operation)) {
      errors.push({ code: 'invalid_host_context_field', path: 'input.hostContext.operation', message: `operation must be one of ${ROUTING_OPERATIONS.join('|')}` });
    }
    if ('access' in ctx && !ROUTING_ACCESS_LEVELS.includes(ctx.access)) {
      errors.push({ code: 'invalid_host_context_field', path: 'input.hostContext.access', message: `access must be one of ${ROUTING_ACCESS_LEVELS.join('|')}` });
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  // Frozen normalized copy: later mutation of the caller's object cannot
  // change this validated value or any future behavior.
  const value = deepFreeze({
    schemaVersion: input.schemaVersion,
    requestText: input.requestText,
    catalogVersion: input.catalogVersion,
    candidateTemplateIds: Object.freeze([...input.candidateTemplateIds]),
    hostContext: deepFreeze({ ...input.hostContext }),
  });
  return { ok: true, value };
}

// ─── Eligibility (trusted host context gates) ───────────────────────────────

/**
 * Pure predicate: would a `recommend` of `templateId` be eligible under this
 * input's TRUSTED host context? Never consults request text (the trusted
 * context is the only restriction surface; text can never override it).
 *
 * Eligible only when ALL hold:
 *   1. interaction === 'user_request' (control/external_event/attachment
 *      events stay with the host — no recommendation projection);
 *   2. hostContext.operation equals the template operation EXACTLY
 *      (`unspecified` never matches, so it cannot authorize a new task; a
 *      known existing-task context rejects new-task recommendations even when
 *      the model is confident);
 *   3. write-capable templates require access === 'write_allowed'
 *      (read_only forbids write escalation; unspecified never allows writes).
 * Read-only templates write nothing, so any access value is acceptable.
 *
 * @returns {boolean}
 */
export function isRecommendationEligible(input, templateId) {
  const validated = validateRoutingInput(input);
  if (!validated.ok) return false;
  if (typeof templateId !== 'string') return false;
  const template = ROUTING_TEMPLATES[templateId];
  if (!template) return false;
  const ctx = validated.value.hostContext;
  if (ctx.interaction !== 'user_request') return false;
  if (ctx.operation !== template.operation) return false;
  if (template.requiredHostAccess === 'write_allowed' && ctx.access !== 'write_allowed') return false;
  if (!validated.value.candidateTemplateIds.includes(templateId)) return false;
  return true;
}

// ─── Output validation (`a2a.routing-advice.v1`) ────────────────────────────

const OUTPUT_FIELDS = Object.freeze([
  'schemaVersion',
  'decision',
  'templateId',
  'reasonCode',
  'catalogVersion',
  'modelVersion',
  'policyVersion',
]);

/**
 * Validate closed advisory output against a routing input and the caller's
 * expected model version. Structural + version consistency ONLY: the trusted
 * context gates are additionally enforced in projectRoutingAdvice (fail-closed
 * to a structured blocked descriptor, never a plan).
 *
 * @param {object} output candidate advice object
 * @param {{input:object, expectedModelVersion:string}} deps
 * @returns {{ok:true,value:object}|{ok:false,errors:object[]}}
 */
export function validateRoutingAdviceOutput(output, { input, expectedModelVersion } = {}) {
  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ code: 'invalid_input', path: 'input', message: 'a valid routing input is required' }] };
  }
  if (!isValidVersionString(expectedModelVersion)) {
    return { ok: false, errors: [{ code: 'invalid_expected_model_version', path: 'expectedModelVersion', message: `expectedModelVersion must be a nonblank string of at most ${MAX_VERSION_CODEPOINTS} codepoints` }] };
  }

  const inputResult = validateRoutingInput(input);
  if (!inputResult.ok) {
    return { ok: false, errors: inputResult.errors };
  }

  const errors = [];
  if (!isPlainObject(output)) {
    return { ok: false, errors: [{ code: 'invalid_output_shape', path: 'output', message: 'output must be a plain object' }] };
  }

  for (const key of Object.keys(output)) {
    if (!OUTPUT_FIELDS.includes(key)) {
      errors.push({ code: 'unknown_field', path: `output.${boundKey(key)}`, message: 'unexpected field (the output contract has no confidence, paths, commands, worker ids, scope or budgets)' });
    }
  }
  for (const field of OUTPUT_FIELDS) {
    if (!(field in output)) {
      errors.push({ code: 'missing_field', path: `output.${field}`, message: 'required field is missing' });
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  if (output.schemaVersion !== ROUTING_ADVICE_SCHEMA_VERSION) {
    errors.push({ code: 'invalid_schema_version', path: 'output.schemaVersion', message: `schemaVersion must be exactly ${ROUTING_ADVICE_SCHEMA_VERSION}` });
  }
  if (!ROUTING_DECISIONS.includes(output.decision)) {
    errors.push({ code: 'invalid_decision', path: 'output.decision', message: `decision must be one of ${ROUTING_DECISIONS.join('|')}` });
  }
  if (!ROUTING_REASON_CODES.includes(output.reasonCode)) {
    errors.push({ code: 'invalid_reason_code', path: 'output.reasonCode', message: `reasonCode must be one of ${ROUTING_REASON_CODES.join('|')}` });
  }
  if (ROUTING_DECISIONS.includes(output.decision) && ROUTING_REASON_CODES.includes(output.reasonCode)) {
    if (!REASON_CODES_BY_DECISION[output.decision].includes(output.reasonCode)) {
      errors.push({ code: 'decision_reason_mismatch', path: 'output.reasonCode', message: `reasonCode is not allowed for decision ${output.decision}` });
    }
  }

  if (output.templateId !== null) {
    if (typeof output.templateId !== 'string' || !ROUTING_TEMPLATE_IDS.includes(output.templateId)) {
      errors.push({ code: 'invalid_template_id', path: 'output.templateId', message: 'templateId must be null or a known template id' });
    }
  }
  if (output.decision === 'recommend') {
    if (typeof output.templateId !== 'string') {
      errors.push({ code: 'decision_template_mismatch', path: 'output.templateId', message: 'recommend requires a non-null templateId' });
    } else if (!inputResult.value.candidateTemplateIds.includes(output.templateId)) {
      // Covers the empty-candidate case too: with no candidates nothing can
      // match, so a recommend can never validate.
      errors.push({ code: 'template_not_in_candidates', path: 'output.templateId', message: 'recommend requires templateId to be one of the input candidateTemplateIds' });
    }
  } else if (ROUTING_DECISIONS.includes(output.decision) && output.templateId !== null) {
    errors.push({ code: 'decision_template_mismatch', path: 'output.templateId', message: `${output.decision} requires templateId to be null` });
  }

  if (output.catalogVersion !== inputResult.value.catalogVersion) {
    errors.push({ code: 'catalog_version_mismatch', path: 'output.catalogVersion', message: `catalogVersion must equal the input catalogVersion (${ROUTING_CATALOG_VERSION})` });
  }
  if (output.policyVersion !== ROUTING_POLICY_VERSION) {
    errors.push({ code: 'invalid_policy_version', path: 'output.policyVersion', message: `policyVersion must be exactly ${ROUTING_POLICY_VERSION}` });
  }
  if (!isValidVersionString(output.modelVersion)) {
    errors.push({ code: 'invalid_model_version', path: 'output.modelVersion', message: `modelVersion must be a nonblank string of at most ${MAX_VERSION_CODEPOINTS} codepoints` });
  } else if (output.modelVersion !== expectedModelVersion) {
    errors.push({ code: 'model_version_mismatch', path: 'output.modelVersion', message: 'modelVersion does not match the caller expectedModelVersion' });
  }

  if (errors.length > 0) return { ok: false, errors };

  const value = deepFreeze({
    schemaVersion: output.schemaVersion,
    decision: output.decision,
    templateId: output.templateId,
    reasonCode: output.reasonCode,
    catalogVersion: output.catalogVersion,
    modelVersion: output.modelVersion,
    policyVersion: output.policyVersion,
  });
  return { ok: true, value };
}

// ─── Fail-closed bounded projection ─────────────────────────────────────────

/**
 * Project VALIDATED advice to a bounded descriptor. Not a task, not a
 * manifest, not a callable action — it only names still-required host fields.
 *
 * Behavior:
 *  - re-validates input AND output first; on any validation error it throws
 *    RoutingAdviceError — invalid output is never partially projected;
 *  - decision `recommend` + eligible context → `template_descriptor` with the
 *    defensive-copied catalog template and the fixed requiredHostFields;
 *  - decision `recommend` + context-violating (unknown/bypass context, wrong
 *    interaction/operation/access) → structured `blocked` descriptor with NO
 *    template, NO required fields and NO plan for a new task;
 *  - decision `not_a2a`/`defer` → `none`: no template descriptor at all.
 *
 * Every descriptor carries `advisoryOnly: true` and `dispatchAllowed: false`.
 *
 * @param {object} input routing input (`a2a.routing-input.v1`)
 * @param {object} advice advisory output (`a2a.routing-advice.v1`)
 * @param {{expectedModelVersion:string}} options
 * @returns {object} frozen bounded descriptor
 * @throws {RoutingAdviceError} when input or advice is contract-invalid
 */
export function projectRoutingAdvice(input, advice, { expectedModelVersion } = {}) {
  const inputResult = validateRoutingInput(input);
  if (!inputResult.ok) {
    throw new RoutingAdviceError('invalid_input', inputResult.errors);
  }
  const adviceResult = validateRoutingAdviceOutput(advice, { input: inputResult.value, expectedModelVersion });
  if (!adviceResult.ok) {
    throw new RoutingAdviceError('invalid_output', adviceResult.errors);
  }

  const validatedInput = inputResult.value;
  const validatedAdvice = adviceResult.value;

  const descriptor = {
    schemaVersion: ROUTING_ADVICE_SCHEMA_VERSION,
    advisoryOnly: ADVISORY_ONLY,
    dispatchAllowed: DISPATCH_ALLOWED,
    projection: 'none',
    decision: validatedAdvice.decision,
    reasonCode: validatedAdvice.reasonCode,
    templateId: null,
    template: null,
    eligibility: null,
    requiredHostFields: Object.freeze([]),
    catalogVersion: validatedAdvice.catalogVersion,
    modelVersion: validatedAdvice.modelVersion,
    policyVersion: validatedAdvice.policyVersion,
  };

  if (validatedAdvice.decision === 'recommend') {
    const eligible = isRecommendationEligible(validatedInput, validatedAdvice.templateId);
    descriptor.eligibility = eligible ? 'eligible' : 'context_not_eligible';
    if (eligible) {
      descriptor.projection = 'template_descriptor';
      descriptor.templateId = validatedAdvice.templateId;
      descriptor.template = getRoutingTemplate(validatedAdvice.templateId);
      descriptor.requiredHostFields = Object.freeze([...REQUIRED_HOST_FIELDS[validatedAdvice.templateId]]);
    } else {
      // Unknown/bypass context: structured blocked projection, never a plan.
      descriptor.projection = 'blocked';
    }
  }

  return deepFreeze(descriptor);
}
