#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_FINALIZER_ALLOWED_TOOLS,
  CLAUDE_FINALIZER_DISALLOWED_TOOLS,
  buildClaudeFinalizerToolArgs,
} from "./finalizer-tool-policy.mjs";

// ---------------------------------------------------------------------------
// Process-tree timeout / session-isolation hardening (issue #1129)
// ---------------------------------------------------------------------------

// Kill an entire process group. On Linux, a negative pid sends the signal to
// every process in the process group whose PGID is |pid|. The child must have
// been spawned with { detached: true } for its own process group to exist.
function killProcessGroup(pid, signal = "SIGKILL") {
  try {
    process.kill(-pid, signal);
  } catch {
    // Process group may already be gone; that's safe.
  }
}

// Spawn a child with its own process group (detached) and a hard timeout.
// When the timeout fires, the ENTIRE process group is killed — first SIGTERM
// (2 s grace), then SIGKILL — so no orphaned grandchildren outlive the bridge.
// Returns the same shape as spawnSync: { status, signal, stdout, stderr, error }.
function spawnWithProcessGroupKill(bin, args, opts) {
  const timeoutMs = opts.timeout;
  const child = spawn(bin, args, { ...opts, detached: true, timeout: undefined });

  let stdout = "";
  let stderr = "";
  let killedByTimeout = false;
  let timer = null;

  return new Promise((resolve) => {
    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        if (stdout.length < (opts.maxBuffer ?? 8 * 1024 * 1024)) stdout += chunk;
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        if (stderr.length < (opts.maxBuffer ?? 8 * 1024 * 1024)) stderr += chunk;
      });
    }

    function finish(status, signal, error) {
      if (timer) { clearTimeout(timer); timer = null; }
      // If the child process group might still have survivors, nuke it.
      if (child.pid && !killedByTimeout) {
        killProcessGroup(child.pid, "SIGKILL");
      }
      resolve({ status: status ?? null, signal, stdout, stderr, error: error ?? null });
    }

    child.on("error", (err) => finish(null, null, err));
    child.on("close", (code, sig) => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (killedByTimeout) {
        // We already resolved inside the timeout handler.
        return;
      }
      resolve({ status: code, signal: sig ?? null, stdout, stderr, error: null });
    });

    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        killedByTimeout = true;
        if (child.pid) {
          killProcessGroup(child.pid, "SIGTERM");
          setTimeout(() => killProcessGroup(child.pid, "SIGKILL"), 2000);
        }
        // Don't wait for close; resolve immediately with a synthetic timeout error.
        finish(null, "SIGKILL", new Error(`spawn timed out after ${timeoutMs} ms`));
      }, timeoutMs);
    }
  });
}

function safeText(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function redactSecrets(value) {
  return safeText(value)
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, "[redacted-token]")
    .replace(/\b(Authorization\s*[:=]\s*Bearer\s+)[^\s"']+/gi, "$1[redacted]")
    .replace(/\b(BROKER_EDGE_SECRET|A2A_EDGE_SECRET|EDGE_SECRET|TOKEN|SECRET|API[_-]?KEY|PASSWORD)=\S+/gi, "$1=[redacted]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted-secret-like]");
}

const SAFE_CHILD_ENV_KEYS = new Set([
  "HOME",
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "TEMP",
  "TMP",
  "USER",
  "LOGNAME",
  "SHELL",
  "SSH_AUTH_SOCK",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "DISABLE_AUTOUPDATER",
]);

function buildClaudeChildEnv(env = process.env) {
  const child = {};
  for (const [key, value] of Object.entries(env)) {
    if (SAFE_CHILD_ENV_KEYS.has(key) || key.startsWith("CAPTURE_") || key.startsWith("GRANDCHILD_")) {
      child[key] = value;
    }
  }
  if (!child.PATH && env.PATH) child.PATH = env.PATH;
  if (!child.HOME && env.HOME) child.HOME = env.HOME;
  return child;
}

const ANALYSIS_ALLOWED_TOOLS = CLAUDE_FINALIZER_ALLOWED_TOOLS;
const ANALYSIS_DISALLOWED_TOOLS = CLAUDE_FINALIZER_DISALLOWED_TOOLS;
const ANALYSIS_BRIDGE_CONTRACT_VERSION = "claude-a2a-analysis.v1";

function buildReadOnlyClaudeArgs(prompt, maxTurns) {
  return [
    "-p", prompt,
    "--output-format", "json",
    "--max-turns", String(maxTurns),
    ...buildClaudeFinalizerToolArgs(),
  ];
}

function die(message) {
  process.stderr.write(`${redactSecrets(safeText(message, "Claude Code analysis bridge failed"))}\n`);
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

function normalizeResponse(parsed) {
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

function attachClaudeModelTelemetry(response, flags, env = process.env) {
  const requestedModel = safeText(flags.model, "");
  const requestedThinking = safeText(flags.thinking, "");
  const configuredRuntimeModel = safeText(
    env.A2A_CLAUDE_CODE_RUNTIME_MODEL || env.CLAUDE_CODE_MODEL || env.ANTHROPIC_MODEL,
    "",
  );
  return {
    ...response,
    bridgeAdapter: "claude_code",
    bridgeContractVersion: ANALYSIS_BRIDGE_CONTRACT_VERSION,
    requestedModel: requestedModel || undefined,
    requestedThinking: requestedThinking || undefined,
    actualRuntimeModel: configuredRuntimeModel || undefined,
    modelInheritanceMode: "metadata_only",
    claudeModelArgumentApplied: false,
    modelInheritanceNote:
      "Claude Code bridge preserves the A2A requested/effective worker model in prompt/result telemetry but does not pass it as a Claude CLI --model argument.",
  };
}

function buildClaudePrompt({ message, flags }) {
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

async function runClaude(prompt, flags, env = process.env) {
  const claudeBin = safeText(env.A2A_CLAUDE_CODE_BIN, safeText(env.CLAUDE_BIN, "claude"));
  const timeoutSec = positiveInteger(flags.timeout, positiveInteger(env.A2A_CLAUDE_CODE_TIMEOUT_SEC, 600));
  const maxTurns = positiveInteger(env.A2A_CLAUDE_CODE_MAX_TURNS, 10);
  const maxBuffer = positiveInteger(env.A2A_CLAUDE_CODE_MAX_OUTPUT_BYTES, 8 * 1024 * 1024);
  const sessionId = safeText(flags["session-id"], "default");

  // Session-scoped isolation (#1129): each task session gets its own temp dir
  // so that any file artifacts (logs, tool outputs) stay confined.
  const sessionWorkspace = mkdtempSync(join(tmpdir(), `a2a-analysis-${sanitizeSessionSegment(sessionId)}-`));

  try {
    const args = buildReadOnlyClaudeArgs(prompt, maxTurns);
    const child = await spawnWithProcessGroupKill(claudeBin, args, {
      env: buildClaudeChildEnv(env),
      cwd: sessionWorkspace,
      encoding: "utf8",
      maxBuffer,
      timeout: timeoutSec * 1000,
    });
    if (child.error) throw new Error(`Claude Code spawn failed: ${child.error.message}`);
    if (child.status !== 0) {
      const signal = child.signal ? ` signal=${child.signal}` : "";
      throw new Error(`Claude Code exited with ${child.status}${signal}: ${safeText(child.stderr, child.stdout).slice(0, 4000)}`);
    }
    return child.stdout;
  } finally {
    rmSync(sessionWorkspace, { recursive: true, force: true });
  }
}

// Sanitize the session id into a safe directory segment (alphanumeric + hyphens).
function sanitizeSessionSegment(id) {
  return safeText(id).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64) || "default";
}

async function main() {
  const flags = parseArgs(process.argv);
  if (flags.subcommand !== "agent") die("expected OpenClaw-shaped subcommand: agent");
  if (!flags.json) die("expected --json flag");
  const message = safeText(flags.message, "");
  if (!message) die("missing --message");

  const prompt = buildClaudePrompt({ message, flags });
  let stdout;
  try {
    stdout = await runClaude(prompt, flags, process.env);
  } catch (error) {
    die(error.message);
  }

  let response;
  try {
    response = attachClaudeModelTelemetry(normalizeResponse(extractAnalysisJsonFromClaudeOutput(stdout)), flags, process.env);
  } catch (error) {
    die(error.message);
  }

  process.stdout.write(JSON.stringify({ payloads: [{ text: JSON.stringify(response) }] }));
}

main();
