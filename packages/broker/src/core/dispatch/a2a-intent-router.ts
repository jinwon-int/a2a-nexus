export type A2AExecutionContext = "none" | "a2a_required";
export type A2AIntentMode = "none" | "a2a" | "a2ad";
export type A2ATeamScope = "team1" | "team2" | "cross-team";

export interface A2AIntentRouterInput {
  text?: string;
  message?: string;
  title?: string;
  body?: string;
  intent?: string;
  mode?: string;
  roundMode?: string;
  teamScope?: string;
  requestedTeamScope?: string;
  finalizer?: string;
}

export interface A2AIntentRouterResult {
  executionContext: A2AExecutionContext;
  mode: A2AIntentMode;
  directExecutionAllowed: boolean;
  requiresWorkerEvidence: boolean;
  requiresFinalizer: boolean;
  teamScope?: A2ATeamScope;
  confidence: "none" | "medium" | "high";
  reasons: string[];
}

const A2AD_EXPLICIT_PATTERNS: RegExp[] = [
  /\ba2ad\b/i,
  /strong\s+dialectic/i,
  /강한\s*변증/i,
  /스트롱\s*다이얼렉틱/i,
];

const A2A_EXPLICIT_PATTERNS: RegExp[] = [
  /\ba2a\b/i,
  /a2a\s*(로|으로|통해서|통해|lane|round|라운드|진행|처리|돌려|태워)/i,
  /(로|으로|통해서|통해)\s*a2a/i,
  /a2a나\s*a2ad/i,
];

const WORKER_EXECUTION_PATTERNS: RegExp[] = [
  /worker(?:s)?\s*(round|lane|evidence|dispatch|한테|에게|들한테|들)/i,
  /워커(들)?(한테|에게|로|들한테)?\s*(맡겨|보내|돌려|붙여|검토|진행)/i,
  /(worker(?:s)?|워커(들)?).*?(맡겨|assign|dispatch|round|evidence|검토|진행)/i,
];

const FINALIZER_PATTERNS: RegExp[] = [
  /\bfinalizer\b/i,
  /파이널라이저/i,
  /최종\s*판단/i,
  /finalizer\s*(decision|판단|closeout|결정)/i,
];

const TEAM1_PATTERNS: RegExp[] = [/\bteam\s*1\b/i, /\bT1\b/, /1\s*팀/];
const TEAM2_PATTERNS: RegExp[] = [/\bteam\s*2\b/i, /\bT2\b/, /2\s*팀/];

const NEGATIVE_CONTEXT_PATTERNS: RegExp[] = [
  /https?:\/\/\S*a2a\S*/i,
  /`[^`]*\ba2a\b[^`]*`/i,
  /\bfile\s+named\s+.*a2a/i,
  /\burl\s+.*a2a/i,
  /문서\s*(안|내).*a2a\s*(문자열|단어)/i,
];

export function routeA2AIntent(input: string | A2AIntentRouterInput): A2AIntentRouterResult {
  const normalized = normalizeInput(input);
  const text = normalized.text;
  const reasons: string[] = [];

  const explicitA2AD = matchesAny(text, A2AD_EXPLICIT_PATTERNS);
  const explicitA2A = matchesAny(text, A2A_EXPLICIT_PATTERNS) || normalized.intent?.startsWith("a2a.");
  const workerExecution = matchesAny(text, WORKER_EXECUTION_PATTERNS);
  const finalizer = matchesAny(text, FINALIZER_PATTERNS) || Boolean(normalized.finalizer);
  const teamScope = detectTeamScope(text, normalized.teamScope ?? normalized.requestedTeamScope);
  const modeField = cleanToken(normalized.mode ?? normalized.roundMode);
  const modeFromField = modeField === "explicit_strong_a2ad" ? "a2ad" : modeField === "ordinary_a2a_lite" ? "a2a" : undefined;

  if (explicitA2AD) reasons.push("explicit-a2ad");
  if (explicitA2A) reasons.push("explicit-a2a");
  if (workerExecution) reasons.push("worker-execution");
  if (finalizer) reasons.push("finalizer");
  if (teamScope) reasons.push(`team-scope:${teamScope}`);
  if (modeFromField) reasons.push(`round-mode:${modeFromField}`);

  const referenceOnly = matchesAny(text, NEGATIVE_CONTEXT_PATTERNS) &&
    !modeFromField &&
    !explicitA2AD &&
    !workerExecution &&
    !finalizer &&
    !(teamScope && hasExecutionVerb(text)) &&
    !hasExecutionVerb(text);
  const requiresA2A = Boolean(
    explicitA2AD ||
      explicitA2A ||
      modeFromField ||
      workerExecution ||
      finalizer ||
      (teamScope && hasExecutionVerb(text))
  );

  if (!requiresA2A || referenceOnly) {
    return {
      executionContext: "none",
      mode: "none",
      directExecutionAllowed: true,
      requiresWorkerEvidence: false,
      requiresFinalizer: false,
      teamScope,
      confidence: "none",
      reasons: referenceOnly ? ["reference-context-only"] : [],
    };
  }

  const mode: A2AIntentMode = explicitA2AD || modeFromField === "a2ad" ? "a2ad" : "a2a";
  return {
    executionContext: "a2a_required",
    mode,
    directExecutionAllowed: false,
    requiresWorkerEvidence: true,
    requiresFinalizer: true,
    teamScope,
    confidence: explicitA2AD || explicitA2A || modeFromField ? "high" : "medium",
    reasons,
  };
}

function normalizeInput(input: string | A2AIntentRouterInput): Required<Pick<A2AIntentRouterInput, "text">> & A2AIntentRouterInput {
  if (typeof input === "string") return { text: input };
  const parts = [input.text, input.message, input.title, input.body, input.intent, input.mode, input.roundMode]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0);
  return { ...input, text: parts.join("\n") };
}

function detectTeamScope(text: string, explicit?: string): A2ATeamScope | undefined {
  const token = cleanToken(explicit)?.toLowerCase().replace(/\s+/g, "");
  if (token === "team1" || token === "t1" || token === "1팀" || token === "1") return "team1";
  if (token === "team2" || token === "t2" || token === "2팀" || token === "2") return "team2";
  if (token === "cross-team" || token === "crossteam" || token === "team1+team2" || token === "1팀+2팀") return "cross-team";

  const hasTeam1 = matchesAny(text, TEAM1_PATTERNS);
  const hasTeam2 = matchesAny(text, TEAM2_PATTERNS);
  if (hasTeam1 && hasTeam2) return "cross-team";
  if (hasTeam1) return "team1";
  if (hasTeam2) return "team2";
  return undefined;
}

function hasExecutionVerb(text: string): boolean {
  return /(진행|처리|맡겨|붙여|돌려|검토|판단|dispatch|assign|run|review|finalize|finalise)/i.test(text);
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function cleanToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
