// a2a-routing-assignment-forms — thin, OFFLINE, default-off conversion layer
// (#2196 slice 4): bounded frozen routing descriptors -> request drafts the
// existing task-assign entrypoints already accept.
//
// Boundary (spec: docs/specs/a2a-routing-classifier/spec.md, "Assignment
// forms slice"):
//  - NOT a dispatcher, NOT a submit path, NOT a journal or readiness
//    collector; no submit call exists in this module;
//  - mode 'offline' is fixed; zero POST by construction — the only
//    connectivity an entrypoint can perform behind this layer is its own
//    GET-only readback, and only when the host explicitly supplies fetchImpl;
//  - host.* values are presence-checked CONTEXT ONLY: never copied into a
//    draft, never fabricated, never echoed into failures;
//  - passing the host eligibility gate is NOT authorization to dispatch —
//    the host remains the sole authority.

import { ROUTING_ADVICE_SCHEMA_VERSION } from './a2a-routing-advice.mjs';
import { prepareAssignment, resumeAssignment } from './task-assign-entrypoint.mjs';

export const ROUTING_FORMS_VERSION = 'a2a.routing-forms.v1';

// Local mirrors of entrypoint internals that are not exported.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SECRET_FIELD_PATTERN = /secret|token|password|authorization|credential/i;

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** Closed failure shape; arrays frozen, field NAMES only, never values. */
function frozenFailure(reasonCodes, missingFields, invalidFields) {
  return Object.freeze({
    ok: false,
    reasonCodes: Object.freeze([...reasonCodes]),
    missingFields: Object.freeze([...missingFields]),
    invalidFields: Object.freeze([...invalidFields]),
  });
}

/** Resolve a dotted path against the trusted host context (own properties only). */
function resolveDotted(root, path) {
  let cursor = root;
  for (const segment of String(path).split('.')) {
    if (!isPlainObject(cursor) || !Object.hasOwn(cursor, segment)) {
      return { present: false, value: undefined };
    }
    cursor = cursor[segment];
  }
  return { present: true, value: cursor };
}

/** Missing-or-empty semantics: nullish, blank strings, and empty arrays. */
function isEmptyValue(value) {
  if (value == null) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function isExistingReferenceTemplate(template) {
  return isPlainObject(template) && template.mintsNewId === false && !hasText(template.assignmentKind);
}

/**
 * Pure, synchronous descriptor -> request-draft conversion. No entrypoint
 * call, no clock, no module state, no mutation of either input.
 *
 * Returns EXACTLY `{ ok: true, request }` or
 * `{ ok: false, reasonCodes, missingFields, invalidFields }` (closed shape,
 * all arrays frozen). The draft uses only the #2187 request vocabulary:
 * requestId, kind (from the template's assignmentKind), objective, requestRef,
 * patch-only target.repo / target.declaredScope.paths / target.repoTests, and
 * an unchanged host-supplied `lanes` passthrough (entrypoint lane rules —
 * including kind_lane_mismatch — stay authoritative).
 */
export function buildAssignmentRequest(descriptor, hostContext) {
  if (
    !isPlainObject(descriptor)
    || descriptor.schemaVersion !== ROUTING_ADVICE_SCHEMA_VERSION
    || descriptor.advisoryOnly !== true
    || descriptor.dispatchAllowed !== false
    || !hasText(descriptor.projection)
    || !hasText(descriptor.templateId)
    || !Array.isArray(descriptor.requiredHostFields)
    || descriptor.requiredHostFields.length === 0
    || descriptor.requiredHostFields.some((name) => !hasText(name))
  ) {
    return frozenFailure(['invalid_descriptor'], [], []);
  }
  if (descriptor.projection !== 'template_descriptor') {
    // `none` / `blocked` projections are simply not convertible — never a
    // synthesized plan.
    return frozenFailure(['projection_not_convertible'], [], []);
  }
  if (!isPlainObject(descriptor.template)) {
    return frozenFailure(['invalid_descriptor'], [], []);
  }

  // Trusted-context gate: broker/secret-shaped keys fail closed BEFORE any
  // draft is built. Unknown keys are dropped, never propagated.
  if (isPlainObject(hostContext)) {
    const offending = Object.keys(hostContext).filter(
      (key) => key === 'brokerUrl' || SECRET_FIELD_PATTERN.test(key),
    );
    if (offending.length > 0) {
      return frozenFailure(
        ['untrusted_broker_or_secret_input'],
        [],
        offending.map((key) => `request.${key}`),
      );
    }
  }

  const requiredFields = [...descriptor.requiredHostFields];
  const existingTemplate = isExistingReferenceTemplate(descriptor.template);
  const referenceField = existingTemplate
    ? requiredFields.find((name) => name === 'existingTaskReference' || name === 'existingRequestReference')
    : undefined;
  if (existingTemplate && referenceField === undefined) {
    return frozenFailure(['invalid_descriptor'], [], []);
  }

  // Dotted required-field resolution against the host context: exact field
  // names on failure; host.* names are presence-checked only.
  const missingFields = [];
  const scope = isPlainObject(hostContext) ? hostContext : {};
  for (const name of requiredFields) {
    const { present, value } = resolveDotted(scope, name);
    if (!present || isEmptyValue(value)) missingFields.push(name);
  }
  if (missingFields.length > 0) {
    return frozenFailure(
      [existingTemplate ? 'existing_reference_missing' : 'missing_required_fields'],
      missingFields,
      [],
    );
  }

  const referenceValue = existingTemplate ? resolveDotted(scope, referenceField).value : undefined;
  if (existingTemplate && !(typeof referenceValue === 'string' && REQUEST_ID_PATTERN.test(referenceValue))) {
    return frozenFailure(['invalid_existing_reference'], [], ['request.requestId']);
  }

  const request = {};
  request.requestId = existingTemplate ? referenceValue : resolveDotted(scope, 'requestId').value;
  if (hasText(descriptor.template.assignmentKind)) {
    request.kind = descriptor.template.assignmentKind;
  }
  if (requiredFields.includes('objective')) {
    request.objective = resolveDotted(scope, 'objective').value;
  }
  if (requiredFields.includes('requestRef')) {
    request.requestRef = resolveDotted(scope, 'requestRef').value;
  }
  if (requiredFields.includes('target.repo')) {
    request.target = {
      repo: resolveDotted(scope, 'target.repo').value,
      declaredScope: { paths: resolveDotted(scope, 'target.declaredScope.paths').value },
      repoTests: resolveDotted(scope, 'target.repoTests').value,
    };
  }
  if (isPlainObject(hostContext) && Object.hasOwn(hostContext, 'lanes')) {
    request.lanes = hostContext.lanes;
  }
  return Object.freeze({ ok: true, request });
}

/** Default-off guard: any accidental entrypoint connectivity fails loudly. */
function throwingFetchGuard() {
  throw new Error('a2a-routing-assignment-forms: no fetchImpl was provided by the host');
}

/**
 * Offline-fixed prepare wrapper. There is NO mode parameter: `mode: 'offline'`
 * is fixed, live readiness collection is unreachable from this layer, and
 * receipts from the delegated entrypoints are returned unmodified. When the
 * host supplies no fetchImpl, a throwing guard is passed instead so any
 * accidental readback attempt fails loudly and observably.
 */
export async function prepareRoutingAssignment({
  descriptor,
  hostContext,
  context,
  readiness,
  journal,
  fetchImpl,
  secret,
  now,
  ttlMs,
} = {}) {
  const built = buildAssignmentRequest(descriptor, hostContext);
  if (!built.ok) return built;

  const effectiveFetch = typeof fetchImpl === 'function' ? fetchImpl : throwingFetchGuard;
  if (isExistingReferenceTemplate(descriptor.template)) {
    // Journal-lookup-first existing-reference resolution through the
    // existing resumeAssignment entrypoint (zero POST on every path).
    if (!journal) return frozenFailure(['journal_missing'], ['journal'], []);
    return resumeAssignment({
      requestId: built.request.requestId,
      journal,
      context,
      fetchImpl: effectiveFetch,
      secret,
      ...(now === undefined ? {} : { now }),
    });
  }
  return prepareAssignment({
    request: built.request,
    mode: 'offline',
    context,
    readiness,
    journal,
    fetchImpl: effectiveFetch,
    secret,
    ...(now === undefined ? {} : { now }),
    ...(ttlMs === undefined ? {} : { ttlMs }),
  });
}
