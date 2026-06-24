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
import { mkdtempSync, rmSync } from "node:fs";
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

function runPatchMode(message, flags) {
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
