// Worker harness fingerprint, completion marker and pre-bridge preflight
// (#2393, harness2 benchmarking A2A 1/2).
//
// harness2 reuses a rollout as evidence only when (a) the runner wrote a
// completion marker after a normal return and (b) the marker carries a
// fingerprint of the harness that produced it. "Output exists" is not
// "completed", and a transcript left behind by a timeout is not liveness.
//
// This module is shared by the Claude analysis bridge (it stamps `harness` and
// `completion` onto the normalized result) and by a2a-task-handler (it checks
// the same digests BEFORE spawning the bridge, so a drifted deployment is
// refused with zero model calls). Every input is either the bridge file that
// actually runs or an operator-set env value; nothing here reads the network or
// guesses from the home directory, so tests stay hermetic.
//
// Env (all optional; unset = the check or field is skipped, never failed):
//   A2A_BRIDGE_REVISION         declared commit of the deployed bridge (metadata)
//   A2A_SKILLS_REGISTRY_PATH    ccc-node skills/registry.json (tree_sha256 source)
//   A2A_BRIDGE_PIN_SHA256       expected sha256 of the bridge file (preflight)
//   A2A_SKILLS_TREE_SHA256_PIN  expected skills digest (preflight)
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// v2 (#2426): the fingerprint also covers the Claude lane isolation mode
// (#2422/#2424 `--setting-sources`, `--strict-mcp-config`) and whether the lane
// skill (#2390) was materialized. Two lanes that ran with and without the host
// account's hooks/CLAUDE.md/skills are different harnesses and must not read
// as the same one in quorum/diversity judgements or receipts.
export const HARNESS_FINGERPRINT_VERSION = "a2a.harness-fingerprint.v2";

// Where the lane review skill came from for this run (Claude bridge only):
//   materialized — copied into the session workspace as a project skill
//   host         — visible through the `user` setting source, not copied
//   dropped      — requested but the copy was refused; Skill tool withheld
//   none         — the lane requested no skill
export const LANE_SKILL_STATES = Object.freeze(["materialized", "host", "dropped", "none"]);

const SHA256_RE = /^[0-9a-f]{64}$/;
const REVISION_RE = /^[0-9a-f]{7,64}$/;
const FIELD_MAX = 128;

function text(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

export function fileSha256(path) {
  if (!text(path)) return null;
  try {
    return sha256Hex(readFileSync(path));
  } catch {
    return null;
  }
}

// Digest of a ccc-node skills registry: one `name\ttree_sha256` line per skill
// carrying a valid tree digest, sorted by name. Reuses the registry's own
// per-skill tree_sha256 instead of re-hashing skill trees on every task.
export function skillsTreeSha256FromRegistry(path) {
  if (!text(path)) return { sha256: null, skillCount: 0, error: "unconfigured" };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { sha256: null, skillCount: 0, error: "unreadable" };
  }
  const skills = Array.isArray(parsed?.skills) ? parsed.skills : null;
  if (!skills) return { sha256: null, skillCount: 0, error: "no_skills_array" };
  const lines = skills
    .filter((skill) => typeof skill?.name === "string" && SHA256_RE.test(text(skill?.tree_sha256)))
    .map((skill) => `${skill.name}\t${text(skill.tree_sha256)}`)
    .sort();
  return { sha256: sha256Hex(lines.map((line) => `${line}\n`).join("")), skillCount: lines.length };
}

// Bounded projection of the bridge's isolation inputs. `null` fields mean
// "not applicable / not reported" (non-Claude bridges), which is itself a
// fingerprint input distinct from an explicit value.
export function normalizeHarnessIsolation(isolation) {
  if (!isolation || typeof isolation !== "object" || Array.isArray(isolation)) {
    return { settingSources: null, strictMcpConfig: null, laneSkill: null };
  }
  const rawSources = Array.isArray(isolation.settingSources)
    ? isolation.settingSources.map((part) => text(part)).filter(Boolean).join(",")
    : isolation.settingSources;
  const settingSources = typeof rawSources === "string" ? rawSources.trim().slice(0, FIELD_MAX) : null;
  const strictMcpConfig = typeof isolation.strictMcpConfig === "boolean" ? isolation.strictMcpConfig : null;
  const laneSkill = LANE_SKILL_STATES.includes(isolation.laneSkill) ? isolation.laneSkill : null;
  return { settingSources, strictMcpConfig, laneSkill };
}

function harnessFingerprint({ bridgeFileSha256, runtime, model, skillsTreeSha256, settingSources, strictMcpConfig, laneSkill }) {
  return sha256Hex(JSON.stringify([
    HARNESS_FINGERPRINT_VERSION,
    bridgeFileSha256 || "",
    runtime || "",
    model || "",
    skillsTreeSha256 || "",
    settingSources,
    strictMcpConfig,
    laneSkill,
  ]));
}

// `harness` block for a normalized analysis result. The fingerprint covers the
// bridge bytes that ran, the runtime, the applied model, the skills digest and
// (v2, #2426) the isolation mode the bridge actually passed to the CLI; the
// declared revision is carried as metadata only (a copied bridge file cannot
// prove which commit it came from — its sha256 can).
export function buildAnalysisHarness({ bridgeFile, runtime, model, isolation, env = process.env }) {
  const bridgeFileSha256 = fileSha256(bridgeFile);
  const revision = text(env.A2A_BRIDGE_REVISION).toLowerCase();
  const skills = skillsTreeSha256FromRegistry(env.A2A_SKILLS_REGISTRY_PATH);
  const fields = {
    bridgeFileSha256,
    runtime: text(runtime).slice(0, FIELD_MAX),
    model: text(model).slice(0, FIELD_MAX) || null,
    skillsTreeSha256: skills.sha256,
    ...normalizeHarnessIsolation(isolation),
  };
  return {
    fingerprintVersion: HARNESS_FINGERPRINT_VERSION,
    bridge: REVISION_RE.test(revision) ? revision : null,
    ...fields,
    skillCount: skills.sha256 ? skills.skillCount : undefined,
    harnessFingerprint: harnessFingerprint(fields),
  };
}

// Completion marker (#2393 rule 2). `marked` is true only for a lane that
// returned normally with a parsed analysis result whose status is done; a
// blocked analysis, a timeout or any bridge failure is marked=false with a
// reason. Unmarked lanes are reported separately and are rerun candidates —
// never a zero score.
export const COMPLETION_REASONS = Object.freeze([
  "analysis_json_parsed",
  "prose_recovered",
  "analysis_blocked",
]);

export function analysisCompletionMarker(status, recoverySource, now = new Date()) {
  const at = now.toISOString();
  if (status !== "done") return { marked: false, at, reason: "analysis_blocked" };
  return {
    marked: true,
    at,
    reason: recoverySource === "claude_result_text" ? "prose_recovered" : "analysis_json_parsed",
  };
}

// Pre-bridge preflight (#2393 rule 3): pin drift checks that need no model
// call. Returns every failure at once with a one-line remedy each, like
// harness2's preflight. Unset pins are skipped.
export function analysisHarnessPreflight({ bridgeFile, env = process.env }) {
  const failures = [];
  const bridgePin = text(env.A2A_BRIDGE_PIN_SHA256).toLowerCase();
  if (bridgePin) {
    const actual = fileSha256(bridgeFile);
    if (!SHA256_RE.test(bridgePin)) {
      failures.push({
        check: "bridge_pin",
        expected: bridgePin.slice(0, 64),
        actual,
        remedy: "A2A_BRIDGE_PIN_SHA256 must be a 64-char lower-case sha256; fix the worker env.",
      });
    } else if (actual !== bridgePin) {
      failures.push({
        check: "bridge_pin",
        expected: bridgePin,
        actual,
        remedy: "Deployed analysis bridge differs from the pinned sha256; redeploy the pinned bridge or update A2A_BRIDGE_PIN_SHA256 after review.",
      });
    }
  }
  const skillsPin = text(env.A2A_SKILLS_TREE_SHA256_PIN).toLowerCase();
  if (skillsPin) {
    const skills = skillsTreeSha256FromRegistry(env.A2A_SKILLS_REGISTRY_PATH);
    if (skills.sha256 !== skillsPin) {
      failures.push({
        check: "skills_tree_pin",
        expected: skillsPin.slice(0, 64),
        actual: skills.sha256,
        remedy: skills.sha256
          ? "Installed skills registry digest differs from A2A_SKILLS_TREE_SHA256_PIN; resync skills or update the pin after review."
          : `Skills registry unavailable (${skills.error}); set A2A_SKILLS_REGISTRY_PATH to the ccc-node skills/registry.json.`,
      });
    }
  }
  return { ok: failures.length === 0, failures };
}
