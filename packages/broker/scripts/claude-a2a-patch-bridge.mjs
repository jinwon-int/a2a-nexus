#!/usr/bin/env node
// Intent-aware Claude Code A2A bridge for NON-Docker (Termux/Android proot) workers.
//
// Same CLI contract as the OpenClaw bridge the handler spawns:
//   <bin> agent --local --agent main --session-id <id> --message <PROMPT> \
//         --model <m> --thinking <t> --timeout <sec> --json
// Same stdout envelope as claude-a2a-analysis-bridge.mjs:
//   {"payloads":[{"text": JSON.stringify(result)}]}
//
// The SAME bin env var (A2A_OPENCLAW_ANALYSIS_BIN / OPENCLAW_BIN) is used for BOTH
// analysis-intent and patch-intent tasks, so this bridge is intent-aware:
//   - PATCH mode  : runs `claude` with write tools inside an isolated mktemp workspace,
//                   expects GitHub evidence (prUrl / doneCommentUrl / blockCommentUrl).
//   - ANALYSIS mode: behaves IDENTICALLY to claude-a2a-analysis-bridge.mjs (read-only).
//
// The analysis-mode logic/helpers below are a faithful copy of
// claude-a2a-analysis-bridge.mjs (its helpers are not exported), so analysis output
// schema and recovery behavior are preserved with no regression.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function safeText(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

// Redact token-shaped strings (runs of 20+ url-safe chars) from any text we emit.
function redactSecrets(value) {
  return safeText(value).replace(/[A-Za-z0-9_-]{20,}/g, "[REDACTED]");
}

function die(message) {
  process.stderr.write(`${redactSecrets(safeText(message, "Claude Code patch bridge failed"))}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const flags = { subcommand: argv[2] };
  for (let i = 3; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    if (key === "json" || key === "local") {
      flags[key] = true;
      continue;
    }
    flags[key] = argv[i + 1];
    i += 1;
  }
  return flags;
}

function positiveInteger(value, fallback) {
  const n = Number(value);
  if (Number.isInteger(n) && n > 0) return n;
  return fallback;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => safeText(entry).trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Shared JSON-extraction helpers (copied verbatim from claude-a2a-analysis-bridge.mjs;
// the source helpers are not exported, and that bridge must remain unmodified).
// ---------------------------------------------------------------------------

function extractBalancedJsonObjects(text) {
  const candidates = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return candidates;
}

function parseJsonCandidate(text) {
  const trimmed = safeText(text).trim();
  if (!trimmed) throw new Error("empty JSON text");
  try {
    return JSON.parse(trimmed);
  } catch {
    const candidates = extractBalancedJsonObjects(trimmed);
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      try {
        return JSON.parse(candidates[i]);
      } catch {
        // try the previous candidate
      }
    }
    throw new Error("no parseable JSON object");
  }
}

// ===========================================================================
// ANALYSIS MODE (identical behavior to claude-a2a-analysis-bridge.mjs)
// ===========================================================================

function hasExplicitAnalysisJsonShape(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof value.status === "string" &&
      typeof value.summary === "string" &&
      Array.isArray(value.findings) &&
      Array.isArray(value.risks) &&
      Array.isArray(value.recommendations) &&
      Array.isArray(value.evidenceRefs),
  );
}

function looksJsonLikeText(value) {
  const trimmed = safeText(value).trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[") || /^```json\b/i.test(trimmed);
}

function firstSentence(text, max = 240) {
  const compact = safeText(text).replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1).trim()}…`;
}

function isProbablyClaudeErrorText(text) {
  return /\b(error|failed|failure|auth|authentication|permission denied|unauthorized|cancelled|canceled|timeout|rate limit)\b/i.test(safeText(text));
}

function collectClaudeTextPayloads(value, source = "stdout", depth = 0) {
  if (depth > 8 || value === undefined || value === null) return [];
  if (typeof value === "string") {
    const text = value.trim();
    return text ? [{ source, text }] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => collectClaudeTextPayloads(entry, `${source}[${index}]`, depth + 1));
  }
  if (typeof value !== "object") return [];

  const prioritized = [
    ["result", value.result],
    ["text", value.text],
    ["content", value.content],
    ["message", value.message],
    ["response", value.response],
    ["output", value.output],
    ["value", value.value],
  ];
  return prioritized.flatMap(([key, child]) => collectClaudeTextPayloads(child, source === "stdout" ? key : `${source}.${key}`, depth + 1));
}

function findAnalysisJson(value, depth = 0) {
  if (depth > 8 || value === undefined || value === null) return null;
  if (hasExplicitAnalysisJsonShape(value)) return value;
  if (typeof value === "string") {
    if (!value.trim()) return null;
    try {
      const parsed = parseJsonCandidate(value);
      return findAnalysisJson(parsed, depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findAnalysisJson(entry, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const key of ["result", "content", "message", "text", "response", "output", "value", "payloads", "messages"]) {
      const found = findAnalysisJson(value[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function proseAnalysisFromClaudeText(outer) {
  for (const { source, text } of collectClaudeTextPayloads(outer)) {
    const trimmed = text.trim();
    if (trimmed.length < 20) continue;
    if (looksJsonLikeText(trimmed)) continue;
    if (isProbablyClaudeErrorText(trimmed)) continue;
    return {
      status: "done",
      summary: firstSentence(trimmed),
      findings: [trimmed],
      risks: ["Claude Code CLI returned natural-language analysis instead of strict JSON; the bridge recovered it as prose so a substantive lane is not dropped."],
      recommendations: ["Tighten the Claude Code worker prompt/output contract so future lanes emit strict analysis JSON directly."],
      evidenceRefs: [`claude-code:${source.split(".")[0]}`],
      recoverySource: "claude_result_text",
    };
  }
  return null;
}

function extractAnalysisJsonFromClaudeOutput(stdout) {
  const outer = parseJsonCandidate(stdout);
  const found = findAnalysisJson(outer);
  if (found) return found;

  // Last resort before prose recovery: scan stdout for the last explicit analysis-shaped JSON.
  const candidates = extractBalancedJsonObjects(safeText(stdout));
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(candidates[i]);
      const candidate = findAnalysisJson(parsed);
      if (candidate) return candidate;
    } catch {
      // keep scanning
    }
  }

  const proseRecovered = proseAnalysisFromClaudeText(outer);
  if (proseRecovered) return proseRecovered;

  throw new Error("Claude output did not contain valid analysis JSON");
}

function normalizeAnalysisResponse(parsed) {
  if (!hasExplicitAnalysisJsonShape(parsed)) {
    throw new Error("invalid Claude analysis JSON schema");
  }
  const statusRaw = safeText(parsed.status, "done").toLowerCase();
  const status = ["blocked", "block", "source_blocked"].includes(statusRaw) ? "blocked" : "done";
  return {
    status,
    summary: safeText(parsed.summary, status === "blocked" ? "analysis blocked" : "analysis complete"),
    findings: normalizeStringArray(parsed.findings),
    risks: normalizeStringArray(parsed.risks),
    recommendations: normalizeStringArray(parsed.recommendations),
    evidenceRefs: normalizeStringArray(parsed.evidenceRefs),
    recoverySource: safeText(parsed.recoverySource, "direct_stdout"),
    ...(safeText(parsed.doneCommentUrl, "") ? { doneCommentUrl: safeText(parsed.doneCommentUrl) } : {}),
    ...(safeText(parsed.blockCommentUrl, "") ? { blockCommentUrl: safeText(parsed.blockCommentUrl) } : {}),
    ...(safeText(parsed.startCommentUrl, "") ? { startCommentUrl: safeText(parsed.startCommentUrl) } : {}),
  };
}

function buildAnalysisPrompt({ message, flags }) {
  return [
    "You are a Claude Code CLI-backed A2A analysis bridge.",
    "Complete only the read-only analysis requested by the broker-packaged task.",
    "Do not modify files, run deploys, restart services, mutate databases, acknowledge terminal rows, move credentials, or perform live side effects.",
    "Use only evidence in the task prompt unless the caller explicitly provided read-only evidence inside the payload.",
    "If the evidence is insufficient, return status=blocked and name the missing evidence.",
    "Return JSON only, no markdown, with exactly this shape:",
    '{"status":"done|blocked","summary":"...","findings":["..."],"risks":["..."],"recommendations":["..."],"evidenceRefs":["..."],"doneCommentUrl":"optional","blockCommentUrl":"optional","startCommentUrl":"optional"}',
    "All human-readable text should be Korean unless quoting code/test output.",
    `Session id: ${safeText(flags["session-id"], "")}`,
    `Requested model: ${safeText(flags.model, "")}`,
    `Requested thinking: ${safeText(flags.thinking, "")}`,
    "Original worker message:",
    message,
  ].join("\n\n");
}

function runClaudeAnalysis(prompt, flags, env = process.env) {
  const claudeBin = safeText(env.A2A_CLAUDE_CODE_BIN, safeText(env.CLAUDE_BIN, "claude"));
  const timeoutSec = positiveInteger(flags.timeout, positiveInteger(env.A2A_CLAUDE_CODE_TIMEOUT_SEC, 600));
  const maxTurns = positiveInteger(env.A2A_CLAUDE_CODE_MAX_TURNS, 10);
  const args = ["-p", prompt, "--output-format", "json", "--max-turns", String(maxTurns)];
  const child = spawnSync(claudeBin, args, {
    env,
    encoding: "utf8",
    maxBuffer: positiveInteger(env.A2A_CLAUDE_CODE_MAX_OUTPUT_BYTES, 8 * 1024 * 1024),
    timeout: timeoutSec * 1000,
    killSignal: "SIGKILL",
  });
  if (child.error) throw new Error(`Claude Code spawn failed: ${child.error.message}`);
  if (child.status !== 0) {
    const signal = child.signal ? ` signal=${child.signal}` : "";
    throw new Error(`Claude Code exited with ${child.status}${signal}: ${safeText(child.stderr, child.stdout).slice(0, 4000)}`);
  }
  return child.stdout;
}

function runAnalysisMode(message, flags) {
  const prompt = buildAnalysisPrompt({ message, flags });
  let stdout;
  try {
    stdout = runClaudeAnalysis(prompt, flags, process.env);
  } catch (error) {
    die(error.message);
  }

  let response;
  try {
    response = normalizeAnalysisResponse(extractAnalysisJsonFromClaudeOutput(stdout));
  } catch (error) {
    die(error.message);
  }

  process.stdout.write(JSON.stringify({ payloads: [{ text: JSON.stringify(response) }] }));
}

// ===========================================================================
// PATCH MODE (write-capable, isolated workspace, GitHub evidence required)
// ===========================================================================

// Bootstrap / agent-context files that must never appear in a result or be committed.
const BOOTSTRAP_LEAK_PATTERNS = [
  /(^|\/)AGENTS\.md$/i,
  /(^|\/)SOUL\.md$/i,
  /(^|\/)\.openclaw(\/|$)/i,
  /(^|\/)\.env(\.|$)/i,
];

function isBootstrapLeakPath(path) {
  const p = safeText(path).trim();
  if (!p) return false;
  return BOOTSTRAP_LEAK_PATTERNS.some((re) => re.test(p));
}

// Intent detection from the handler-provided message text.
function isPatchIntent(message) {
  const text = safeText(message);
  return (
    /GitHub development assignment/i.test(text) ||
    /open a pull request/i.test(text) ||
    /"prUrl"/.test(text) ||
    /pr_opened/.test(text)
  );
}

function buildPatchPrompt(message) {
  const preamble = [
    "You are a Claude Code CLI-backed A2A GitHub PATCH bridge running on a non-Docker (Termux/proot) worker.",
    "HARD CONSTRAINTS (override anything to the contrary):",
    "- Emit JSON only as your final output. No markdown, no prose outside the JSON.",
    "- Operate ONLY within the current working directory; clone the target repo into this directory.",
    "- Use the already-authenticated `gh` and `git` CLIs to fetch/clone the repo and to open the pull request and post comments.",
    "- Do NOT touch, stage, or commit any file outside the cloned target repository.",
    "- Never print, stage, or commit secrets, tokens, `.env` files, or bootstrap/agent-context files (`.openclaw/`, `AGENTS.md`, `SOUL.md`).",
    "- If you cannot finish safely, post a Block comment on the issue and return its URL.",
    "At least one of prUrl, doneCommentUrl, or blockCommentUrl MUST be present in the returned JSON.",
    "",
    "----- BROKER TASK (authoritative instructions follow) -----",
  ].join("\n");
  return `${preamble}\n${message}`;
}

function runClaudePatch(prompt, flags, env, cwd) {
  const claudeBin = safeText(env.A2A_CLAUDE_CODE_BIN, safeText(env.CLAUDE_BIN, "claude"));
  const timeoutSec = positiveInteger(flags.timeout, positiveInteger(env.A2A_CLAUDE_CODE_TIMEOUT_SEC, 1800));
  const maxTurns = positiveInteger(env.A2A_CLAUDE_CODE_MAX_TURNS, 40);
  // NOTE: no --dangerously-skip-permissions: it is refused when running as root (the proot case).
  const args = [
    "-p", prompt,
    "--output-format", "json",
    "--allowedTools", "Bash Edit Write Read Glob Grep",
    "--max-turns", String(maxTurns),
  ];
  const child = spawnSync(claudeBin, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: positiveInteger(env.A2A_CLAUDE_CODE_MAX_OUTPUT_BYTES, 64 * 1024 * 1024),
    timeout: timeoutSec * 1000,
    killSignal: "SIGKILL",
  });
  if (child.error) throw new Error(`Claude Code spawn failed: ${child.error.message}`);
  if (child.status !== 0) {
    const signal = child.signal ? ` signal=${child.signal}` : "";
    throw new Error(`Claude Code exited with ${child.status}${signal}: ${safeText(child.stderr, child.stdout).slice(0, 4000)}`);
  }
  return child.stdout;
}

// Find the innermost object that carries at least one GitHub evidence URL.
function findGithubEvidenceObject(value, depth = 0) {
  if (depth > 10 || value === undefined || value === null) return null;
  if (Array.isArray(value)) {
    for (let i = value.length - 1; i >= 0; i -= 1) {
      const found = findGithubEvidenceObject(value[i], depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "string") {
    if (!value.trim()) return null;
    try {
      return findGithubEvidenceObject(parseJsonCandidate(value), depth + 1);
    } catch {
      return null;
    }
  }
  if (typeof value === "object") {
    // Recurse first so we prefer the innermost evidence object.
    for (const key of ["result", "content", "message", "text", "response", "output", "value", "payloads", "messages"]) {
      const found = findGithubEvidenceObject(value[key], depth + 1);
      if (found) return found;
    }
    const prUrl = safeText(value.prUrl || value.pullRequestUrl, "");
    const doneCommentUrl = safeText(value.doneCommentUrl || value.commentUrl, "");
    const blockCommentUrl = safeText(value.blockCommentUrl || value.blockerCommentUrl, "");
    if (prUrl || doneCommentUrl || blockCommentUrl) return value;
  }
  return null;
}

function normalizePatchResponse(obj) {
  const prUrl = safeText(obj.prUrl || obj.pullRequestUrl, "");
  const doneCommentUrl = safeText(obj.doneCommentUrl || obj.commentUrl, "");
  const blockCommentUrl = safeText(obj.blockCommentUrl || obj.blockerCommentUrl, "");
  const startCommentUrl = safeText(obj.startCommentUrl, "");
  const filesChanged = normalizeStringArray(obj.filesChanged);

  // Bootstrap-leak guard: if Claude reports bootstrap/agent-context files as changed,
  // do NOT pass evidence — treat the lane as blocked so the handler surfaces it.
  const leaked = filesChanged.filter(isBootstrapLeakPath);
  if (leaked.length > 0) {
    throw new Error(`patch blocked: bootstrap/agent-context files reported as changed (${leaked.join(", ")})`);
  }

  let statusRaw = safeText(obj.status, "").toLowerCase();
  if (!["pr_opened", "blocked", "done"].includes(statusRaw)) {
    if (prUrl) statusRaw = "pr_opened";
    else if (blockCommentUrl) statusRaw = "blocked";
    else statusRaw = "done";
  }

  const result = {
    status: statusRaw,
    summary: safeText(obj.summary, `GitHub patch ${statusRaw}`),
    tests: normalizeStringArray(obj.tests),
    filesChanged,
    risks: normalizeStringArray(obj.risks),
  };
  if (safeText(obj.branch, "")) result.branch = safeText(obj.branch);
  if (startCommentUrl) result.startCommentUrl = startCommentUrl;
  if (prUrl) result.prUrl = prUrl;
  if (doneCommentUrl) result.doneCommentUrl = doneCommentUrl;
  if (blockCommentUrl) result.blockCommentUrl = blockCommentUrl;

  if (!prUrl && !doneCommentUrl && !blockCommentUrl) {
    throw new Error("patch response missing prUrl, doneCommentUrl, or blockCommentUrl");
  }
  return result;
}

// ===========================================================================
// PATCH MODE — Deterministic Single-Shot Harness (aider pattern, fast path)
//
// Issue #1020: Restructure PATCH mode so the bridge owns git plumbing and
// claude is called ONCE (plus at most one corrective retry) to produce the
// edit/diff. This cuts agentic turns from ~15 to 1–2 on a non-Docker worker.
//
// Opt-in via env: A2A_CLAUDE_CODE_PATCH_MODE=single-shot
// Default (legacy/agentic) path below preserves the original 1019 behavior.
// ===========================================================================

const SINGLE_SHOT_PATCH_MARKER = "single-shot";

// Cheap shape-only detection: we only want a string of these values.
function isSingleShotPatchMode(env) {
  const raw = safeText(env.A2A_CLAUDE_CODE_PATCH_MODE, "").trim().toLowerCase();
  return raw === SINGLE_SHOT_PATCH_MARKER || raw === "single_shot" || raw === "singleshot";
}

// Extracts "owner/repo" and "#NNN" from the handler's prompt template lines.
// Tolerates Issue: <url> and Issue URL: <url> forms; returns empty strings on miss.
function parseTaskContext(message) {
  const text = safeText(message);
  const repoMatch = /Repository:\s*([^\s\n]+)/.exec(text);
  const issueHash = /Issue:\s*#(\d+)/.exec(text);
  const issueUrlBare = /Issue URL:\s*(\S+)/.exec(text);
  const issueUrlHash = /github\.com\/[^/\s]+\/[^/\s]+\/issues\/(\d+)/.exec(
    safeText(issueUrlBare && issueUrlBare[1], ""),
  );
  const issueNumber = issueHash
    ? issueHash[1]
    : issueUrlHash
      ? issueUrlHash[1]
      : "";
  return {
    repo: repoMatch ? safeText(repoMatch[1]).trim() : "",
    issueNumber,
  };
}

// Build a strict single-shot prompt: claude only returns a unified diff (aider style)
// plus an explicit NO_DIFF escape hatch. The bridge owns all git plumbing.
function buildSingleShotPrompt({ message, taskContext }) {
  return [
    "You are a Claude Code CLI-backed A2A GitHub PATCH bridge running on a non-Docker (Termux/proot) worker.",
    "DETERMINISTIC SINGLE-SHOT MODE: the bridge owns git plumbing (clone, branch, commit, push, PR).",
    "Your ONLY job is to produce a unified diff that fixes the issue.",
    "",
    "HARD CONSTRAINTS (override anything to the contrary):",
    "- Return ONLY a unified diff inside a single ```diff ... ``` fenced code block.",
    "- Do NOT include prose, JSON, shell commands, or any other output outside the fenced block.",
    "- The diff must apply cleanly with `git apply` against the repository's current main branch.",
    "- The target repository is checked out in your CURRENT working directory. Use the Read/Grep/Glob tools to inspect the actual file contents and produce correct paths, line numbers, and surrounding context. Do NOT edit files or run shell/git commands yourself; the bridge owns all git plumbing.",
    "- Touch only files inside the cloned target repository.",
    "- Never modify, create, or commit secrets, tokens, `.env` files, or bootstrap/agent-context files (`.openclaw/`, `AGENTS.md`, `SOUL.md`, `HEARTBEAT.md`, `IDENTITY.md`, `USER.md`, `TOOLS.md`).",
    "- If you cannot produce a safe diff, return a fenced block containing a single line: `NO_DIFF: <short reason>`.",
    "",
    "TASK CONTEXT (parsed by the bridge):",
    `Repository: ${safeText(taskContext.repo, "<unknown>")}`,
    taskContext.issueNumber ? `Issue: #${taskContext.issueNumber}` : "Issue: <unknown>",
    "",
    "----- BROKER TASK (authoritative instructions follow) -----",
    safeText(message),
  ].join("\n");
}

// Pulls the unified diff out of claude's stdout. Tries JSON-decoded string
// fields first (since `claude --output-format json` wraps the result in a JSON
// envelope), then falls back to scanning the raw text for fenced blocks or
// raw unified-diff anchors.
function extractUnifiedDiff(stdout) {
  const text = safeText(stdout);

  // 1. Try to JSON-decode the whole envelope (or pull the last balanced object)
  //    and recursively search its string fields for a fenced diff block.
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    const candidates = extractBalancedJsonObjects(text);
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      try {
        parsed = JSON.parse(candidates[i]);
        break;
      } catch {
        // keep scanning
      }
    }
  }
  if (parsed !== null) {
    const fromJson = findDiffInObject(parsed);
    if (fromJson) return fromJson;
  }

  // 2. Fall back to scanning the raw text.
  return extractDiffFromRawText(text);
}

// Walks a parsed JSON value looking for the first string that contains a
// parseable diff block. Searches likely-named fields first (result, text, ...).
function findDiffInObject(value, depth = 0) {
  if (depth > 8 || value === undefined || value === null) return null;
  if (typeof value === "string") {
    return extractDiffFromRawText(value);
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findDiffInObject(entry, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const key of ["result", "text", "content", "message", "response", "output", "value", "diff"]) {
      const found = findDiffInObject(value[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// Scans a single string for a fenced diff block (latest wins) or raw unified-diff
// anchors. Returns { kind, body } or null.
function extractDiffFromRawText(text) {
  if (!text) return null;
  // Fenced diff/patch blocks (latest wins, matches a single-fenced-prompt contract).
  // We accept an optional newline OR literal `\n` (some emiters JSON-encape newlines).
  const fenceRegex = /```(?:diff|patch|unified)?[ \t]*(?:\r?\n|\\n)([\s\S]+?)(?:\r?\n|\\n)?```/g;
  let match;
  let fenced = null;
  while ((match = fenceRegex.exec(text)) !== null) {
    fenced = match[1];
  }
  if (fenced) {
    const trimmedFence = fenced.trim();
    if (/^(?:NO_DIFF:|\s*NO_DIFF:)/.test(trimmedFence)) {
      return { kind: "no_diff", body: trimmedFence };
    }
    if (/^(--- |\+\+\+ |diff --git |@@ )/m.test(fenced)) {
      return { kind: "diff", body: fenced };
    }
  }
  // Raw diff scan in case the model emits plain unified-diff lines.
  const lines = text.split(/\r?\n/);
  const startIdx = lines.findIndex(
    (l) => l.startsWith("diff --git ") || l.startsWith("--- a/"),
  );
  if (startIdx < 0) return { kind: "no_diff", body: "no diff block found in claude output" };
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith("diff --git ")) { endIdx = i; break; }
  }
  const body = lines.slice(startIdx, endIdx).join("\n");
  if (!/^(--- |\+\+\+ |@@ )/m.test(body)) {
    return { kind: "no_diff", body: "diff-like text present but no parseable unified-diff hunks" };
  }
  return { kind: "diff", body };
}

// Resolves a CLI binary path. Env override > default; lets tests stub git/gh.
function resolveTool(env, envName, fallback) {
  return safeText(env[envName], fallback);
}

// Runs a tool via spawnSync and returns {status, signal, stdout, stderr, error}.
function runTool(bin, args, { cwd, env, timeoutMs, maxBufferBytes }) {
  return spawnSync(bin, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: maxBufferBytes,
  });
}

function toolError(tool, label, result) {
  if (result.error) {
    return new Error(`${tool} ${label} spawn failed: ${result.error.message}`);
  }
  const signal = result.signal ? ` signal=${result.signal}` : "";
  const detail = safeText(result.stderr, result.stdout).slice(0, 4000);
  return new Error(`${tool} ${label} exited with ${result.status ?? "?"}${signal}: ${detail}`);
}

// Validates a diff with `git apply --check` (does not touch the working tree).
function checkDiff(workspace, diffPath, env) {
  const git = resolveTool(env, "A2A_CLAUDE_CODE_GIT_BIN", "git");
  const res = runTool(git, ["apply", "--check", diffPath], {
    cwd: workspace,
    env,
    timeoutMs: 60_000,
    maxBufferBytes: 4 * 1024 * 1024,
  });
  if (res.status === 0) return { ok: true };
  return { ok: false, error: safeText(res.stderr, res.stdout).slice(0, 4000) };
}

// Actually applies the diff (after --check passed).
function applyDiff(workspace, diffPath, env) {
  const git = resolveTool(env, "A2A_CLAUDE_CODE_GIT_BIN", "git");
  const res = runTool(git, ["apply", diffPath], {
    cwd: workspace,
    env,
    timeoutMs: 60_000,
    maxBufferBytes: 4 * 1024 * 1024,
  });
  if (res.status === 0) return { ok: true };
  return { ok: false, error: safeText(res.stderr, res.stdout).slice(0, 4000) };
}

// Captures the list of modified/new files (post-apply) so the bootstrap-leak guard
// can refuse any attempt to slip agent-context files into the diff.
function listWorkingTreeChanges(workspace, env) {
  const git = resolveTool(env, "A2A_CLAUDE_CODE_GIT_BIN", "git");
  // `git status --porcelain` after `git add -N .` reports intent-to-add and modifications.
  const intent = runTool(git, ["add", "--intent-to-add", "."], {
    cwd: workspace,
    env,
    timeoutMs: 30_000,
    maxBufferBytes: 4 * 1024 * 1024,
  });
  if (intent.status !== 0) return [];
  const res = runTool(git, ["status", "--porcelain"], {
    cwd: workspace,
    env,
    timeoutMs: 30_000,
    maxBufferBytes: 4 * 1024 * 1024,
  });
  if (res.status !== 0) return [];
  return safeText(res.stdout)
    .split(/\r?\n/)
    .map((line) => line.replace(/^..\s+/, "").trim())
    .filter(Boolean);
}

// Deterministic commit + push + PR plumbing. Each step is a separate process so a
// failure points at the failing step instead of returning a generic non-zero.
function commitPushAndCreatePr(workspace, { branch, commitMessage, title, body, env }) {
  const git = resolveTool(env, "A2A_CLAUDE_CODE_GIT_BIN", "git");
  const gh = resolveTool(env, "A2A_CLAUDE_CODE_GH_BIN", "gh");

  const add = runTool(git, ["add", "-A"], { cwd: workspace, env, timeoutMs: 30_000, maxBufferBytes: 4 * 1024 * 1024 });
  if (add.status !== 0) return { ok: false, error: toolError("git add", "-A", add).message };

  const commit = runTool(git, ["commit", "-m", commitMessage], { cwd: workspace, env, timeoutMs: 60_000, maxBufferBytes: 4 * 1024 * 1024 });
  if (commit.status !== 0) return { ok: false, error: toolError("git commit", "<msg>", commit).message };

  const push = runTool(git, ["push", "origin", `HEAD:${branch}`], { cwd: workspace, env, timeoutMs: 120_000, maxBufferBytes: 8 * 1024 * 1024 });
  if (push.status !== 0) return { ok: false, error: toolError("git push", `<branch=${branch}>`, push).message };

  const pr = runTool(gh, ["pr", "create", "--base", "main", "--head", branch, "--title", title, "--body", body], {
    cwd: workspace,
    env,
    timeoutMs: 120_000,
    maxBufferBytes: 8 * 1024 * 1024,
  });
  if (pr.status !== 0) return { ok: false, error: toolError("gh pr create", "", pr).message };

  const prUrlMatch = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/.exec(safeText(pr.stdout));
  return { ok: true, prUrl: prUrlMatch ? prUrlMatch[0] : "" };
}

// Clones the target repo into `cloneDir` using the env-overridable git binary.
// Always sets a non-default branch name to avoid clobbering the local main.
function cloneTargetRepo({ repo, cloneDir, branch, env }) {
  const git = resolveTool(env, "A2A_CLAUDE_CODE_GIT_BIN", "git");
  const gh = resolveTool(env, "A2A_CLAUDE_CODE_GH_BIN", "gh");
  // Prefer `gh repo clone` (uses the worker's authenticated gh token); fall back to
  // `git clone` so the bridge still works on a host with git-only access.
  const attempts = [
    { bin: gh, args: ["repo", "clone", repo, cloneDir, "--", "--branch", "main"] },
    { bin: git, args: ["clone", "--depth=1", "--branch", "main", `https://github.com/${repo}.git`, cloneDir] },
  ];
  const failures = [];
  for (const attempt of attempts) {
    const res = runTool(attempt.bin, attempt.args, {
      cwd: tmpdir(),
      env,
      timeoutMs: 180_000,
      maxBufferBytes: 16 * 1024 * 1024,
    });
    if (res.status === 0) return { ok: true };
    failures.push(`${attempt.bin} ${attempt.args.join(" ")}: ${safeText(res.stderr, res.stdout).slice(0, 1000)}`);
  }
  return { ok: false, error: `clone failed for ${repo}: ${failures.join(" | ")}` };
}

// Creates a uniquely named branch inside the cloned repo.
function createBranch({ cloneDir, branch, env }) {
  const git = resolveTool(env, "A2A_CLAUDE_CODE_GIT_BIN", "git");
  const res = runTool(git, ["checkout", "-b", branch], {
    cwd: cloneDir,
    env,
    timeoutMs: 30_000,
    maxBufferBytes: 4 * 1024 * 1024,
  });
  if (res.status !== 0) return { ok: false, error: toolError("git checkout", "-b <branch>", res).message };
  return { ok: true };
}

// Single claude call (one model round-trip). Strict format, read-only-ish prompt:
// Single claude invocation with a small READ-ONLY tool budget so it can inspect
// the checked-out repo (cwd is the clone) and emit a diff whose paths/line
// context `git apply` accepts. A no-tool call makes claude guess context (the
// diff fails to apply); a tool-enabled call capped at max-turns 1 aborts mid
// tool_use (error_max_turns). A few read-only turns is still "single-shot": the
// bridge — not an agentic loop — owns all git plumbing.
function callClaudeOnce(prompt, flags, env, cwd) {
  const claudeBin = safeText(env.A2A_CLAUDE_CODE_BIN, safeText(env.CLAUDE_BIN, "claude"));
  const timeoutSec = positiveInteger(flags.timeout, positiveInteger(env.A2A_CLAUDE_CODE_TIMEOUT_SEC, 300));
  const maxTurns = positiveInteger(env.A2A_CLAUDE_CODE_PATCH_MAX_TURNS, 6);
  const args = [
    "-p", prompt,
    "--output-format", "json",
    "--max-turns", String(maxTurns),
    "--tools", "Read Grep Glob",
  ];
  const child = spawnSync(claudeBin, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: positiveInteger(env.A2A_CLAUDE_CODE_MAX_OUTPUT_BYTES, 16 * 1024 * 1024),
    timeout: timeoutSec * 1000,
    killSignal: "SIGKILL",
  });
  if (child.error) throw new Error(`Claude Code spawn failed: ${child.error.message}`);
  if (child.status !== 0) {
    const signal = child.signal ? ` signal=${child.signal}` : "";
    throw new Error(`Claude Code exited with ${child.status}${signal}: ${safeText(child.stderr, child.stdout).slice(0, 4000)}`);
  }
  return child.stdout;
}

// Corrective retry: feed the previous error back into the model with a tight prompt.
// Capped at 1 retry (2 total claude calls) per the issue's 1–2-turn budget.
function callClaudeCorrective(prompt, previousError, flags, env, cwd) {
  const claudeBin = safeText(env.A2A_CLAUDE_CODE_BIN, safeText(env.CLAUDE_BIN, "claude"));
  const timeoutSec = positiveInteger(flags.timeout, positiveInteger(env.A2A_CLAUDE_CODE_TIMEOUT_SEC, 300));
  const retryPrompt = [
    "Your previous diff failed to apply with `git apply --check`.",
    "Produce a SINGLE corrected unified diff in a ```diff ... ``` fenced code block that applies cleanly.",
    "Do not include prose, JSON, or any output outside the fenced block.",
    "Previous error:",
    redactSecrets(safeText(previousError, "<no error captured>")).slice(0, 2000),
    "",
    "Original task:",
    safeText(prompt),
  ].join("\n");
  const maxTurns = positiveInteger(env.A2A_CLAUDE_CODE_PATCH_MAX_TURNS, 6);
  const args = [
    "-p", retryPrompt,
    "--output-format", "json",
    "--max-turns", String(maxTurns),
    "--tools", "Read Grep Glob",
  ];
  const child = spawnSync(claudeBin, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: positiveInteger(env.A2A_CLAUDE_CODE_MAX_OUTPUT_BYTES, 16 * 1024 * 1024),
    timeout: timeoutSec * 1000,
    killSignal: "SIGKILL",
  });
  if (child.error) throw new Error(`Claude Code corrective spawn failed: ${child.error.message}`);
  if (child.status !== 0) {
    const signal = child.signal ? ` signal=${child.signal}` : "";
    throw new Error(`Claude Code corrective exited with ${child.status}${signal}: ${safeText(child.stderr, child.stdout).slice(0, 4000)}`);
  }
  return child.stdout;
}

function runSingleShotPatchMode(message, flags) {
  const env = process.env;
  const taskContext = parseTaskContext(message);
  if (!taskContext.repo) {
    process.stderr.write("single-shot patch mode requires Repository: <owner/repo> in the task message\n");
    process.exit(1);
  }

  const workspace = mkdtempSync(join(tmpdir(), "a2a-patch-"));
  const cloneDir = join(workspace, "repo");
  const branch = `a2a/single-shot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  let exitCode = 0;
  let envelope = null;

  try {
    const cloned = cloneTargetRepo({ repo: taskContext.repo, cloneDir, branch, env });
    if (!cloned.ok) {
      throw new Error(cloned.error);
    }

    const branched = createBranch({ cloneDir, branch, env });
    if (!branched.ok) {
      throw new Error(branched.error);
    }

    const prompt = buildSingleShotPrompt({ message, taskContext });

    // First (and primary) claude call. Run inside the clone so the read-only
    // tools see the actual repo and the emitted diff has correct line context.
    const firstStdout = callClaudeOnce(prompt, flags, env, cloneDir);
    let extracted = extractUnifiedDiff(firstStdout);
    let claudeCalls = 1;

    if (extracted.kind === "no_diff") {
      throw new Error(`claude returned no diff: ${redactSecrets(safeText(extracted.body, "<empty>")).slice(0, 1000)}`);
    }

    // Write the diff to a file inside the workspace and try `git apply --check`.
    // We append a trailing newline because some emitters drop the final EOL and
    // `git apply` rejects patches whose last hunk line is not newline-terminated.
    const diffPath = join(workspace, "patch.diff");
    writeFileSync(diffPath, extracted.body.endsWith("\n") ? extracted.body : `${extracted.body}\n`);

    let checked = checkDiff(cloneDir, diffPath, env);
    if (!checked.ok) {
      // One corrective retry (2nd and final claude call). The original prompt goes
      // back in so the model has full context for the fix.
      const correctiveStdout = callClaudeCorrective(prompt, checked.error, flags, env, cloneDir);
      claudeCalls = 2;
      extracted = extractUnifiedDiff(correctiveStdout);
      if (extracted.kind === "no_diff") {
        throw new Error(`claude corrective retry returned no diff: ${redactSecrets(safeText(extracted.body, "<empty>")).slice(0, 1000)}`);
      }
      writeFileSync(diffPath, extracted.body.endsWith("\n") ? extracted.body : `${extracted.body}\n`);
      checked = checkDiff(cloneDir, diffPath, env);
      if (!checked.ok) {
        throw new Error(`git apply --check failed after corrective retry: ${redactSecrets(safeText(checked.error, "<empty>")).slice(0, 1000)}`);
      }
    }

    // Apply the validated diff. `git apply` only mutates the working tree; commit comes next.
    const applied = applyDiff(cloneDir, diffPath, env);
    if (!applied.ok) {
      throw new Error(`git apply failed: ${redactSecrets(safeText(applied.error, "<empty>")).slice(0, 1000)}`);
    }

    // Bootstrap-leak guard: refuse to commit any diff that touches agent-context files.
    // This is the single-shot equivalent of the agentic path's `filesChanged` filter.
    const filesChanged = listWorkingTreeChanges(cloneDir, env);
    const leaked = filesChanged.filter(isBootstrapLeakPath);
    if (leaked.length > 0) {
      throw new Error(`patch blocked: bootstrap/agent-context files reported as changed (${leaked.join(", ")})`);
    }

    // Deterministic commit + push + PR. All step failures surface the failing step.
    const issueLabel = taskContext.issueNumber ? `#${taskContext.issueNumber}` : "patch";
    const commitMessage = `a2a(single-shot): ${issueLabel}`;
    const prTitle = taskContext.issueNumber
      ? `a2a(single-shot): patch for #${taskContext.issueNumber}`
      : "a2a(single-shot): patch";
    const prBody = [
      taskContext.issueNumber ? `Closes #${taskContext.issueNumber}` : "A2A single-shot patch.",
      "",
      "Generated by the deterministic single-shot harness in claude-a2a-patch-bridge.mjs.",
      `Claude calls: ${claudeCalls}`,
      "",
      "Files changed:",
      ...filesChanged.map((f) => `- \`${f}\``),
    ].join("\n");

    const pr = commitPushAndCreatePr(cloneDir, {
      branch,
      commitMessage,
      title: prTitle,
      body: prBody,
      env,
    });
    if (!pr.ok) {
      throw new Error(pr.error);
    }
    if (!pr.prUrl) {
      throw new Error("gh pr create succeeded but produced no parseable prUrl");
    }

    const result = {
      status: "pr_opened",
      summary: `single-shot patch opened ${pr.prUrl} (${claudeCalls} claude call${claudeCalls === 1 ? "" : "s"})`,
      branch,
      prUrl: pr.prUrl,
      tests: [],
      filesChanged,
      risks: [],
      claudeCalls,
    };
    envelope = JSON.stringify({ payloads: [{ text: JSON.stringify(result) }] });
  } catch (error) {
    process.stderr.write(`${redactSecrets(safeText(error.message, "Claude Code patch bridge failed"))}\n`);
    exitCode = 1;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }

  if (envelope !== null) {
    process.stdout.write(envelope);
  }
  process.exit(exitCode);
}

function runPatchMode(message, flags) {
  if (isSingleShotPatchMode(process.env)) {
    runSingleShotPatchMode(message, flags);
    return;
  }
  const workspace = mkdtempSync(join(tmpdir(), "a2a-patch-"));
  let exitCode = 0;
  let envelope = null;
  try {
    const prompt = buildPatchPrompt(message);
    const stdout = runClaudePatch(prompt, flags, process.env, workspace);

    let outer;
    try {
      outer = parseJsonCandidate(stdout);
    } catch {
      outer = stdout;
    }
    const evidenceObj = findGithubEvidenceObject(outer);
    if (!evidenceObj) {
      throw new Error("Claude patch output missing GitHub evidence (prUrl/doneCommentUrl/blockCommentUrl)");
    }
    const result = normalizePatchResponse(evidenceObj);
    envelope = JSON.stringify({ payloads: [{ text: JSON.stringify(result) }] });
  } catch (error) {
    // Non-zero exit so the handler surfaces openclaw_bridge_evidence_missing / failure.
    process.stderr.write(`${redactSecrets(safeText(error.message, "Claude Code patch bridge failed"))}\n`);
    exitCode = 1;
  } finally {
    // Always clean up the isolated workspace, even on error/timeout.
    rmSync(workspace, { recursive: true, force: true });
  }

  if (envelope !== null) {
    process.stdout.write(envelope);
  }
  process.exit(exitCode);
}

// ===========================================================================
// Entry point
// ===========================================================================

function main() {
  const flags = parseArgs(process.argv);
  if (flags.subcommand !== "agent") die("expected OpenClaw-shaped subcommand: agent");
  if (!flags.json) die("expected --json flag");
  const message = safeText(flags.message, "");
  if (!message) die("missing --message");

  if (isPatchIntent(message)) {
    runPatchMode(message, flags);
    return;
  }
  runAnalysisMode(message, flags);
}

main();
