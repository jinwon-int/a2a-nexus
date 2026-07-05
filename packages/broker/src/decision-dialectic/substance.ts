import type {
  DecisionDialecticAntithesisV1,
  DecisionDialecticRebuttalV1,
  DecisionDialecticSubstanceWarningV1,
  DecisionDialecticTaskV1,
  DecisionDialecticThesisV1,
} from "./types.js";

const StopWords = new Set([
  "the",
  "and",
  "or",
  "but",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "onto",
  "than",
  "then",
  "when",
  "where",
  "while",
  "would",
  "could",
  "should",
  "will",
  "may",
  "might",
  "must",
  "can",
  "cannot",
  "not",
  "are",
  "is",
  "was",
  "were",
  "been",
  "being",
  "have",
  "has",
  "had",
  "does",
  "did",
  "do",
  "its",
  "their",
  "our",
  "your",
  "에",
  "의",
  "가",
  "이",
  "은",
  "는",
  "을",
  "를",
  "과",
  "와",
  "도",
  "로",
  "으로",
]);

export type DecisionDialecticSubstanceMode = "warn" | "enforce";

export function decisionDialecticSubstanceMode(task: DecisionDialecticTaskV1): DecisionDialecticSubstanceMode {
  const mode = task.context.domainContext?.decisionDialecticSubstanceGate;
  return mode === "enforce" ? "enforce" : "warn";
}

export function validateAntithesisSubstance(
  task: DecisionDialecticTaskV1,
  antithesis: DecisionDialecticAntithesisV1,
): DecisionDialecticSubstanceWarningV1[] {
  const thesis = task.thesis;
  if (!thesis) {
    return [];
  }

  const warnings: DecisionDialecticSubstanceWarningV1[] = [];
  if (!hasContradictionCrossReference(thesis, antithesis.contradictions)) {
    warnings.push({
      phase: "antithesis",
      code: "antithesis_contradiction_not_cross_referenced",
      severity: "warn",
      message: "antithesis.contradictions must deterministically reference thesis.claim, thesis.proposal, or thesis.assumptions",
    });
  }

  if (!hasIndependentEvidence(thesis.evidenceRefs, antithesis.evidenceRefs)) {
    warnings.push({
      phase: "antithesis",
      code: "antithesis_missing_independent_evidence",
      severity: "warn",
      message: "antithesis.evidenceRefs must include at least one ref not present in thesis.evidenceRefs",
    });
  }

  if (!hasNonTrivialListItem(antithesis.failureModes)) {
    warnings.push({
      phase: "antithesis",
      code: "antithesis_failure_modes_not_substantive",
      severity: "warn",
      message: "antithesis.failureModes must include at least one non-trivial failure mode",
    });
  }

  return warnings;
}

export function validateRebuttalSubstance(
  rebuttal: DecisionDialecticRebuttalV1,
): DecisionDialecticSubstanceWarningV1[] {
  if (hasNonTrivialListItem([...rebuttal.concededRisks, ...rebuttal.residualRisks])) {
    return [];
  }
  return [
    {
      phase: "rebuttal",
      code: "rebuttal_missing_risk_acknowledgement",
      severity: "warn",
      message: "rebuttal must include at least one non-trivial concededRisks or residualRisks entry",
    },
  ];
}

export function appendSubstanceWarnings(
  task: DecisionDialecticTaskV1,
  warnings: DecisionDialecticSubstanceWarningV1[],
): void {
  if (warnings.length === 0) {
    return;
  }
  task.substanceWarnings = [...(task.substanceWarnings ?? []), ...warnings];
}

function hasContradictionCrossReference(thesis: DecisionDialecticThesisV1, contradictions: string[]): boolean {
  const thesisTokenSets = [thesis.claim, thesis.proposal, ...thesis.assumptions].map(tokenSet);
  return contradictions.some((contradiction) => {
    const normalized = normalize(contradiction);
    if (/\b(claim|proposal|assumption)s?\b/.test(normalized) || /\b(thesis|전제|제안|주장)\b/.test(normalized)) {
      return true;
    }
    const contradictionTokens = tokenSet(contradiction);
    return thesisTokenSets.some((tokens) => countOverlap(tokens, contradictionTokens) >= 2);
  });
}

function hasIndependentEvidence(thesisEvidenceRefs: string[], antithesisEvidenceRefs: string[]): boolean {
  const thesisRefs = new Set(thesisEvidenceRefs.map((ref) => ref.trim()).filter(Boolean));
  return antithesisEvidenceRefs.some((ref) => {
    const normalizedRef = ref.trim();
    return normalizedRef.length > 0 && !thesisRefs.has(normalizedRef);
  });
}

function hasNonTrivialListItem(values: string[]): boolean {
  return values.some((value) => {
    const tokens = tokenSet(value);
    return tokens.size >= 2 || normalize(value).length >= 12;
  });
}

function tokenSet(value: string): Set<string> {
  return new Set(
    normalize(value)
      .split(/[^\p{L}\p{N}_-]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !StopWords.has(token)),
  );
}

function normalize(value: string): string {
  return value.toLocaleLowerCase("en-US").normalize("NFKC");
}

function countOverlap(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const token of left) {
    if (right.has(token)) {
      count += 1;
    }
  }
  return count;
}
