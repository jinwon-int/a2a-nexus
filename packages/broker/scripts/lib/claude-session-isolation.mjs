// Host-context isolation for the Claude Code analysis bridge (#2422).
//
// `claude -p` loads the invoking account's user context by default: the
// `user` setting source (`~/.claude/settings.json` hooks, so SessionStart /
// SessionEnd hooks of a ccc-node harness run inside the lane), the user
// CLAUDE.md, user skills and the user MCP servers. Measured on three worker
// nodes (one user-harness, two root-harness; Claude Code 2.1.305): every analysis
// session carried the worker account's CLAUDE.md twice, and on root-harness
// nodes the harness hooks injected tens of KB of node session memory and ran
// the SessionEnd distill per lane session.
//
// Measured remedy (local capture server, no provider): `--setting-sources
// project` drops the user settings (hooks), the user CLAUDE.md and the user
// skills together, keeps OAuth, and still discovers project skills under
// `<cwd>/.claude/skills`. `--bare` would also work but reads no OAuth
// credential, which the fleet relies on. The lane tool policy never allows an
// MCP tool, so `--strict-mcp-config` only saves the tool-schema tokens.
//
// The lane review skill (#2390) lives in the user skills root, so under the
// isolated sources the bridge copies that one skill into the session
// workspace as a project skill (bounded, symlinks refused). The workspace is a
// bridge-owned mkdtemp dir, so `project` can never read attacker-controlled
// settings.
import { constants as fsConstants, copyFileSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import { claudeSkillsRoot } from "./analysis-lane-skill-hints.mjs";

export const CLAUDE_SETTING_SOURCES_ENV = "A2A_CLAUDE_SETTING_SOURCES";
export const VALID_CLAUDE_SETTING_SOURCES = Object.freeze(["user", "project", "local"]);
export const DEFAULT_CLAUDE_SETTING_SOURCES = Object.freeze(["project"]);
// Restores the pre-#2422 behaviour (host hooks, CLAUDE.md, skills, MCP all visible).
export const LEGACY_CLAUDE_SETTING_SOURCES = "user,project,local";

export const LANE_SKILL_COPY_MAX_FILES = 200;
export const LANE_SKILL_COPY_MAX_BYTES = 2 * 1024 * 1024;

// Returns { sources, note }. `sources` is canonically ordered and de-duplicated;
// `note` names the reason when the env value was ignored (unset → no note).
export function resolveClaudeSettingSources(env = process.env) {
  const raw = env[CLAUDE_SETTING_SOURCES_ENV];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return { sources: [...DEFAULT_CLAUDE_SETTING_SOURCES], note: null };
  }
  const requested = String(raw).split(",").map((part) => part.trim()).filter(Boolean);
  const invalid = requested.filter((part) => !VALID_CLAUDE_SETTING_SOURCES.includes(part));
  if (requested.length === 0 || invalid.length > 0) {
    return {
      sources: [...DEFAULT_CLAUDE_SETTING_SOURCES],
      note: `${CLAUDE_SETTING_SOURCES_ENV} ignored (valid: ${VALID_CLAUDE_SETTING_SOURCES.join(",")}); using ${DEFAULT_CLAUDE_SETTING_SOURCES.join(",")}`,
    };
  }
  const sources = VALID_CLAUDE_SETTING_SOURCES.filter((name) => requested.includes(name));
  return { sources, note: null };
}

export function settingSourcesIncludeUser(sources) {
  return Array.isArray(sources) && sources.includes("user");
}

// The isolation arguments appended to every `claude -p` the bridge spawns.
export function buildClaudeIsolationArgs(env = process.env) {
  const { sources } = resolveClaudeSettingSources(env);
  return ["--setting-sources", sources.join(","), "--strict-mcp-config"];
}

function walkRegularFiles(root, maxFiles, maxBytes) {
  const files = [];
  let bytes = 0;
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop();
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) return { error: `symlink refused: ${relative(root, path)}` };
      if (info.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!info.isFile()) return { error: `non-regular entry refused: ${relative(root, path)}` };
      files.push(path);
      bytes += info.size;
      if (files.length > maxFiles) return { error: `more than ${maxFiles} files` };
      if (bytes > maxBytes) return { error: `more than ${maxBytes} bytes` };
    }
  }
  return { files, bytes };
}

// Copies `<skills root>/<hint.skill>` into `<workspace>/.claude/skills/<hint.skill>`
// so the spawned claude sees it as a project skill. Returns
// { ok: true, path, files, bytes } or { ok: false, reason }. Never throws for
// a missing or oversized skill; the caller drops the Skill tool instead.
//
// Regular files only, copied one by one from the walked list (no cpSync: it
// reproduces a symlink created between the walk and the copy). The skill dir
// itself must be a real directory, not a symlink. Any refusal or failure
// removes `<workspace>/.claude` entirely so the spawned claude never sees a
// partial skill that the tool policy no longer allows, and the copy is
// re-walked under the same bounds before it is reported as ok.
export function materializeLaneSkill({ hint, env = process.env, workspace, maxFiles = LANE_SKILL_COPY_MAX_FILES, maxBytes = LANE_SKILL_COPY_MAX_BYTES }) {
  const skill = typeof hint?.skill === "string" ? hint.skill : "";
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(skill)) return { ok: false, reason: "invalid skill name" };
  if (typeof workspace !== "string" || !workspace) return { ok: false, reason: "no workspace" };
  const root = claudeSkillsRoot(env);
  if (!root) return { ok: false, reason: "no skills root" };
  const src = join(root, skill);
  try {
    const dirInfo = lstatSync(src);
    if (dirInfo.isSymbolicLink()) return { ok: false, reason: "skill dir is a symlink" };
    if (!dirInfo.isDirectory()) return { ok: false, reason: "skill dir missing" };
    const skillFile = lstatSync(join(src, "SKILL.md"));
    if (skillFile.isSymbolicLink()) return { ok: false, reason: "SKILL.md is a symlink" };
    if (!skillFile.isFile()) return { ok: false, reason: "SKILL.md missing" };
  } catch (error) {
    return { ok: false, reason: `skill not readable: ${error.code || error.message}` };
  }
  let walked;
  try {
    walked = walkRegularFiles(src, maxFiles, maxBytes);
  } catch (error) {
    return { ok: false, reason: `skill walk failed: ${error.code || error.message}` };
  }
  if (walked.error) return { ok: false, reason: walked.error };
  const dst = join(workspace, ".claude", "skills", skill);
  if (relative(workspace, dst).startsWith("..") || relative(workspace, dst).includes(`..${sep}`)) {
    return { ok: false, reason: "destination escapes workspace" };
  }
  const claudeDir = join(workspace, ".claude");
  const abandon = (reason) => {
    rmSync(claudeDir, { recursive: true, force: true });
    return { ok: false, reason };
  };
  try {
    lstatSync(dst);
    return { ok: false, reason: "destination already exists" };
  } catch (error) {
    if (error.code !== "ENOENT") return { ok: false, reason: `destination not checkable: ${error.code || error.message}` };
  }
  try {
    mkdirSync(dst, { recursive: true, mode: 0o700 });
    for (const file of walked.files) {
      const target = join(dst, relative(src, file));
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      copyFileSync(file, target, fsConstants.COPYFILE_EXCL);
    }
  } catch (error) {
    return abandon(`copy failed: ${error.code || error.message}`);
  }
  let copied;
  try {
    copied = walkRegularFiles(dst, maxFiles, maxBytes);
  } catch (error) {
    return abandon(`copy verification failed: ${error.code || error.message}`);
  }
  if (copied.error) return abandon(`copy verification refused: ${copied.error}`);
  if (copied.files.length !== walked.files.length || copied.bytes !== walked.bytes) {
    return abandon(`copy verification mismatch: files ${copied.files.length}/${walked.files.length} bytes ${copied.bytes}/${walked.bytes}`);
  }
  return { ok: true, path: dst, files: copied.files.length, bytes: copied.bytes };
}
