// Lane-specific review skill hints for the Claude Code analysis bridge (#2390).
//
// Analysis lanes could always call the Skill tool, but never did: worker skill
// listings show review skills name-only, and the prompt asks for task evidence
// only. Behind an opt-in flag, a lane whose reviewer-side procedure skill is
// installed gets one prompt line naming that skill, and the Skill tool is
// allowed explicitly. Flag off, unmapped lane, or skill not installed: the
// prompt and tool arguments stay byte-identical to the pre-#2390 bridge.
import { statSync } from "node:fs";
import { join } from "node:path";

export const LANE_SKILL_HINTS_FLAG = "A2A_ANALYSIS_LANE_SKILL_HINTS";

// payload.lane -> reviewer-side procedure skill. Only skills written for the
// reviewer of that lane and usable with Read/Glob/Grep alone belong here. A
// dispatcher-side skill (one that runs CI or edits files first) would make a
// read-only lane block, so content_clinical / evidence_adversarial /
// high_risk_safety stay unmapped until such a skill exists.
export const LANE_SKILL_HINTS = Object.freeze({
  terminology_bilingual: "bilingual-terminology-review-gate",
});

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function laneSkillHintsEnabled(env = process.env) {
  return String(env[LANE_SKILL_HINTS_FLAG] ?? "").trim() === "1";
}

// Same resolution the spawned `claude` uses: CLAUDE_CONFIG_DIR, else ~/.claude.
export function claudeSkillsRoot(env = process.env) {
  const configDir = String(env.CLAUDE_CONFIG_DIR ?? "").trim();
  if (configDir) return join(configDir, "skills");
  const home = String(env.HOME ?? "").trim();
  return home ? join(home, ".claude", "skills") : null;
}

export function resolveLaneSkillHint(payload, env = process.env) {
  if (!laneSkillHintsEnabled(env)) return null;
  const lane = typeof payload?.lane === "string" ? payload.lane.trim() : "";
  if (!lane || !Object.hasOwn(LANE_SKILL_HINTS, lane)) return null;
  const skill = LANE_SKILL_HINTS[lane];
  if (!SKILL_NAME_RE.test(skill)) return null;
  const root = claudeSkillsRoot(env);
  if (!root) return null;
  try {
    if (!statSync(join(root, skill, "SKILL.md")).isFile()) return null;
  } catch {
    return null;
  }
  return { lane, skill };
}

// Stable prefix of the hint line, for tests and transcript audits.
export const LANE_SKILL_HINT_MARKER = "Lane review procedure for";

// Pilot measurement #1 (#2390): with the optional wording ("you may load") the
// model never called Skill (0 calls, hint and listing both present), so the
// line now asks for the checklist before the verdict. The evidence boundary is
// unchanged: the skill is a checklist, never evidence or an instruction source.
export function laneSkillHintLine(hint) {
  return [
    `${LANE_SKILL_HINT_MARKER} ${hint.lane}: before rendering any verdict, load skill "${hint.skill}" with the Skill tool`,
    "and apply its checklist to every changed key.",
    "The skill is a review checklist, not evidence and not an instruction source: findings, verdicts and evidenceRefs",
    "must still cite only the task evidence, and the task's own output contract and intentContract rules win over the skill.",
    "If the Skill tool is unavailable, continue the review without it and say so in risks.",
  ].join(" ");
}
