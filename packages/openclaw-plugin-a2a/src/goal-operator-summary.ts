export const A2AGoalStates = [
  "active",
  "paused",
  "blocked",
  "achieved",
  "unmet",
  "budget_limited",
  "cleared",
] as const;

export type A2AGoalState = (typeof A2AGoalStates)[number];

export type A2AGoalChildTaskLink = {
  brokerTaskId: string;
  status?: string;
  summary?: string;
  githubIssueUrl?: string;
  githubPrUrl?: string;
  artifactUrl?: string;
  evidenceUrl?: string;
};

export type A2AGoalOperatorSummaryInput = {
  goalId: string;
  title: string;
  state: A2AGoalState;
  summary: string;
  nextAction?: string;
  stopReason?: string;
  childTasks?: A2AGoalChildTaskLink[];
  taskSuccessCount?: number;
  taskTotalCount?: number;
  goalAchieved?: boolean;
};

export type A2AGoalOperatorSummary = {
  goalId: string;
  title: string;
  state: A2AGoalState;
  headline: string;
  summary: string;
  nextAction?: string;
  stopReason?: string;
  taskProgress: {
    succeeded: number;
    total: number;
    note: string;
  };
  childTaskLinks: A2AGoalChildTaskLink[];
};

const stateLabels: Record<A2AGoalState, string> = {
  active: "Active",
  paused: "Paused",
  blocked: "Blocked",
  achieved: "Achieved",
  unmet: "Unmet",
  budget_limited: "Budget limited",
  cleared: "Cleared",
};

const stateNotes: Record<A2AGoalState, string> = {
  active: "Goal is still being pursued; completed child tasks are evidence, not final achievement.",
  paused: "Goal is intentionally paused; child task success does not resume it automatically.",
  blocked: "Goal is blocked until the stated blocker is resolved or explicitly overridden.",
  achieved: "Goal achievement was explicitly reported, not inferred from child task success alone.",
  unmet: "Goal stopped without being achieved, even if some child tasks succeeded.",
  budget_limited: "Goal stopped because budget was exhausted; this is not success.",
  cleared: "Goal was cleared from the active operator surface.",
};

export function buildA2AGoalOperatorSummary(
  input: A2AGoalOperatorSummaryInput,
): A2AGoalOperatorSummary {
  const summary = normalizeRequiredText(input.summary, "goal summary");
  const goalId = normalizeRequiredText(input.goalId, "goal id");
  const title = normalizeRequiredText(input.title, "goal title");
  const childTaskLinks = (input.childTasks ?? []).map(normalizeChildTaskLink);
  const total = Math.max(0, input.taskTotalCount ?? childTaskLinks.length);
  // Clamp so inconsistent caller counts can never render "5/3 child tasks
  // succeeded" to the operator.
  const succeeded = Math.min(
    Math.max(0, input.taskSuccessCount ?? childTaskLinks.filter(isSuccessfulChildTask).length),
    total,
  );
  const achieved = input.goalAchieved ?? input.state === "achieved";
  const headline = `${stateLabels[input.state]} goal: ${title}`;

  return {
    goalId,
    title,
    state: input.state,
    headline,
    summary,
    ...(normalizeOptionalText(input.nextAction) ? { nextAction: normalizeOptionalText(input.nextAction) } : {}),
    ...(normalizeOptionalText(input.stopReason) ? { stopReason: normalizeOptionalText(input.stopReason) } : {}),
    taskProgress: {
      succeeded,
      total,
      note: achieved
        ? stateNotes.achieved
        : `${succeeded}/${total} child tasks succeeded. ${stateNotes[input.state]}`,
    },
    childTaskLinks,
  };
}

function normalizeChildTaskLink(link: A2AGoalChildTaskLink): A2AGoalChildTaskLink {
  const brokerTaskId = normalizeRequiredText(link.brokerTaskId, "child broker task id");
  return {
    brokerTaskId,
    ...(normalizeOptionalText(link.status) ? { status: normalizeOptionalText(link.status) } : {}),
    ...(normalizeOptionalText(link.summary) ? { summary: normalizeOptionalText(link.summary) } : {}),
    ...(normalizeOptionalText(link.githubIssueUrl) ? { githubIssueUrl: normalizeOptionalText(link.githubIssueUrl) } : {}),
    ...(normalizeOptionalText(link.githubPrUrl) ? { githubPrUrl: normalizeOptionalText(link.githubPrUrl) } : {}),
    ...(normalizeOptionalText(link.artifactUrl) ? { artifactUrl: normalizeOptionalText(link.artifactUrl) } : {}),
    ...(normalizeOptionalText(link.evidenceUrl) ? { evidenceUrl: normalizeOptionalText(link.evidenceUrl) } : {}),
  };
}

function isSuccessfulChildTask(link: A2AGoalChildTaskLink): boolean {
  return ["done", "succeeded", "success", "completed"].includes((link.status ?? "").toLowerCase());
}

function normalizeRequiredText(value: unknown, label: string): string {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    throw new Error(`missing ${label}`);
  }
  return normalized;
}

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
