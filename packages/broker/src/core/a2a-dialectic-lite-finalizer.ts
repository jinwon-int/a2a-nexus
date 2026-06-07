import { createHash } from "node:crypto";

export const A2A_DIALECTIC_LITE_TRIGGER = "a2ad 라운드로 진행" as const;
export const A2A_DIALECTIC_LITE_DEFAULT_MODE = "ordinary_a2a_lite" as const;
export const A2A_DIALECTIC_STRONG_MODE = "explicit_strong_a2ad" as const;
export const A2A_DIALECTIC_STRONG_TRIGGER = "a2ad 로 진행" as const;
export const A2A_DIALECTIC_STRONG_TRIGGER_ALIASES = [
  A2A_DIALECTIC_STRONG_TRIGGER,
  A2A_DIALECTIC_LITE_TRIGGER,
] as const;

export const A2A_DIALECTIC_LITE_POLICY = {
  defaultRoundMode: A2A_DIALECTIC_LITE_DEFAULT_MODE,
  strongRoundMode: A2A_DIALECTIC_STRONG_MODE,
  strongTrigger: A2A_DIALECTIC_STRONG_TRIGGER,
  synthesisStatus: "candidate_not_default_winner",
  selectionRule: "compare_all_candidates_and_choose_best_evidenced_safest_simplest_viable_path",
  precedence: [
    "safety_and_approval_boundaries",
    "evidence_tests_ci_and_reproducible_validation",
    "rollback_readiness_secret_handling_and_fail_closed_behavior",
    "simplicity_cost_and_current_approval_scope",
    "dialectic_synthesis_candidate",
  ],
} as const;

export type A2ADialecticLiteCandidateSource = "dialectic_synthesis" | "ordinary_alternative";

export type A2ADialecticLiteCandidateComplexity = "low" | "medium" | "high";

export type A2ADialecticLiteRoundMode =
  | typeof A2A_DIALECTIC_LITE_DEFAULT_MODE
  | typeof A2A_DIALECTIC_STRONG_MODE;

export interface A2ADialecticLiteCandidateInput {
  id?: string;
  workerId?: string;
  summary: string;
  evidence?: string[];
  risks?: string[];
  verification?: string[];
  approvalSensitiveActions?: string[];
  complexity?: A2ADialecticLiteCandidateComplexity;
}

export interface A2ADialecticLiteFinalizerInput {
  generatedAt?: string;
  runId?: string;
  finalizer?: string;
  roundMode?: A2ADialecticLiteRoundMode;
  topic?: string;
  thesis?: string;
  thesisWorkerId?: string;
  antithesis?: string;
  antithesisWorkerId?: string;
  synthesisCandidate?: string | A2ADialecticLiteCandidateInput;
  ordinaryAlternatives?: A2ADialecticLiteCandidateInput[];
  selectedCandidateId?: string;
  selectionRationale?: string[];
  notes?: string[];
}

export interface A2ADialecticLiteCandidate extends Required<Pick<A2ADialecticLiteCandidateInput, "id" | "summary">> {
  source: A2ADialecticLiteCandidateSource;
  workerId?: string;
  evidence: string[];
  risks: string[];
  verification: string[];
  approvalSensitiveActions: string[];
  complexity: A2ADialecticLiteCandidateComplexity;
}

export type A2ADialecticLiteFinalizerCheckStatus = "pass" | "warn" | "fail";

export interface A2ADialecticLiteFinalizerCheck {
  id: string;
  status: A2ADialecticLiteFinalizerCheckStatus;
  detail: string;
}

export type A2ADialecticLiteFinalizerState =
  | "ready_for_finalizer_decision"
  | "needs_worker_attribution"
  | "needs_dialectic_synthesis_candidate"
  | "needs_ordinary_alternative_comparison"
  | "needs_selected_candidate"
  | "needs_selection_rationale";

export interface A2ADialecticLiteFinalizerPacket {
  kind: "a2a-broker.a2a-dialectic-lite.finalizer-guard.packet";
  version: 1;
  generatedAt: string;
  runId: string;
  finalizer: string;
  topic?: string;
  roundMode: A2ADialecticLiteRoundMode;
  defaultRoundMode: typeof A2A_DIALECTIC_LITE_DEFAULT_MODE;
  triggerPhrase: typeof A2A_DIALECTIC_LITE_TRIGGER;
  strongTriggerPhrase: typeof A2A_DIALECTIC_STRONG_TRIGGER;
  strongTriggerAliases: typeof A2A_DIALECTIC_STRONG_TRIGGER_ALIASES;
  policy: typeof A2A_DIALECTIC_LITE_POLICY;
  sourceOnly: true;
  grantsExecutionApproval: false;
  dialecticSynthesisIsCandidateOnly: true;
  dialecticSynthesisAutoWinner: false;
  workerAttributionRequired: true;
  thesis?: string;
  thesisWorkerId?: string;
  antithesis?: string;
  antithesisWorkerId?: string;
  candidates: A2ADialecticLiteCandidate[];
  selectedCandidateId?: string;
  selectedCandidateSource?: A2ADialecticLiteCandidateSource;
  selectionRationale: string[];
  checks: A2ADialecticLiteFinalizerCheck[];
  state: A2ADialecticLiteFinalizerState;
  blockers: string[];
  nextActions: string[];
  notes: string[];
  idempotencyKey: string;
  safety: {
    sourceOnly: true;
    grantsExecutionApproval: false;
    providerSend: false;
    terminalAckReplay: false;
    dbMutation: false;
    deployOrRestart: false;
    credentialMovement: false;
    releasePublished: false;
  };
}

export function buildA2ADialecticLiteFinalizerPacket(
  input: A2ADialecticLiteFinalizerInput = {},
): A2ADialecticLiteFinalizerPacket {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const runId = input.runId ?? "a2a-dialectic-lite-finalizer";
  const finalizer = input.finalizer ?? "broker-finalizer";
  const roundMode = normalizeRoundMode(input.roundMode);
  const synthesisCandidate = normalizeSynthesisCandidate(input.synthesisCandidate);
  const ordinaryAlternatives = (input.ordinaryAlternatives ?? [])
    .filter((candidate) => candidate.summary.trim().length > 0)
    .map((candidate, index) => normalizeCandidate(candidate, "ordinary_alternative", index + 1));
  const candidates = [
    ...(synthesisCandidate ? [synthesisCandidate] : []),
    ...ordinaryAlternatives,
  ];
  const selectedCandidate = candidates.find((candidate) => candidate.id === input.selectedCandidateId);
  const selectionRationale = compactList(input.selectionRationale);
  const checks = buildChecks({
    thesis: input.thesis,
    thesisWorkerId: input.thesisWorkerId,
    antithesis: input.antithesis,
    antithesisWorkerId: input.antithesisWorkerId,
    synthesisCandidate,
    ordinaryAlternatives,
    selectedCandidateId: input.selectedCandidateId,
    selectedCandidate,
    selectionRationale,
  });
  const state = stateForChecks(checks);
  const blockers = checks
    .filter((check) => check.status === "fail")
    .map((check) => check.detail);

  return {
    kind: "a2a-broker.a2a-dialectic-lite.finalizer-guard.packet",
    version: 1,
    generatedAt,
    runId,
    finalizer,
    topic: cleanOptional(input.topic),
    roundMode,
    defaultRoundMode: A2A_DIALECTIC_LITE_DEFAULT_MODE,
    triggerPhrase: A2A_DIALECTIC_LITE_TRIGGER,
    strongTriggerPhrase: A2A_DIALECTIC_STRONG_TRIGGER,
    strongTriggerAliases: A2A_DIALECTIC_STRONG_TRIGGER_ALIASES,
    policy: A2A_DIALECTIC_LITE_POLICY,
    sourceOnly: true,
    grantsExecutionApproval: false,
    dialecticSynthesisIsCandidateOnly: true,
    dialecticSynthesisAutoWinner: false,
    workerAttributionRequired: true,
    thesis: cleanOptional(input.thesis),
    thesisWorkerId: cleanOptional(input.thesisWorkerId),
    antithesis: cleanOptional(input.antithesis),
    antithesisWorkerId: cleanOptional(input.antithesisWorkerId),
    candidates,
    selectedCandidateId: selectedCandidate?.id,
    selectedCandidateSource: selectedCandidate?.source,
    selectionRationale,
    checks,
    state,
    blockers,
    nextActions: nextActionsForState(state),
    notes: compactList(input.notes),
    idempotencyKey: stableId("a2a-dialectic-lite-finalizer", {
      runId,
      finalizer,
      roundMode,
      topic: input.topic,
      candidates: candidates.map((candidate) => ({
        id: candidate.id,
        source: candidate.source,
        summary: candidate.summary,
      })),
      selectedCandidateId: selectedCandidate?.id,
      state,
    }),
    safety: {
      sourceOnly: true,
      grantsExecutionApproval: false,
      providerSend: false,
      terminalAckReplay: false,
      dbMutation: false,
      deployOrRestart: false,
      credentialMovement: false,
      releasePublished: false,
    },
  };
}

export function renderA2ADialecticLiteFinalizerMarkdown(
  packet: A2ADialecticLiteFinalizerPacket,
): string {
  return [
    "A2A Dialectic Lite finalizer guard",
    `Round mode: ${packet.roundMode}`,
    `Default mode: ${packet.defaultRoundMode}`,
    `Strong a2ad trigger: ${packet.strongTriggerPhrase}`,
    `Legacy trigger alias: ${packet.triggerPhrase}`,
    `State: ${packet.state}`,
    `Finalizer: ${packet.finalizer}`,
    `Topic: ${packet.topic ?? "unspecified"}`,
    "Policy: dialectic synthesis is a candidate, not a default winner.",
    "Worker attribution: every dialectic opinion and candidate must identify the worker that supplied it.",
    "Selection rule: compare dialectic synthesis against ordinary alternatives and choose the best evidenced, safest, simplest viable path.",
    "Candidates:",
    ...renderCandidates(packet.candidates, packet.selectedCandidateId),
    "Checks:",
    ...packet.checks.map((check) => `- ${check.status}: ${check.id} - ${check.detail}`),
    "Selection rationale:",
    ...(packet.selectionRationale.length
      ? packet.selectionRationale.map((rationale) => `- ${rationale}`)
      : ["- none"]),
    "Next actions:",
    ...packet.nextActions.map((action) => `- ${action}`),
    "Safety: source-only guard; does not grant execution approval and does not perform provider send, Terminal ACK/replay, DB mutation, deploy/restart, release, or credential movement.",
  ].join("\n");
}

function normalizeSynthesisCandidate(
  input: A2ADialecticLiteFinalizerInput["synthesisCandidate"],
): A2ADialecticLiteCandidate | undefined {
  if (typeof input === "string") {
    const summary = input.trim();
    if (!summary) return undefined;
    return normalizeCandidate({ id: "synthesis", summary }, "dialectic_synthesis", 1);
  }
  if (!input || !input.summary.trim()) return undefined;
  return normalizeCandidate({ id: input.id ?? "synthesis", ...input }, "dialectic_synthesis", 1);
}

function normalizeRoundMode(mode: A2ADialecticLiteFinalizerInput["roundMode"]): A2ADialecticLiteRoundMode {
  if (mode === A2A_DIALECTIC_STRONG_MODE) return A2A_DIALECTIC_STRONG_MODE;
  return A2A_DIALECTIC_LITE_DEFAULT_MODE;
}

function normalizeCandidate(
  input: A2ADialecticLiteCandidateInput,
  source: A2ADialecticLiteCandidateSource,
  ordinal: number,
): A2ADialecticLiteCandidate {
  return {
    id: input.id?.trim() || `${source}-${ordinal}`,
    source,
    workerId: cleanOptional(input.workerId),
    summary: input.summary.trim(),
    evidence: compactList(input.evidence),
    risks: compactList(input.risks),
    verification: compactList(input.verification),
    approvalSensitiveActions: compactList(input.approvalSensitiveActions),
    complexity: input.complexity ?? "medium",
  };
}

function buildChecks(args: {
  thesis: string | undefined;
  thesisWorkerId: string | undefined;
  antithesis: string | undefined;
  antithesisWorkerId: string | undefined;
  synthesisCandidate: A2ADialecticLiteCandidate | undefined;
  ordinaryAlternatives: A2ADialecticLiteCandidate[];
  selectedCandidateId: string | undefined;
  selectedCandidate: A2ADialecticLiteCandidate | undefined;
  selectionRationale: string[];
}): A2ADialecticLiteFinalizerCheck[] {
  return [
    dialecticWorkerAttributionCheck(args),
    args.synthesisCandidate
      ? {
          id: "synthesis_recorded_as_candidate",
          status: "pass",
          detail: "dialectic synthesis is present and marked as a candidate",
        }
      : {
          id: "synthesis_recorded_as_candidate",
          status: "fail",
          detail: "record a dialectic synthesis candidate before finalizer comparison",
        },
    args.ordinaryAlternatives.length > 0
      ? {
          id: "ordinary_alternative_comparison",
          status: "pass",
          detail: `${args.ordinaryAlternatives.length} ordinary alternative(s) are available for comparison`,
        }
      : {
          id: "ordinary_alternative_comparison",
          status: "fail",
          detail: "add at least one ordinary alternative so synthesis does not auto-win",
        },
    args.selectedCandidateId
      ? args.selectedCandidate
        ? {
            id: "selected_candidate_exists",
            status: "pass",
            detail: `selected candidate ${args.selectedCandidate.id} exists`,
          }
        : {
            id: "selected_candidate_exists",
            status: "fail",
            detail: `selected candidate ${args.selectedCandidateId} is not in the candidate set`,
          }
      : {
          id: "selected_candidate_exists",
          status: "fail",
          detail: "select a candidate only after comparing synthesis with ordinary alternatives",
        },
    args.selectionRationale.length > 0
      ? {
          id: "selection_rationale",
          status: "pass",
          detail: "selection rationale records why the chosen path beats the alternatives",
        }
      : {
          id: "selection_rationale",
          status: "fail",
          detail: "record why the chosen path is best evidenced, safest, and simplest",
        },
    args.selectedCandidate?.source === "dialectic_synthesis"
      ? {
          id: "synthesis_not_default_winner",
          status: "warn",
          detail: "synthesis was selected; keep the comparison rationale with the finalizer report",
        }
      : {
          id: "synthesis_not_default_winner",
          status: "pass",
          detail: "finalizer did not treat synthesis as the default winner",
        },
  ];
}

function dialecticWorkerAttributionCheck(args: {
  thesis: string | undefined;
  thesisWorkerId: string | undefined;
  antithesis: string | undefined;
  antithesisWorkerId: string | undefined;
  synthesisCandidate: A2ADialecticLiteCandidate | undefined;
  ordinaryAlternatives: A2ADialecticLiteCandidate[];
}): A2ADialecticLiteFinalizerCheck {
  const missing: string[] = [];
  if (cleanOptional(args.thesis) && !cleanOptional(args.thesisWorkerId)) missing.push("thesisWorkerId");
  if (cleanOptional(args.antithesis) && !cleanOptional(args.antithesisWorkerId)) missing.push("antithesisWorkerId");
  for (const candidate of [
    ...(args.synthesisCandidate ? [args.synthesisCandidate] : []),
    ...args.ordinaryAlternatives,
  ]) {
    if (!candidate.workerId) missing.push(`candidate:${candidate.id}.workerId`);
  }

  if (missing.length === 0) {
    return {
      id: "dialectic_worker_attribution",
      status: "pass",
      detail: "all dialectic opinions and candidates identify their worker source",
    };
  }
  return {
    id: "dialectic_worker_attribution",
    status: "fail",
    detail: `record which worker supplied each dialectic opinion: missing ${missing.join(", ")}`,
  };
}

function stateForChecks(checks: A2ADialecticLiteFinalizerCheck[]): A2ADialecticLiteFinalizerState {
  const failedIds = new Set(checks.filter((check) => check.status === "fail").map((check) => check.id));
  if (failedIds.has("dialectic_worker_attribution")) return "needs_worker_attribution";
  if (failedIds.has("synthesis_recorded_as_candidate")) return "needs_dialectic_synthesis_candidate";
  if (failedIds.has("ordinary_alternative_comparison")) return "needs_ordinary_alternative_comparison";
  if (failedIds.has("selected_candidate_exists")) return "needs_selected_candidate";
  if (failedIds.has("selection_rationale")) return "needs_selection_rationale";
  return "ready_for_finalizer_decision";
}

function nextActionsForState(state: A2ADialecticLiteFinalizerState): string[] {
  if (state === "ready_for_finalizer_decision") {
    return ["record the finalizer decision and rejected alternatives", "continue only within the current approval boundary"];
  }
  if (state === "needs_dialectic_synthesis_candidate") return ["record the synthesis candidate as a candidate, not as a decision"];
  if (state === "needs_ordinary_alternative_comparison") return ["add at least one ordinary alternative before selecting a final path"];
  if (state === "needs_selected_candidate") return ["select one candidate after comparison"];
  if (state === "needs_worker_attribution") return ["record the worker id for every thesis, antithesis, synthesis, and alternative opinion"];
  return ["record why the selected path beats the alternatives on evidence, safety, simplicity, and approval scope"];
}

function renderCandidates(
  candidates: A2ADialecticLiteCandidate[],
  selectedCandidateId: string | undefined,
): string[] {
  if (candidates.length === 0) return ["- none"];
  return candidates.map((candidate) => {
    const selected = candidate.id === selectedCandidateId ? " selected" : "";
    const worker = candidate.workerId ? ` worker=${candidate.workerId}` : " worker=missing";
    return `- ${candidate.id} [${candidate.source}${selected}${worker}]: ${candidate.summary}`;
  });
}

function compactList(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}

function cleanOptional(value: string | undefined): string | undefined {
  const clean = value?.trim();
  return clean ? clean : undefined;
}

function stableId(prefix: string, value: unknown): string {
  const json = JSON.stringify(value);
  const digest = createHash("sha256").update(json).digest("hex").slice(0, 16);
  return `${prefix}:${digest}`;
}
