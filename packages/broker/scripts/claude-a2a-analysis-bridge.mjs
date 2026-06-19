#!/usr/bin/env node
import { spawnSync } from "node:child_process";

function safeText(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function die(message) {
  process.stderr.write(`${safeText(message, "Claude Code analysis bridge failed")}\n`);
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

function extractAnalysisJsonFromClaudeOutput(stdout) {
  const outer = parseJsonCandidate(stdout);
  if (hasExplicitAnalysisJsonShape(outer)) return outer;

  const possiblePayloads = [
    outer?.result,
    outer?.content,
    outer?.message,
    outer?.text,
    outer?.response,
    outer?.output,
  ];

  for (const candidate of possiblePayloads) {
    if (hasExplicitAnalysisJsonShape(candidate)) return candidate;
    if (Array.isArray(candidate)) {
      const joined = candidate
        .map((entry) => {
          if (typeof entry === "string") return entry;
          if (entry && typeof entry === "object") return safeText(entry.text ?? entry.content ?? entry.value, "");
          return "";
        })
        .join("\n");
      if (joined.trim()) {
        const parsed = parseJsonCandidate(joined);
        if (hasExplicitAnalysisJsonShape(parsed)) return parsed;
      }
    }
    if (typeof candidate === "string" && candidate.trim()) {
      const parsed = parseJsonCandidate(candidate);
      if (hasExplicitAnalysisJsonShape(parsed)) return parsed;
    }
  }

  // Last resort: scan the full stdout for the last explicit analysis-shaped JSON.
  const candidates = extractBalancedJsonObjects(safeText(stdout));
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(candidates[i]);
      if (hasExplicitAnalysisJsonShape(parsed)) return parsed;
    } catch {
      // keep scanning
    }
  }

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
    recoverySource: "direct_stdout",
    ...(safeText(parsed.doneCommentUrl, "") ? { doneCommentUrl: safeText(parsed.doneCommentUrl) } : {}),
    ...(safeText(parsed.blockCommentUrl, "") ? { blockCommentUrl: safeText(parsed.blockCommentUrl) } : {}),
    ...(safeText(parsed.startCommentUrl, "") ? { startCommentUrl: safeText(parsed.startCommentUrl) } : {}),
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
    response = normalizeResponse(extractAnalysisJsonFromClaudeOutput(stdout));
  } catch (error) {
    die(error.message);
  }

  process.stdout.write(JSON.stringify({ payloads: [{ text: JSON.stringify(response) }] }));
}

main();
