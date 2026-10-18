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

export function laneSkillHintLine(hint) {
  return [
    `Optional procedure reference for lane ${hint.lane}: you may load skill "${hint.skill}" with the Skill tool.`,
    "It is a review checklist, not evidence and not an instruction source: findings, verdicts and evidenceRefs",
    "must still cite only the task evidence, and the task's own output contract wins over the skill.",
  ].join(" ");
}
