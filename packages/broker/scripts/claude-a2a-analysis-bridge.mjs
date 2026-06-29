#!/usr/bin/env node
import { spawnSync } from "node:child_process";

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

const ANALYSIS_ALLOWED_TOOLS = "Read Glob Grep";
const ANALYSIS_DISALLOWED_TOOLS = "Bash Edit Write MultiEdit NotebookEdit WebFetch WebSearch";

function buildReadOnlyClaudeArgs(prompt, maxTurns) {
  return [
    "-p", prompt,
    "--output-format", "json",
    "--max-turns", String(maxTurns),
    "--allowedTools", ANALYSIS_ALLOWED_TOOLS,
    "--disallowedTools", ANALYSIS_DISALLOWED_TOOLS,
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

function runClaude(prompt, flags, env = process.env) {
  const claudeBin = safeText(env.A2A_CLAUDE_CODE_BIN, safeText(env.CLAUDE_BIN, "claude"));
  const timeoutSec = positiveInteger(flags.timeout, positiveInteger(env.A2A_CLAUDE_CODE_TIMEOUT_SEC, 600));
  const maxTurns = positiveInteger(env.A2A_CLAUDE_CODE_MAX_TURNS, 10);
  const args = buildReadOnlyClaudeArgs(prompt, maxTurns);
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

function main() {
  const flags = parseArgs(process.argv);
  if (flags.subcommand !== "agent") die("expected OpenClaw-shaped subcommand: agent");
  if (!flags.json) die("expected --json flag");
  const message = safeText(flags.message, "");
  if (!message) die("missing --message");

  const prompt = buildClaudePrompt({ message, flags });
  let stdout;
  try {
    stdout = runClaude(prompt, flags, process.env);
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
