#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

const DEFAULT_TIMEOUT_SEC = 300;
const DEFAULT_MAX_FILES = 16;
const DEFAULT_MAX_FILE_BYTES = 24 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 160 * 1024;
const DEFAULT_TREE_ENTRIES = 80;
const DEFAULT_HERMES_MAX_ATTEMPTS = 2;
// Linux caps each argv string at 128 KiB (MAX_ARG_STRLEN) even when ARG_MAX is
// larger. Hermes currently accepts one-shot prompts via `hermes chat -q`, so the
// bridge must keep that single query argument below the OS per-argument limit.
const DEFAULT_MAX_PROMPT_BYTES = 96 * 1024;

function die(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function safeText(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const subcommand = args.shift();
  const flags = { subcommand };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      flags._ = [...(flags._ || []), arg];
      continue;
    }
    const key = arg.slice(2);
    if (["local", "json"].includes(key)) {
      flags[key] = true;
      continue;
    }
    if (i + 1 >= args.length) die(`missing value for --${key}`);
    flags[key] = args[++i];
  }
  return flags;
}

function parseJsonObject(text, label = "JSON") {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${label} must be an object`);
    }
    return parsed;
  } catch (error) {
    throw new Error(`invalid ${label}: ${error.message}`);
  }
}

function extractBalancedJson(text, startIndex) {
  const first = text.slice(startIndex).search(/[\[{]/);
  if (first < 0) return "";
  const absoluteStart = startIndex + first;
  const opener = text[absoluteStart];
  const closer = opener === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = absoluteStart; i < text.length; i += 1) {
    const char = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === "\\") {
      escape = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === opener) depth += 1;
    if (char === closer) {
      depth -= 1;
      if (depth === 0) return text.slice(absoluteStart, i + 1);
    }
  }
  return "";
}

function extractPayload(message) {
  const marker = /Payload JSON\s*:/i.exec(message);
  if (!marker) return {};
  const jsonText = extractBalancedJson(message, marker.index + marker[0].length);
  if (!jsonText) return {};
  try {
    return parseJsonObject(jsonText, "Payload JSON");
  } catch (error) {
    throw new Error(`could not parse task Payload JSON: ${error.message}`);
  }
}

function parseRepoMap(env) {
  const raw = safeText(env.A2A_ANALYSIS_REPO_MAP_JSON || env.A2A_HERMES_ANALYSIS_REPO_MAP_JSON, "");
  const map = new Map();
  if (raw) {
    const parsed = parseJsonObject(raw, "A2A_ANALYSIS_REPO_MAP_JSON");
    for (const [repo, path] of Object.entries(parsed)) {
      if (typeof path === "string" && path.trim()) map.set(repo, resolve(path));
    }
  }
  const defaultRoot = safeText(env.A2A_ANALYSIS_REPO_ROOT || env.A2A_HERMES_ANALYSIS_REPO_ROOT, "");
  if (defaultRoot) map.set("__default__", resolve(defaultRoot));
  return map;
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) return [value];
  return [];
}

function collectRepos(payload) {
  const repos = [];
  for (const value of toArray(payload.repo)) repos.push({ name: value });
  for (const value of toArray(payload.repository)) repos.push({ name: value });
  for (const value of toArray(payload.repos)) {
    if (typeof value === "string") repos.push({ name: value });
    else if (value && typeof value === "object") repos.push({ name: safeText(value.repo || value.repository || value.name), spec: value });
  }
  for (const ref of toArray(payload.evidenceRefs)) {
    const repo = repoFromEvidenceRef(ref);
    if (repo) repos.push({ name: repo });
  }
  return repos.filter((item, index, arr) => item.name && arr.findIndex((other) => other.name === item.name) === index);
}

function repoFromEvidenceRef(ref) {
  const text = safeText(ref, "");
  if (!text) return "";

  const explicit = /^repo:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/.exec(text);
  if (explicit) return explicit[1];

  const github = /github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:[\/#?]|$)/.exec(text);
  if (github) return github[1];

  const pathScoped = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+):[^\s]+/.exec(text);
  if (pathScoped) return pathScoped[1];

  return "";
}

function collectPathValues(source) {
  const keys = [
    "path", "paths", "file", "files", "sourcePath", "sourcePaths", "analysisPath", "analysisPaths",
    "targetPath", "targetPaths", "targetFile", "targetFiles", "evidencePath", "evidencePaths",
    "readOnlyPath", "readOnlyPaths", "codePath", "codePaths",
  ];
  const paths = [];
  for (const key of keys) {
    for (const item of toArray(source?.[key])) {
      if (typeof item === "string") paths.push(item);
      else if (item && typeof item === "object") {
        const nested = safeText(item.path || item.file || item.name, "");
        if (nested) paths.push(nested);
      }
    }
  }
  return paths;
}

function isSafeRelativePath(candidate) {
  if (!candidate || typeof candidate !== "string") return false;
  if (candidate.includes("\0")) return false;
  if (isAbsolute(candidate)) return false;
  const normalized = candidate.replace(/\\/g, "/");
  return !normalized.split("/").some((part) => part === "..") && normalized !== ".";
}

function insideRoot(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function readTextFile(path, maxBytes) {
  const buffer = readFileSync(path);
  const truncated = buffer.length > maxBytes;
  const sliced = truncated ? buffer.subarray(0, maxBytes) : buffer;
  const content = sliced.toString("utf8");
  return { content, truncated, bytes: buffer.length };
}

function walkTree(root, maxEntries) {
  const out = [];
  const ignored = new Set([".git", "node_modules", ".venv", "venv", "dist", "build", "__pycache__", ".pytest_cache"]);
  function walk(dir, prefix = "") {
    if (out.length >= maxEntries) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxEntries) return;
      if (ignored.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      out.push(entry.isDirectory() ? `${rel}/` : rel);
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
    }
  }
  walk(root);
  return out;
}

function resolveRepoRoot(repoName, repoMap) {
  if (repoMap.has(repoName)) return repoMap.get(repoName);
  if (repoMap.has(`github.com/${repoName}`)) return repoMap.get(`github.com/${repoName}`);
  if (repoMap.has("__default__")) return repoMap.get("__default__");
  const cwd = resolve(process.cwd());
  if (basename(cwd) === repoName.split("/").pop()) return cwd;
  return "";
}

function defaultAnalysisPaths(payload) {
  const issues = toArray(payload.issues).map((issue) => String(issue));
  const assignment = safeText(payload.assignment, "");
  const evidenceRefs = toArray(payload.evidenceRefs).map((ref) => String(ref));
  const text = `${assignment}\n${issues.join("\n")}\n${evidenceRefs.join("\n")}`;
  const paths = ["package.json", "README.md"];

  // #1341 and A2AD evidence-comment tasks need the analysis bridge and GitHub
  // evidence formatting flow, not just generic src tree entries that may exhaust
  // the prompt budget before reaching the bridge files.
  if (/1341|evidence[_ -]?comment|analysis[_ -]?bridge|github/i.test(text)) {
    paths.push(
      "scripts/hermes-a2a-analysis-bridge.mjs",
      "scripts/hermes-a2a-analysis-bridge.test.mjs",
      "scripts/a2a-dispatch-helper.mjs",
      "scripts/team1-dispatch-wrapper.mjs",
      "src/github/terminal-brief-evidence.ts",
      "src/github/terminal-brief-evidence.test.ts",
      "src/github/types.ts",
    );
  }

  // #1351 terminal_brief_sidecar/orchestration consolidation tasks need the
  // script inventory tool and representative stage scripts before a worker can
  // make a safe no-delete consolidation recommendation.
  if (/1351|scripts[_ -]?inventory|terminal[_ -]?brief[_ -]?sidecar|orchestration[_ -]?intelligence/i.test(text)) {
    paths.push(
      "scripts/npm-scripts-inventory.mjs",
      "docs/npm-scripts-inventory.md",
      "scripts/terminal-brief-sidecar-integration-rehearsal.mjs",
      "scripts/terminal-brief-sidecar-dry-run-gate.mjs",
      "scripts/orchestration-intelligence-worker-subagent-spawn-authorization-bridge.mjs",
    );
  }

  // #1354 license tasks need the readiness document in addition to package/README.
  if (/1354|license|public\/stable|public-stable/i.test(text)) {
    paths.push("docs/public-stable-readiness.md", "LICENSE");
  }

  return [...new Set(paths)];
}

function collectSourceBundle(payload, env) {
  const repoMap = parseRepoMap(env);
  const repos = collectRepos(payload);
  if (repos.length === 0 && repoMap.has("__default__")) repos.push({ name: "__default__" });

  const maxFiles = Number(env.A2A_HERMES_ANALYSIS_MAX_FILES || DEFAULT_MAX_FILES);
  const maxFileBytes = Number(env.A2A_HERMES_ANALYSIS_MAX_FILE_BYTES || DEFAULT_MAX_FILE_BYTES);
  const maxTotalBytes = Number(env.A2A_HERMES_ANALYSIS_MAX_TOTAL_BYTES || DEFAULT_MAX_TOTAL_BYTES);
  const maxTreeEntries = Number(env.A2A_HERMES_ANALYSIS_MAX_TREE_ENTRIES || DEFAULT_TREE_ENTRIES);

  const files = [];
  const warnings = [];
  let totalBytes = 0;

  for (const repo of repos) {
    const root = resolveRepoRoot(repo.name, repoMap);
    if (!root || !existsSync(root)) {
      warnings.push(`repo root unavailable for ${repo.name}`);
      continue;
    }
    const requested = [...collectPathValues(payload), ...collectPathValues(repo.spec || {})];
    const paths = requested.length > 0 ? requested : defaultAnalysisPaths(payload);
    for (const rawPath of paths) {
      if (files.length >= maxFiles || totalBytes >= maxTotalBytes) break;
      if (!isSafeRelativePath(rawPath)) {
        warnings.push(`skipped unsafe path: ${rawPath}`);
        continue;
      }
      const absolute = resolve(root, rawPath);
      if (!insideRoot(root, absolute)) {
        warnings.push(`skipped path outside repo: ${rawPath}`);
        continue;
      }
      if (!existsSync(absolute)) {
        warnings.push(`missing path: ${repo.name}:${rawPath}`);
        continue;
      }
      const stat = statSync(absolute);
      if (stat.isDirectory()) {
        const tree = walkTree(absolute, Math.min(maxTreeEntries, maxFiles - files.length));
        for (const child of tree) {
          if (files.length >= maxFiles || totalBytes >= maxTotalBytes) break;
          if (child.endsWith("/")) continue;
          const childRel = `${rawPath.replace(/\/$/, "")}/${child}`;
          const childAbs = resolve(root, childRel);
          if (!insideRoot(root, childAbs)) continue;
          let childStat;
          try { childStat = statSync(childAbs); } catch { continue; }
          if (!childStat.isFile()) continue;
          const remaining = Math.max(0, maxTotalBytes - totalBytes);
          if (remaining <= 0) break;
          const read = readTextFile(childAbs, Math.min(maxFileBytes, remaining));
          totalBytes += Math.min(read.bytes, maxFileBytes, remaining);
          files.push({ repo: repo.name, path: childRel, ...read });
        }
      } else if (stat.isFile()) {
        const remaining = Math.max(0, maxTotalBytes - totalBytes);
        if (remaining <= 0) break;
        const read = readTextFile(absolute, Math.min(maxFileBytes, remaining));
        totalBytes += Math.min(read.bytes, maxFileBytes, remaining);
        files.push({ repo: repo.name, path: rawPath, ...read });
      }
    }
  }

  return { files, warnings, limits: { maxFiles, maxFileBytes, maxTotalBytes, maxTreeEntries } };
}

function extractJsonFromLooseText(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) throw new Error("empty response");
  try { return JSON.parse(trimmed); } catch {}
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }
  const objectText = extractBalancedJson(trimmed, 0);
  if (objectText) return JSON.parse(objectText);
  throw new Error("response did not contain valid JSON");
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim());
}

function resolveHermesModelRequest(openClawModel, env) {
  const explicitAnalysisProvider = safeText(env.A2A_HERMES_ANALYSIS_PROVIDER, "");
  const genericProvider = safeText(env.HERMES_PROVIDER, "");
  let provider = explicitAnalysisProvider;
  let model = safeText(env.A2A_HERMES_ANALYSIS_MODEL || env.HERMES_MODEL, "") || safeText(openClawModel, "");
  if (model.includes("/")) {
    const parts = model.split("/").filter(Boolean);
    if (parts.length >= 2) {
      const providerFromModel = parts.shift();
      model = parts.join("/");
      if (!explicitAnalysisProvider) provider = providerFromModel;
    }
  }
  if (!provider) provider = genericProvider;
  return { provider, model };
}

function hasExplicitAnalysisJsonShape(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const record = parsed;
  const status = safeText(record.status, "").toLowerCase();
  if (!["done", "blocked", "block"].includes(status)) return false;
  if (!safeText(record.summary, "")) return false;
  for (const key of ["findings", "risks", "recommendations", "evidenceRefs"]) {
    if (!Array.isArray(record[key])) return false;
  }
  return true;
}

function hasUsableHermesAnalysisJson(text) {
  try {
    const parsed = extractJsonFromLooseText(text);
    if (!hasExplicitAnalysisJsonShape(parsed)) return false;
    normalizeResponse(parsed);
    return true;
  } catch {
    return false;
  }
}

function buildHermesPrompt({ message, payload, sourceBundle, flags }) {
  const sourceSections = sourceBundle.files.map((file) => [
    `### ${file.repo}:${file.path}${file.truncated ? " (truncated)" : ""}`,
    "```text",
    file.content,
    "```",
  ].join("\n"));

  const warningSection = sourceBundle.warnings.length
    ? `\n\nRead-only source warnings:\n${sourceBundle.warnings.map((item) => `- ${item}`).join("\n")}`
    : "";

  return [
    "You are a read-only A2A worker analysis bridge running under Hermes Agent.",
    "Your job is to inspect the provided task and source bundle, then produce substantive design/code-analysis evidence.",
    "Hard safety rules: do not write files, deploy, restart services, send external messages, acknowledge terminal rows, mutate databases, move secrets, create commits, or open PRs.",
    "Use only the task text and the read-only source bundle below. If source evidence is insufficient, return status=blocked and explain the missing evidence.",
    "Return JSON only, no markdown, with exactly this shape:",
    '{"status":"done|blocked","summary":"...","findings":["..."],"risks":["..."],"recommendations":["..."],"evidenceRefs":["repo:path"],"doneCommentUrl":"optional","blockCommentUrl":"optional","startCommentUrl":"optional"}',
    "Human-readable text should be Korean unless quoting code, paths, or test output.",
    `OpenClaw-shaped session id: ${safeText(flags["session-id"], "")}`,
    `Effective model requested by worker: ${safeText(flags.model, "")}`,
    `Effective thinking requested by worker: ${safeText(flags.thinking, "")}`,
    `Task payload JSON:\n${JSON.stringify(payload, null, 2)}`,
    `Original worker message:\n${message}`,
    `Read-only source bundle (${sourceBundle.files.length} files):`,
    sourceSections.length ? sourceSections.join("\n\n") : "<no source files available>",
    warningSection,
  ].join("\n\n");
}

function isRecoverableHermesNoJsonAbort(child) {
  if (hasUsableHermesAnalysisJson(child.stdout)) return false;
  return child.signal === "SIGABRT" || child.status === 134;
}

function positiveIntegerEnv(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function truncateUtf8ToBytes(text, maxBytes) {
  const value = String(text || "");
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  if (maxBytes <= 0) return "";
  let truncated = Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8");
  while (Buffer.byteLength(truncated, "utf8") > maxBytes) {
    truncated = truncated.slice(0, -1);
  }
  return truncated;
}

function applyHermesPromptArgBudget(prompt, env) {
  const maxPromptBytes = positiveIntegerEnv(env.A2A_HERMES_ANALYSIS_MAX_PROMPT_BYTES, DEFAULT_MAX_PROMPT_BYTES);
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  if (promptBytes <= maxPromptBytes) return prompt;

  const suffix = [
    "",
    "",
    `[truncated by hermes-a2a-analysis-bridge prompt budget: originalBytes=${promptBytes} maxBytes=${maxPromptBytes}.`,
    "The prompt was shortened before invoking Hermes so the single `hermes chat -q` argv value stays below OS E2BIG limits.",
    "Increase A2A_HERMES_ANALYSIS_MAX_PROMPT_BYTES only after validating this host's per-argument limit.]",
  ].join("\n");
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const prefixBudget = Math.max(0, maxPromptBytes - suffixBytes);
  const truncated = `${truncateUtf8ToBytes(prompt, prefixBudget)}${suffix}`;
  return truncateUtf8ToBytes(truncated, maxPromptBytes);
}

function runHermesOnce(hermesBin, args, timeoutSec, env) {
  const child = spawnSync(hermesBin, args, {
    cwd: safeText(env.A2A_HANDLER_CWD, process.cwd()),
    env: {
      ...env,
      HERMES_A2A_ANALYSIS_BRIDGE: "1",
    },
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    timeout: (timeoutSec + 30) * 1000,
    killSignal: "SIGKILL",
  });
  if (child.error) throw new Error(`Hermes spawn failed: ${child.error.message}`);
  return child;
}

function runHermes(prompt, flags, env) {
  const hermesBin = safeText(env.HERMES_BIN || env.A2A_HERMES_BIN, "hermes");
  const argvSafePrompt = applyHermesPromptArgBudget(prompt, env);
  const args = ["chat", "-Q", "-q", argvSafePrompt, "--source", "a2a-hermes-analysis-bridge"];
  const { provider, model } = resolveHermesModelRequest(flags.model, env);
  if (provider) args.push("--provider", provider);
  if (model) args.push("--model", model);
  const toolsets = safeText(env.A2A_HERMES_ANALYSIS_TOOLSETS, "safe");
  if (toolsets) args.push("--toolsets", toolsets);
  const timeoutSec = Math.max(1, Number(flags.timeout || env.A2A_HERMES_ANALYSIS_TIMEOUT_SEC || DEFAULT_TIMEOUT_SEC));
  const maxAttempts = Math.max(1, Number(env.A2A_HERMES_ANALYSIS_MAX_ATTEMPTS || DEFAULT_HERMES_MAX_ATTEMPTS));
  let lastChild;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const child = runHermesOnce(hermesBin, args, timeoutSec, env);
    lastChild = child;
    if (child.status === 0) return child.stdout;
    if (hasUsableHermesAnalysisJson(child.stdout)) return child.stdout;
    if (attempt < maxAttempts && isRecoverableHermesNoJsonAbort(child)) continue;
    break;
  }
  const output = safeText(lastChild?.stderr, lastChild?.stdout).slice(0, 4000);
  const signal = lastChild?.signal ? ` signal=${lastChild.signal}` : "";
  throw new Error(`Hermes exited with ${lastChild?.status}${signal}: ${output}`);
}

function normalizeResponse(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Hermes response JSON must be an object");
  }
  const statusRaw = safeText(parsed.status, "done").toLowerCase();
  const status = statusRaw === "blocked" || statusRaw === "block" ? "blocked" : "done";
  return {
    status,
    summary: safeText(parsed.summary, status === "blocked" ? "analysis blocked" : "analysis complete"),
    findings: normalizeStringArray(parsed.findings),
    risks: normalizeStringArray(parsed.risks),
    recommendations: normalizeStringArray(parsed.recommendations),
    evidenceRefs: normalizeStringArray(parsed.evidenceRefs),
    ...(safeText(parsed.doneCommentUrl, "") ? { doneCommentUrl: safeText(parsed.doneCommentUrl) } : {}),
    ...(safeText(parsed.blockCommentUrl, "") ? { blockCommentUrl: safeText(parsed.blockCommentUrl) } : {}),
    ...(safeText(parsed.startCommentUrl, "") ? { startCommentUrl: safeText(parsed.startCommentUrl) } : {}),
  };
}

function main() {
  const flags = parseArgs(process.argv);
  if (flags.subcommand !== "agent") die("expected OpenClaw-shaped subcommand: agent");
  if (!flags.json) die("expected --json flag");
  const message = safeText(flags.message, "");
  if (!message) die("missing --message");

  let payload;
  try {
    payload = extractPayload(message);
  } catch (error) {
    die(error.message);
  }

  let sourceBundle;
  try {
    sourceBundle = collectSourceBundle(payload, process.env);
  } catch (error) {
    die(`failed to collect read-only source bundle: ${error.message}`);
  }

  const prompt = buildHermesPrompt({ message, payload, sourceBundle, flags });
  let hermesStdout;
  try {
    hermesStdout = runHermes(prompt, flags, process.env);
  } catch (error) {
    die(error.message);
  }

  let parsed;
  try {
    parsed = extractJsonFromLooseText(hermesStdout);
  } catch (error) {
    die(`Hermes analysis bridge response did not contain valid JSON: ${error.message}`);
  }

  let response;
  try {
    response = normalizeResponse(parsed);
  } catch (error) {
    die(`invalid Hermes analysis JSON schema: ${error.message}`);
  }

  process.stdout.write(JSON.stringify({ payloads: [{ text: JSON.stringify(response) }] }));
}

main();
