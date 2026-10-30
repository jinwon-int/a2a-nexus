/**
 * Lossless record-mode observation contract for bounded PR review lineages
 * (#1518 Phase 8).
 *
 * This module is pure. It validates an explicit, versioned observation and
 * projects it into the existing create/event DTOs. It does not observe task
 * completion, call the broker/store, persist dedupe state, or enable enforce
 * mode. A future adapter must compare expectedSubject with the current durable
 * record and persist the returned idempotency key/fingerprint before applying
 * a command.
 */

import {
  canonicalize,
  findingSignature,
  intentHash,
  sha256Hex,
} from "./canonical-json.js";
import type {
  FindingCategory,
  FindingDisposition,
  FindingSeverity,
  FindingV1,
  IntentContractV1,
  NewFindingJustification,
  ReviewLineageBudgetV1,
  ReviewLineageEvent,
  ReviewReceiptV1,
} from "./types.js";

export const REVIEW_LINEAGE_OBSERVATION_KIND =
  "a2a.review-lineage-observation.v1" as const;
export const REVIEW_LINEAGE_OBSERVATION_COMMAND_KIND =
  "a2a.review-lineage-observation-command.v1" as const;

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const CRITERION_PATTERN = /^[A-Z][A-Z0-9]*-[0-9]+$/;
const FINDING_ID_PATTERN = /^F-[0-9]+$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
const UTC_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const RFC3339_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const FINDING_SEVERITIES: ReadonlySet<FindingSeverity> = new Set([
  "critical",
  "major",
  "minor",
]);
const FINDING_CATEGORIES: ReadonlySet<FindingCategory> = new Set([
  "correctness",
  "security",
  "regression",
  "spec_ambiguity",
  "scope_drift",
  "style",
  "preference",
  "design",
  "other",
]);
const FINDING_DISPOSITIONS: ReadonlySet<FindingDisposition> = new Set([
  "open",
  "resolved",
  "reopened",
  "overruled_by_finalizer",
]);
const NON_BLOCKING_CATEGORIES: ReadonlySet<FindingCategory> = new Set([
  "style",
  "preference",
  "design",
]);

export type ObservationValidationCode =
  | "unexpected_field"
  | "unsupported_version"
  | "unsupported_observation"
  | "unsupported_mode"
  | "invalid_object"
  | "invalid_string"
  | "invalid_array"
  | "invalid_boolean"
  | "invalid_integer"
  | "invalid_enum"
  | "invalid_sha"
  | "invalid_hash"
  | "invalid_timestamp"
  | "duplicate_value"
  | "transition_conflict"
  | "intent_hash_mismatch"
  | "finding_signature_mismatch"
  | "binding_mismatch"
  | "issuer_mismatch"
  | "review_not_independent"
  | "subject_not_changed"
  | "idempotency_conflict";

/**
 * Errors intentionally expose only a stable code and JSON path. Input values,
 * prompts, provider output, endpoints, and credentials are never copied.
 */
export class ObservationValidationError extends Error {
  constructor(
    readonly code: ObservationValidationCode,
    readonly path: string,
  ) {
    super(`${code} at ${path}`);
  }
}

export interface ReviewLineageSubjectBindingV1 {
  intentHash: string;
  headSha: string;
  diffHash: string;
}

export interface LineageCreateObservationV1 {
  kind: "lineage_create";
  mode: "record";
  contract: IntentContractV1;
  budget: ReviewLineageBudgetV1;
}

export interface ReviewReportObservationV1 {
  kind: "review_report";
  receipt: ReviewReceiptV1;
  resolvedFindingIds: string[];
  reopenedFindingIds: string[];
  newFindings: Array<FindingV1 & {
    justification?: NewFindingJustification;
  }>;
}

export interface CorrectionGenerationObservationV1 {
  kind: "correction_generation";
  headSha: string;
  diffHash: string;
  intentHash: string;
  pathsChanged: string[];
}

export interface ReviewerReplacementObservationV1 {
  kind: "reviewer_replacement";
  reason: "infrastructure_failure" | "other";
  detail?: string;
}

export interface OperatorCancelObservationV1 {
  kind: "operator_cancel";
  detail?: string;
}

export type ReviewLineageObservationV1 =
  | LineageCreateObservationV1
  | ReviewReportObservationV1
  | CorrectionGenerationObservationV1
  | ReviewerReplacementObservationV1
  | OperatorCancelObservationV1;

export interface ReviewLineageObservationEnvelopeV1 {
  kind: typeof REVIEW_LINEAGE_OBSERVATION_KIND;
  producerId: string;
  sourceEventId: string;
  lineageId: string;
  observedAt: string;
  /**
   * Compare-and-set subject expected before applying the command.
   *
   * For create and review_report it is also the command subject. For a
   * correction_generation it is the current pre-correction subject; the
   * observation carries the next head/diff explicitly.
   */
  binding: ReviewLineageSubjectBindingV1;
  observation: ReviewLineageObservationV1;
}

export type ReviewLineageObservationCommand =
  | {
      kind: "create_lineage";
      input: {
        contract: IntentContractV1;
        budget: ReviewLineageBudgetV1;
        at: string;
        diffHash: string;
      };
    }
  | {
      kind: "record_event";
      lineageId: string;
      event: ReviewLineageEvent;
    };

export interface ProjectedReviewLineageObservation {
  kind: typeof REVIEW_LINEAGE_OBSERVATION_COMMAND_KIND;
  idempotencyKey: string;
  payloadFingerprint: string;
  lineageId: string;
  observedAt: string;
  expectedSubject: ReviewLineageSubjectBindingV1;
  command: ReviewLineageObservationCommand;
}

export interface ProjectedReviewLineageObservationBatch {
  commands: ProjectedReviewLineageObservation[];
  duplicateCount: number;
}

function fail(
  code: ObservationValidationCode,
  path: string,
): never {
  throw new ObservationValidationError(code, path);
}

function objectAt(
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_object", path);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("unexpected_field", `${path}.${key}`);
  }
}

function stringAt(
  value: unknown,
  path: string,
  options: {
    max?: number;
    pattern?: RegExp;
    code?: ObservationValidationCode;
  } = {},
): string {
  const max = options.max ?? 4096;
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > max
    || (options.pattern && !options.pattern.test(value))
  ) {
    fail(options.code ?? "invalid_string", path);
  }
  return value;
}

function optionalStringAt(
  value: unknown,
  path: string,
  max = 4096,
): string | undefined {
  return value === undefined ? undefined : stringAt(value, path, { max });
}

function arrayAt(
  value: unknown,
  path: string,
  options: { min?: number; max?: number } = {},
): unknown[] {
  if (
    !Array.isArray(value)
    || value.length < (options.min ?? 0)
    || value.length > (options.max ?? 200)
  ) {
    fail("invalid_array", path);
  }
  return value;
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail("invalid_boolean", path);
  return value;
}

function integerAt(
  value: unknown,
  path: string,
  minimum: number,
): number {
  if (!Number.isInteger(value) || (value as number) < minimum) {
    fail("invalid_integer", path);
  }
  return value as number;
}

function enumAt<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  path: string,
): T {
  if (typeof value !== "string" || !allowed.has(value as T)) {
    fail("invalid_enum", path);
  }
  return value as T;
}

function shaAt(value: unknown, path: string): string {
  return stringAt(value, path, {
    max: 40,
    pattern: SHA_PATTERN,
    code: "invalid_sha",
  });
}

function hashAt(value: unknown, path: string): string {
  return stringAt(value, path, {
    max: 71,
    pattern: HASH_PATTERN,
    code: "invalid_hash",
  });
}

function timestampAt(
  value: unknown,
  path: string,
  utcOnly: boolean,
): string {
  const timestamp = stringAt(value, path, {
    max: 40,
    pattern: utcOnly ? UTC_PATTERN : RFC3339_PATTERN,
    code: "invalid_timestamp",
  });
  if (!Number.isFinite(Date.parse(timestamp))) {
    fail("invalid_timestamp", path);
  }
  return timestamp;
}

function stringArrayAt(
  value: unknown,
  path: string,
  options: {
    min?: number;
    max?: number;
    itemMax?: number;
    pattern?: RegExp;
  } = {},
): string[] {
  const items = arrayAt(value, path, options);
  const seen = new Set<string>();
  return items.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    const text = stringAt(item, itemPath, {
      max: options.itemMax ?? 512,
      pattern: options.pattern,
    });
    if (seen.has(text)) fail("duplicate_value", itemPath);
    seen.add(text);
    return text;
  });
}

function bindingAt(
  value: unknown,
  path: string,
): ReviewLineageSubjectBindingV1 {
  const binding = objectAt(value, path);
  exactKeys(
    binding,
    new Set(["intentHash", "headSha", "diffHash"]),
    path,
  );
  return {
    intentHash: hashAt(binding.intentHash, `${path}.intentHash`),
    headSha: shaAt(binding.headSha, `${path}.headSha`),
    diffHash: hashAt(binding.diffHash, `${path}.diffHash`),
  };
}

function acceptanceCriteriaAt(
  value: unknown,
  path: string,
): IntentContractV1["acceptanceCriteria"] {
  const items = arrayAt(value, path, { min: 1, max: 100 });
  const seen = new Set<string>();
  return items.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    const criterion = objectAt(item, itemPath);
    exactKeys(criterion, new Set(["id", "text"]), itemPath);
    const id = stringAt(criterion.id, `${itemPath}.id`, {
      max: 64,
      pattern: CRITERION_PATTERN,
    });
    if (seen.has(id)) fail("duplicate_value", `${itemPath}.id`);
    seen.add(id);
    return {
      id,
      text: stringAt(criterion.text, `${itemPath}.text`),
    };
  });
}

function declaredPathsAt(
  value: unknown,
  path: string,
): IntentContractV1["declaredPaths"] {
  const declared = objectAt(value, path);
  exactKeys(declared, new Set(["allowed", "forbidden"]), path);
  const allowed = stringArrayAt(declared.allowed, `${path}.allowed`, {
    min: 1,
    itemMax: 512,
  });
  const forbidden = declared.forbidden === undefined
    ? undefined
    : stringArrayAt(declared.forbidden, `${path}.forbidden`, {
        itemMax: 512,
      });
  return forbidden === undefined ? { allowed } : { allowed, forbidden };
}

function intentContractAt(
  value: unknown,
  path: string,
): IntentContractV1 {
  const contract = objectAt(value, path);
  exactKeys(
    contract,
    new Set([
      "kind",
      "lineageId",
      "goal",
      "nonGoals",
      "invariants",
      "acceptanceCriteria",
      "declaredPaths",
      "baseSha",
      "headSha",
      "createdAt",
      "intentHash",
    ]),
    path,
  );
  if (contract.kind !== "IntentContractV1") {
    fail("invalid_enum", `${path}.kind`);
  }
  const normalized: IntentContractV1 = {
    kind: "IntentContractV1",
    lineageId: stringAt(contract.lineageId, `${path}.lineageId`, {
      max: 200,
      pattern: IDENTIFIER_PATTERN,
    }),
    goal: stringAt(contract.goal, `${path}.goal`),
    nonGoals: stringArrayAt(contract.nonGoals, `${path}.nonGoals`, {
      itemMax: 4096,
    }),
    invariants: stringArrayAt(contract.invariants, `${path}.invariants`, {
      itemMax: 4096,
    }),
    acceptanceCriteria: acceptanceCriteriaAt(
      contract.acceptanceCriteria,
      `${path}.acceptanceCriteria`,
    ),
    declaredPaths: declaredPathsAt(
      contract.declaredPaths,
      `${path}.declaredPaths`,
    ),
    baseSha: shaAt(contract.baseSha, `${path}.baseSha`),
    headSha: shaAt(contract.headSha, `${path}.headSha`),
    createdAt: timestampAt(contract.createdAt, `${path}.createdAt`, false),
    intentHash: hashAt(contract.intentHash, `${path}.intentHash`),
  };
  if (
    intentHash(normalized as unknown as Record<string, unknown>)
    !== normalized.intentHash
  ) {
    fail("intent_hash_mismatch", `${path}.intentHash`);
  }
  return normalized;
}

function budgetAt(
  value: unknown,
  path: string,
): ReviewLineageBudgetV1 {
  const budget = objectAt(value, path);
  exactKeys(
    budget,
    new Set([
      "kind",
      "maxWallClockSeconds",
      "maxCorrectionGenerations",
      "maxReviewerRuns",
      "maxReviewerReplacements",
      "repeatedFindingThreshold",
      "onExhaustion",
    ]),
    path,
  );
  if (budget.kind !== "ReviewLineageBudgetV1") {
    fail("invalid_enum", `${path}.kind`);
  }
  if (budget.onExhaustion !== "blocked_needs_operator") {
    fail("invalid_enum", `${path}.onExhaustion`);
  }
  return {
    kind: "ReviewLineageBudgetV1",
    maxWallClockSeconds: integerAt(
      budget.maxWallClockSeconds,
      `${path}.maxWallClockSeconds`,
      1,
    ),
    maxCorrectionGenerations: integerAt(
      budget.maxCorrectionGenerations,
      `${path}.maxCorrectionGenerations`,
      0,
    ),
    maxReviewerRuns: integerAt(
      budget.maxReviewerRuns,
      `${path}.maxReviewerRuns`,
      1,
    ),
    maxReviewerReplacements: integerAt(
      budget.maxReviewerReplacements,
      `${path}.maxReviewerReplacements`,
      0,
    ),
    repeatedFindingThreshold: integerAt(
      budget.repeatedFindingThreshold,
      `${path}.repeatedFindingThreshold`,
      1,
    ),
    onExhaustion: "blocked_needs_operator",
  };
}

function receiptAt(
  value: unknown,
  path: string,
): ReviewReceiptV1 {
  const receipt = objectAt(value, path);
  exactKeys(
    receipt,
    new Set([
      "kind",
      "reviewerNodeId",
      "verdict",
      "note",
      "headSha",
      "diffHash",
      "intentHash",
      "findingLedgerRef",
      "authorWorkerId",
      "submittedAt",
    ]),
    path,
  );
  if (receipt.kind !== "ReviewReceiptV1") {
    fail("invalid_enum", `${path}.kind`);
  }
  const reviewerNodeId = stringAt(
    receipt.reviewerNodeId,
    `${path}.reviewerNodeId`,
    { max: 200, pattern: IDENTIFIER_PATTERN },
  );
  const authorWorkerId = receipt.authorWorkerId === undefined
    ? undefined
    : stringAt(receipt.authorWorkerId, `${path}.authorWorkerId`, {
        max: 200,
        pattern: IDENTIFIER_PATTERN,
      });
  if (authorWorkerId === reviewerNodeId) {
    fail("review_not_independent", `${path}.authorWorkerId`);
  }
  const submittedAt = receipt.submittedAt === undefined
    ? undefined
    : timestampAt(receipt.submittedAt, `${path}.submittedAt`, false);
  return {
    kind: "ReviewReceiptV1",
    reviewerNodeId,
    verdict: enumAt(
      receipt.verdict,
      new Set<ReviewReceiptV1["verdict"]>(["pass", "fail"]),
      `${path}.verdict`,
    ),
    note: stringAt(receipt.note, `${path}.note`),
    headSha: shaAt(receipt.headSha, `${path}.headSha`),
    diffHash: hashAt(receipt.diffHash, `${path}.diffHash`),
    intentHash: hashAt(receipt.intentHash, `${path}.intentHash`),
    findingLedgerRef: stringAt(
      receipt.findingLedgerRef,
      `${path}.findingLedgerRef`,
      { max: 256, pattern: IDENTIFIER_PATTERN },
    ),
    ...(authorWorkerId === undefined ? {} : { authorWorkerId }),
    ...(submittedAt === undefined ? {} : { submittedAt }),
  };
}

/**
 * Parse one canonical Phase 8 ReviewReceiptV1 and bind its reviewer identity
 * to a trusted issuer supplied by an authenticated source boundary.
 *
 * The issuer is deliberately not read from the receipt or any sibling request
 * field. Source adapters must pass the verified signing-key owner here before
 * constructing a review_report carrier.
 */
export function parseReviewReceiptV1(
  input: unknown,
  trustedReviewerIssuerId: string,
): ReviewReceiptV1 {
  const receipt = receiptAt(input, "$receipt");
  const issuerId = stringAt(
    trustedReviewerIssuerId,
    "$trustedReviewerIssuerId",
    { max: 200, pattern: IDENTIFIER_PATTERN },
  );
  if (receipt.reviewerNodeId !== issuerId) {
    fail("issuer_mismatch", "$receipt.reviewerNodeId");
  }
  return receipt;
}

function justificationAt(
  value: unknown,
  path: string,
): NewFindingJustification {
  const justification = objectAt(value, path);
  exactKeys(justification, new Set(["kind", "detail"]), path);
  return {
    kind: enumAt(
      justification.kind,
      new Set<NewFindingJustification["kind"]>([
        "introduced_regression",
        "critical_security",
        "unavailable_evidence",
      ]),
      `${path}.kind`,
    ),
    detail: stringAt(justification.detail, `${path}.detail`),
  };
}

function findingAt(
  value: unknown,
  path: string,
): FindingV1 & { justification?: NewFindingJustification } {
  const finding = objectAt(value, path);
  exactKeys(
    finding,
    new Set([
      "findingId",
      "criterionRef",
      "evidenceRefs",
      "severity",
      "category",
      "blocking",
      "introducedAtHead",
      "firstSeenAtHead",
      "resolvedAtHead",
      "disposition",
      "signature",
      "justification",
    ]),
    path,
  );
  const category = enumAt(
    finding.category,
    FINDING_CATEGORIES,
    `${path}.category`,
  );
  const blocking = booleanAt(finding.blocking, `${path}.blocking`);
  if (blocking && NON_BLOCKING_CATEGORIES.has(category)) {
    fail("invalid_boolean", `${path}.blocking`);
  }
  const criterionRef = stringAt(
    finding.criterionRef,
    `${path}.criterionRef`,
    { max: 128 },
  );
  const evidenceRefs = stringArrayAt(
    finding.evidenceRefs,
    `${path}.evidenceRefs`,
    { min: 1, itemMax: 512 },
  );
  const signature = hashAt(finding.signature, `${path}.signature`);
  if (
    findingSignature({ criterionRef, category, evidenceRefs })
    !== signature
  ) {
    fail("finding_signature_mismatch", `${path}.signature`);
  }
  let resolvedAtHead: string | null;
  if (finding.resolvedAtHead === null) {
    resolvedAtHead = null;
  } else {
    resolvedAtHead = shaAt(
      finding.resolvedAtHead,
      `${path}.resolvedAtHead`,
    );
  }
  const justification = finding.justification === undefined
    ? undefined
    : justificationAt(finding.justification, `${path}.justification`);
  return {
    findingId: stringAt(finding.findingId, `${path}.findingId`, {
      max: 64,
      pattern: FINDING_ID_PATTERN,
    }),
    criterionRef,
    evidenceRefs,
    severity: enumAt(
      finding.severity,
      FINDING_SEVERITIES,
      `${path}.severity`,
    ),
    category,
    blocking,
    introducedAtHead: shaAt(
      finding.introducedAtHead,
      `${path}.introducedAtHead`,
    ),
    firstSeenAtHead: shaAt(
      finding.firstSeenAtHead,
      `${path}.firstSeenAtHead`,
    ),
    resolvedAtHead,
    disposition: enumAt(
      finding.disposition,
      FINDING_DISPOSITIONS,
      `${path}.disposition`,
    ),
    signature,
    ...(justification === undefined ? {} : { justification }),
  };
}

function observationAt(
  value: unknown,
  path: string,
  envelope: {
    lineageId: string;
    observedAt: string;
    binding: ReviewLineageSubjectBindingV1;
  },
): {
  observation: ReviewLineageObservationV1;
  command: ReviewLineageObservationCommand;
} {
  const observation = objectAt(value, path);
  const kind = observation.kind;

  if (kind === "lineage_create") {
    exactKeys(
      observation,
      new Set(["kind", "mode", "contract", "budget"]),
      path,
    );
    if (observation.mode !== "record") {
      fail("unsupported_mode", `${path}.mode`);
    }
    const contract = intentContractAt(
      observation.contract,
      `${path}.contract`,
    );
    const budget = budgetAt(observation.budget, `${path}.budget`);
    if (contract.lineageId !== envelope.lineageId) {
      fail("binding_mismatch", `${path}.contract.lineageId`);
    }
    if (contract.intentHash !== envelope.binding.intentHash) {
      fail("binding_mismatch", "$.binding.intentHash");
    }
    if (contract.headSha !== envelope.binding.headSha) {
      fail("binding_mismatch", "$.binding.headSha");
    }
    const normalized: LineageCreateObservationV1 = {
      kind: "lineage_create",
      mode: "record",
      contract,
      budget,
    };
    return {
      observation: normalized,
      command: {
        kind: "create_lineage",
        input: {
          contract,
          budget,
          at: envelope.observedAt,
          diffHash: envelope.binding.diffHash,
        },
      },
    };
  }

  if (kind === "review_report") {
    exactKeys(
      observation,
      new Set([
        "kind",
        "receipt",
        "resolvedFindingIds",
        "reopenedFindingIds",
        "newFindings",
      ]),
      path,
    );
    const receipt = receiptAt(observation.receipt, `${path}.receipt`);
    if (receipt.intentHash !== envelope.binding.intentHash) {
      fail("binding_mismatch", `${path}.receipt.intentHash`);
    }
    if (receipt.headSha !== envelope.binding.headSha) {
      fail("binding_mismatch", `${path}.receipt.headSha`);
    }
    if (receipt.diffHash !== envelope.binding.diffHash) {
      fail("binding_mismatch", `${path}.receipt.diffHash`);
    }
    if (receipt.findingLedgerRef !== `ledger-${envelope.lineageId}`) {
      fail("binding_mismatch", `${path}.receipt.findingLedgerRef`);
    }
    const resolvedFindingIds = stringArrayAt(
      observation.resolvedFindingIds,
      `${path}.resolvedFindingIds`,
      { pattern: FINDING_ID_PATTERN, itemMax: 64 },
    );
    const reopenedFindingIds = stringArrayAt(
      observation.reopenedFindingIds,
      `${path}.reopenedFindingIds`,
      { pattern: FINDING_ID_PATTERN, itemMax: 64 },
    );
    const resolved = new Set(resolvedFindingIds);
    for (let index = 0; index < reopenedFindingIds.length; index += 1) {
      if (resolved.has(reopenedFindingIds[index])) {
        fail(
          "transition_conflict",
          `${path}.reopenedFindingIds[${index}]`,
        );
      }
    }
    const rawFindings = arrayAt(observation.newFindings, `${path}.newFindings`, {
      max: 200,
    });
    const newFindings = rawFindings.map((item, index) =>
      findingAt(item, `${path}.newFindings[${index}]`));
    const existingTransitions = new Set([
      ...resolvedFindingIds,
      ...reopenedFindingIds,
    ]);
    const newIds = new Set<string>();
    for (let index = 0; index < newFindings.length; index += 1) {
      const id = newFindings[index].findingId;
      if (newIds.has(id)) {
        fail("duplicate_value", `${path}.newFindings[${index}].findingId`);
      }
      if (existingTransitions.has(id)) {
        fail(
          "transition_conflict",
          `${path}.newFindings[${index}].findingId`,
        );
      }
      newIds.add(id);
    }
    const normalized: ReviewReportObservationV1 = {
      kind: "review_report",
      receipt,
      resolvedFindingIds,
      reopenedFindingIds,
      newFindings,
    };
    return {
      observation: normalized,
      command: {
        kind: "record_event",
        lineageId: envelope.lineageId,
        event: {
          type: "review_report",
          at: envelope.observedAt,
          receipt,
          resolvedFindingIds,
          reopenedFindingIds,
          newFindings,
        },
      },
    };
  }

  if (kind === "correction_generation") {
    exactKeys(
      observation,
      new Set([
        "kind",
        "headSha",
        "diffHash",
        "intentHash",
        "pathsChanged",
      ]),
      path,
    );
    const headSha = shaAt(observation.headSha, `${path}.headSha`);
    const diffHash = hashAt(observation.diffHash, `${path}.diffHash`);
    const frozenIntentHash = hashAt(
      observation.intentHash,
      `${path}.intentHash`,
    );
    if (frozenIntentHash !== envelope.binding.intentHash) {
      fail("binding_mismatch", `${path}.intentHash`);
    }
    if (
      headSha === envelope.binding.headSha
      && diffHash === envelope.binding.diffHash
    ) {
      fail("subject_not_changed", path);
    }
    const pathsChanged = stringArrayAt(
      observation.pathsChanged,
      `${path}.pathsChanged`,
      { min: 1, itemMax: 512 },
    );
    const normalized: CorrectionGenerationObservationV1 = {
      kind: "correction_generation",
      headSha,
      diffHash,
      intentHash: frozenIntentHash,
      pathsChanged,
    };
    return {
      observation: normalized,
      command: {
        kind: "record_event",
        lineageId: envelope.lineageId,
        event: {
          type: "correction_generation",
          at: envelope.observedAt,
          headSha,
          diffHash,
          intentHash: frozenIntentHash,
          pathsChanged,
        },
      },
    };
  }

  if (kind === "reviewer_replacement") {
    exactKeys(observation, new Set(["kind", "reason", "detail"]), path);
    const reason = enumAt(
      observation.reason,
      new Set<ReviewerReplacementObservationV1["reason"]>([
        "infrastructure_failure",
        "other",
      ]),
      `${path}.reason`,
    );
    const detail = optionalStringAt(
      observation.detail,
      `${path}.detail`,
    );
    const normalized: ReviewerReplacementObservationV1 = {
      kind: "reviewer_replacement",
      reason,
      ...(detail === undefined ? {} : { detail }),
    };
    return {
      observation: normalized,
      command: {
        kind: "record_event",
        lineageId: envelope.lineageId,
        event: {
          type: "reviewer_replacement",
          at: envelope.observedAt,
          reason,
          ...(detail === undefined ? {} : { detail }),
        },
      },
    };
  }

  if (kind === "operator_cancel") {
    exactKeys(observation, new Set(["kind", "detail"]), path);
    const detail = optionalStringAt(
      observation.detail,
      `${path}.detail`,
    );
    const normalized: OperatorCancelObservationV1 = {
      kind: "operator_cancel",
      ...(detail === undefined ? {} : { detail }),
    };
    return {
      observation: normalized,
      command: {
        kind: "record_event",
        lineageId: envelope.lineageId,
        event: {
          type: "operator_cancel",
          at: envelope.observedAt,
          ...(detail === undefined ? {} : { detail }),
        },
      },
    };
  }

  fail("unsupported_observation", `${path}.kind`);
}

function normalizeEnvelope(
  input: unknown,
): {
  envelope: ReviewLineageObservationEnvelopeV1;
  command: ReviewLineageObservationCommand;
} {
  const envelope = objectAt(input, "$");
  exactKeys(
    envelope,
    new Set([
      "kind",
      "producerId",
      "sourceEventId",
      "lineageId",
      "observedAt",
      "binding",
      "observation",
    ]),
    "$",
  );
  if (envelope.kind !== REVIEW_LINEAGE_OBSERVATION_KIND) {
    fail("unsupported_version", "$.kind");
  }
  const producerId = stringAt(envelope.producerId, "$.producerId", {
    max: 200,
    pattern: IDENTIFIER_PATTERN,
  });
  const sourceEventId = stringAt(
    envelope.sourceEventId,
    "$.sourceEventId",
    { max: 200, pattern: IDENTIFIER_PATTERN },
  );
  const lineageId = stringAt(envelope.lineageId, "$.lineageId", {
    max: 200,
    pattern: IDENTIFIER_PATTERN,
  });
  const observedAt = timestampAt(envelope.observedAt, "$.observedAt", true);
  const binding = bindingAt(envelope.binding, "$.binding");
  const projected = observationAt(envelope.observation, "$.observation", {
    lineageId,
    observedAt,
    binding,
  });
  return {
    envelope: {
      kind: REVIEW_LINEAGE_OBSERVATION_KIND,
      producerId,
      sourceEventId,
      lineageId,
      observedAt,
      binding,
      observation: projected.observation,
    },
    command: projected.command,
  };
}

export function deriveObservationIdempotencyKey(
  producerId: string,
  sourceEventId: string,
): string {
  return `sha256:${sha256Hex(
    `review-lineage-observation/v1\0${producerId}\0${sourceEventId}`,
  )}`;
}

export function parseReviewLineageObservation(
  input: unknown,
): ProjectedReviewLineageObservation {
  const normalized = normalizeEnvelope(input);
  return {
    kind: REVIEW_LINEAGE_OBSERVATION_COMMAND_KIND,
    idempotencyKey: deriveObservationIdempotencyKey(
      normalized.envelope.producerId,
      normalized.envelope.sourceEventId,
    ),
    payloadFingerprint: `sha256:${sha256Hex(
      canonicalize(normalized.envelope),
    )}`,
    lineageId: normalized.envelope.lineageId,
    observedAt: normalized.envelope.observedAt,
    expectedSubject: { ...normalized.envelope.binding },
    command: normalized.command,
  };
}

export function parseReviewLineageObservationBatch(
  inputs: unknown[],
): ProjectedReviewLineageObservationBatch {
  if (!Array.isArray(inputs) || inputs.length > 1000) {
    fail("invalid_array", "$");
  }
  const byIdempotencyKey =
    new Map<string, ProjectedReviewLineageObservation>();
  let duplicateCount = 0;
  for (let index = 0; index < inputs.length; index += 1) {
    const projected = parseReviewLineageObservation(inputs[index]);
    const existing = byIdempotencyKey.get(projected.idempotencyKey);
    if (!existing) {
      byIdempotencyKey.set(projected.idempotencyKey, projected);
      continue;
    }
    if (existing.payloadFingerprint !== projected.payloadFingerprint) {
      fail("idempotency_conflict", `$[${index}]`);
    }
    duplicateCount += 1;
  }
  return {
    commands: [...byIdempotencyKey.values()].sort((a, b) =>
      a.idempotencyKey.localeCompare(b.idempotencyKey)),
    duplicateCount,
  };
}
