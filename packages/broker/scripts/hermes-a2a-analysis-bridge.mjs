#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  collectSourceCarrierItems,
  normalizeSourceCarrierFile,
  sourceCarrierContent,
} from "./lib/source-carriers.mjs";

const DEFAULT_TIMEOUT_SEC = 300;
const DEFAULT_MAX_FILES = 16;
const DEFAULT_MAX_FILE_BYTES = 24 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 160 * 1024;
const DEFAULT_TREE_ENTRIES = 80;
const DEFAULT_HERMES_MAX_ATTEMPTS = 2;
const DEFAULT_PR_DIFF_BYTES = 80 * 1024;
const DEFAULT_PR_METADATA_BYTES = 16 * 1024;
const DEFAULT_PR_FETCH_TIMEOUT_MS = 15_000;
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

function collectEmbeddedSourceEvidence(payload) {
  return collectSourceCarrierItems(payload).map((entry) => entry.item);
}

function normalizeEmbeddedSourceFile(item, fallbackRepo, maxFileBytes, remainingBytes) {
  return normalizeSourceCarrierFile(item, { fallbackRepo, maxFileBytes, remainingBytes });
}

function truthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(safeText(value, ""));
}

function validGithubRepo(value) {
  const repo = safeText(value, "");
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ? repo : "";
}

function normalizePrNumber(value) {
  const text = safeText(value == null ? "" : String(value), "").replace(/^#/, "");
  if (!/^\d+$/.test(text)) return 0;
  const number = Number(text);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function parseGithubPrUrl(value) {
  const text = safeText(value, "");
  if (!text) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return { error: "invalid GitHub PR URL" };
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") {
    return { error: "unsupported PR URL host" };
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 4 || parts[2] !== "pull") return { error: "GitHub URL is not a pull request" };
  const repo = validGithubRepo(`${parts[0]}/${parts[1]}`);
  const pr = normalizePrNumber(parts[3]);
  if (!repo || !pr) return { error: "invalid GitHub pull request reference" };
  return { repo, pr, url: `https://github.com/${repo}/pull/${pr}` };
}

function normalizeGithubPrRef(payload) {
  const fromUrl = parseGithubPrUrl(payload.prUrl || payload.pullRequestUrl || payload.pull_request_url);
  if (fromUrl?.error) return { blocked: `GitHub PR source unavailable: ${fromUrl.error}` };

  const explicitPr = normalizePrNumber(payload.pr ?? payload.pullRequest ?? payload.pull_request ?? payload.prNumber ?? payload.pullRequestNumber);
  const explicitRepo = validGithubRepo(payload.prRepo || payload.pullRequestRepo || (explicitPr ? (payload.repo || payload.repository) : ""));

  if (fromUrl && explicitRepo && explicitRepo !== fromUrl.repo) {
    return { blocked: `GitHub PR source unavailable: conflicting repo refs ${fromUrl.repo} vs ${explicitRepo}` };
  }
  if (fromUrl && explicitPr && explicitPr !== fromUrl.pr) {
    return { blocked: `GitHub PR source unavailable: conflicting PR refs ${fromUrl.pr} vs ${explicitPr}` };
  }
  if (fromUrl) return fromUrl;
  if (explicitRepo || explicitPr) {
    if (!explicitRepo || !explicitPr) return { blocked: "GitHub PR source unavailable: incomplete PR repo/number reference" };
    return { repo: explicitRepo, pr: explicitPr, url: `https://github.com/${explicitRepo}/pull/${explicitPr}` };
  }
  return null;
}

function redactForDiagnostics(text) {
  return String(text || "")
    .replace(/(GH_TOKEN|GITHUB_TOKEN|TOKEN|SECRET|PASSWORD|AUTHORIZATION)=[^\s]+/gi, "$1=[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [REDACTED]")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "github_pat_[REDACTED]")
    .replace(/ghp_[A-Za-z0-9_]+/g, "ghp_[REDACTED]")
    .slice(0, 1000);
}

function boundedTextFile(repo, path, content, maxBytes) {
  const buffer = Buffer.from(String(content || ""), "utf8");
  const limit = Math.max(0, maxBytes);
  const truncated = buffer.length > limit;
  return {
    repo,
    path,
    content: buffer.subarray(0, limit).toString("utf8"),
    truncated,
    bytes: buffer.length,
  };
}

function runBoundedGh(args, env, { timeoutMs, maxBytes }) {
  const ghBin = safeText(env.A2A_HERMES_ANALYSIS_GITHUB_PR_BIN || env.GH_BIN, "gh");
  const child = spawnSync(ghBin, args, {
    cwd: safeText(env.A2A_HANDLER_CWD, process.cwd()),
    env,
    encoding: "utf8",
    maxBuffer: Math.max(maxBytes + 64 * 1024, 128 * 1024),
    timeout: Math.max(1000, timeoutMs),
    killSignal: "SIGKILL",
  });
  if (child.error) return { ok: false, reason: `gh spawn failed: ${redactForDiagnostics(child.error.message)}` };
  if (child.status !== 0) {
    const detail = redactForDiagnostics(child.stderr || child.stdout || `exit ${child.status}`);
    return { ok: false, reason: `gh ${args.slice(0, 3).join(" ")} failed: ${detail}` };
  }
  return { ok: true, stdout: String(child.stdout || "") };
}

function fetchGithubPrSourceBundle(prRef, env, limits, remainingBytes) {
  const timeoutMs = positiveIntegerEnv(env.A2A_HERMES_ANALYSIS_PR_FETCH_TIMEOUT_MS, DEFAULT_PR_FETCH_TIMEOUT_MS);
  const diffBudget = Math.min(
    positiveIntegerEnv(env.A2A_HERMES_ANALYSIS_PR_DIFF_BYTES, DEFAULT_PR_DIFF_BYTES),
    limits.maxFileBytes,
    remainingBytes,
  );
  const metadataBudget = Math.min(
    positiveIntegerEnv(env.A2A_HERMES_ANALYSIS_PR_METADATA_BYTES, DEFAULT_PR_METADATA_BYTES),
    limits.maxFileBytes,
    Math.max(0, remainingBytes - diffBudget),
  );
  const warnings = [];
  const files = [];
  const diff = runBoundedGh(["pr", "diff", String(prRef.pr), "-R", prRef.repo, "--color=never"], env, {
    timeoutMs,
    maxBytes: Math.max(diffBudget, 1024),
  });
  if (!diff.ok || !safeText(diff.stdout, "")) {
    return { files, warnings, blockedReason: `GitHub PR source unavailable for ${prRef.repo}#${prRef.pr}: ${diff.reason || "empty diff"}` };
  }
  files.push(boundedTextFile(prRef.repo, `.github/pr-${prRef.pr}.diff`, diff.stdout, diffBudget));

  if (metadataBudget > 0) {
    const metadata = runBoundedGh([
      "pr", "view", String(prRef.pr), "-R", prRef.repo,
      "--json", "number,title,body,state,isDraft,baseRefName,headRefName,author,additions,deletions,changedFiles,url,comments,reviews",
    ], env, { timeoutMs, maxBytes: Math.max(metadataBudget, 1024) });
    if (metadata.ok && safeText(metadata.stdout, "")) {
      files.push(boundedTextFile(prRef.repo, `.github/pr-${prRef.pr}.metadata.json`, metadata.stdout, metadataBudget));
    } else {
      warnings.push(`GitHub PR metadata unavailable for ${prRef.repo}#${prRef.pr}: ${metadata.reason || "empty metadata"}`);
    }
  }
  return { files, warnings };
}

function buildSourceBlockedResponse(sourceBlocked, fallbackSourceProjection) {
  const summary = `analysis bridge blocked: ${sourceBlocked.reason}`;
  const sourceProjection = sourceBlocked.sourceProjection || fallbackSourceProjection;
  return {
    payloads: [{
      text: JSON.stringify({
        status: "blocked",
        summary,
        findings: [],
        risks: [
          "Worker did not inspect the requested source evidence.",
          `source projection blocked: ${sourceBlocked.reason}`,
        ],
        recommendations: ["Retry with a compact canonical payload.sourceBundle.files[] packet or make the referenced source available to the analysis bridge."],
        evidenceRefs: sourceBlocked.evidenceRefs || [],
        ...(sourceProjection && typeof sourceProjection === "object" ? { sourceProjection } : {}),
      }),
    }],
  };
}

function hasExplicitSourceEvidence(payload) {
  return collectEmbeddedSourceEvidence(payload).length > 0;
}

function collectSourceBundle(payload, env) {
  const repoMap = parseRepoMap(env);
  const repos = collectRepos(payload);
  if (repos.length === 0 && repoMap.has("__default__")) repos.push({ name: "__default__" });

  const maxFiles = Number(env.A2A_HERMES_ANALYSIS_MAX_FILES || DEFAULT_MAX_FILES);
  const maxFileBytes = Number(env.A2A_HERMES_ANALYSIS_MAX_FILE_BYTES || DEFAULT_MAX_FILE_BYTES);
  const maxTotalBytes = Number(env.A2A_HERMES_ANALYSIS_MAX_TOTAL_BYTES || DEFAULT_MAX_TOTAL_BYTES);
  const maxTreeEntries = Number(env.A2A_HERMES_ANALYSIS_MAX_TREE_ENTRIES || DEFAULT_TREE_ENTRIES);
  const maxPromptBytes = positiveIntegerEnv(env.A2A_HERMES_ANALYSIS_MAX_PROMPT_BYTES, DEFAULT_MAX_PROMPT_BYTES);

  const files = [];
  const warnings = [];
  let totalBytes = 0;

  const prRef = normalizeGithubPrRef(payload);
  if (prRef?.blocked) {
    return {
      files,
      warnings,
      limits: { maxFiles, maxFileBytes, maxTotalBytes, maxTreeEntries, maxPromptBytes },
      sourceBlocked: { reason: prRef.blocked, evidenceRefs: [] },
    };
  }
  if (prRef && !truthyEnv(env.A2A_HERMES_ANALYSIS_GITHUB_PR_SOURCE_DISABLED)) {
    const fetched = fetchGithubPrSourceBundle(prRef, env, { maxFiles, maxFileBytes, maxTotalBytes, maxTreeEntries }, maxTotalBytes);
    warnings.push(...fetched.warnings);
    if (fetched.blockedReason) {
      return {
        files,
        warnings,
        limits: { maxFiles, maxFileBytes, maxTotalBytes, maxTreeEntries, maxPromptBytes },
        sourceBlocked: { reason: fetched.blockedReason, evidenceRefs: [`${prRef.repo}#${prRef.pr}`] },
      };
    }
    for (const file of fetched.files) {
      if (files.length >= maxFiles || totalBytes >= maxTotalBytes) break;
      const remaining = Math.max(0, maxTotalBytes - totalBytes);
      const capped = boundedTextFile(file.repo, file.path, file.content, Math.min(maxFileBytes, remaining));
      capped.bytes = file.bytes;
      capped.truncated = file.truncated || capped.truncated;
      files.push(capped);
      totalBytes += Math.min(capped.bytes, maxFileBytes, remaining);
    }
  }

  const fallbackRepo = safeText(payload.repo || payload.repository || "embedded", "embedded");
  for (const embedded of collectEmbeddedSourceEvidence(payload)) {
    if (files.length >= maxFiles) {
      warnings.push(`dropped embedded source files: reason=max_files maxFiles=${maxFiles}`);
      break;
    }
    if (totalBytes >= maxTotalBytes) {
      warnings.push(`dropped embedded source files: reason=max_total_bytes maxTotalBytes=${maxTotalBytes}`);
      break;
    }
    const remaining = Math.max(0, maxTotalBytes - totalBytes);
    const normalized = normalizeEmbeddedSourceFile(embedded, fallbackRepo, maxFileBytes, remaining);
    if (normalized.warning) warnings.push(normalized.warning);
    if (normalized.file) {
      files.push(normalized.file);
      totalBytes += Math.min(normalized.file.bytes, maxFileBytes, remaining);
      continue;
    }
  }

  const explicitSourceEvidence = hasExplicitSourceEvidence(payload);
  if (explicitSourceEvidence && files.length === 0) {
    return {
      files,
      warnings,
      limits: { maxFiles, maxFileBytes, maxTotalBytes, maxTreeEntries, maxPromptBytes },
      sourceBlocked: {
        reason: `source projection failed: explicit sourceBundle.files / embedded source evidence could not be projected into the model prompt budget or source sections (${warnings.join('; ') || 'no usable source files'})`,
        evidenceRefs: ["payload.sourceBundle.files"],
      },
    };
  }
  if (explicitSourceEvidence) {
    return { files, warnings, limits: { maxFiles, maxFileBytes, maxTotalBytes, maxTreeEntries, maxPromptBytes } };
  }

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

  return { files, warnings, limits: { maxFiles, maxFileBytes, maxTotalBytes, maxTreeEntries, maxPromptBytes } };
}

function repairLooseJsonObjectCandidate(text) {
  let repaired = String(text || "").trim();
  if (!/^[\[{]/.test(repaired)) return "";

  // Some models emit JavaScript-ish object literals despite a JSON-only prompt:
  // { status: 'done', findings: ['...'], }.  Do not eval it; only apply small
  // textual repairs, then require JSON.parse + the analysis schema downstream.
  repaired = repaired.replace(/([{,]\s*)([A-Za-z_$][\w$-]*)(\s*:)/g, '$1"$2"$3');
  repaired = repaired.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_match, body) => {
    const normalized = String(body).replace(/\\'/g, "'");
    return JSON.stringify(normalized);
  });
  repaired = repaired.replace(/,\s*([}\]])/g, "$1");
  return repaired;
}

function parseJsonCandidate(candidate) {
  const text = String(candidate || "").trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const repaired = repairLooseJsonObjectCandidate(text);
  if (repaired && repaired !== text) {
    try { return JSON.parse(repaired); } catch {}
  }
  return null;
}

function collectLooseJsonCandidates(text) {
  const trimmed = String(text || "").trim();
  const candidates = [];
  if (!trimmed) return candidates;
  candidates.push(trimmed);

  for (const match of trimmed.matchAll(/```(?:json|js|javascript)?\s*([\s\S]*?)```/gi)) {
    if (match[1]?.trim()) candidates.push(match[1].trim());
  }

  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed[index] !== "{" && trimmed[index] !== "[") continue;
    const candidate = extractBalancedJson(trimmed, index);
    if (!candidate) continue;
    candidates.push(candidate);
    index += Math.max(0, candidate.length - 1);
  }

  return candidates;
}

function extractJsonFromLooseText(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) throw new Error("empty response");

  let lastError = null;
  for (const candidate of collectLooseJsonCandidates(trimmed)) {
    const parsed = parseJsonCandidate(candidate);
    if (parsed !== null) return parsed;
    lastError = `candidate was not valid JSON: ${candidate.slice(0, 120)}`;
  }
  throw new Error(lastError || "response did not contain valid JSON");
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
  if (!["done", "blocked", "block", "source_blocked"].includes(status)) return false;
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

function summarizeSourceEvidenceForPrompt(value) {
  const files = [];
  for (const item of toArray(value?.files ?? value)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const repo = safeText(item.repo || item.repository, "");
    const path = safeText(item.path || item.file || item.name, "");
    const { content } = sourceCarrierContent(item);
    files.push({
      ...(repo ? { repo } : {}),
      ...(path ? { path } : {}),
      bytes: Buffer.byteLength(content, "utf8"),
      hasContent: content.length > 0,
    });
  }
  return { files, fileCount: files.length };
}

function normalizePathArray(value) {
  return toArray(value).map((item) => safeText(item, "")).filter(Boolean);
}

function normalizeSourceProjectionPolicy(payload) {
  const raw = payload?.sourceProjectionPolicy && typeof payload.sourceProjectionPolicy === "object" && !Array.isArray(payload.sourceProjectionPolicy)
    ? payload.sourceProjectionPolicy
    : {};
  const minProjectedBytes = Number(raw.minProjectedBytesPerRequiredFile || 0);
  return {
    requiredPaths: normalizePathArray(raw.requiredPaths),
    priorityPaths: normalizePathArray(raw.priorityPaths),
    minProjectedBytesPerRequiredFile: Number.isFinite(minProjectedBytes) && minProjectedBytes > 0 ? Math.floor(minProjectedBytes) : 0,
    failIfRequiredTruncatedBelowMin: raw.failIfRequiredTruncatedBelowMin !== false,
  };
}

function sourcePathMatches(file, requestedPath) {
  const wanted = safeText(requestedPath, "");
  if (!wanted) return false;
  const repo = safeText(file.repo, "");
  const path = safeText(file.path, "");
  return wanted === path || wanted === `${repo}:${path}` || wanted === `${repo}/${path}`;
}

function sourceFileRank(file, policy) {
  if (policy.requiredPaths.some((path) => sourcePathMatches(file, path))) return 0;
  if (policy.priorityPaths.some((path) => sourcePathMatches(file, path))) return 1;
  return 2;
}

function sourceFileWeight(file, policy) {
  const rank = sourceFileRank(file, policy);
  if (rank === 0) return 6;
  if (rank === 1) return 3;
  return 1;
}

function sourceProjectionQuality({ sourceBundle, projectedFiles, truncatedFiles, omittedFiles, requiredFilesMissing, requiredFilesBelowMin }) {
  const canonicalFileCount = sourceBundle.files.length;
  if (canonicalFileCount === 0) return { quality: "zero_files", budgetReason: "no_usable_files" };
  if (projectedFiles.length === 0) return { quality: "zero_files", budgetReason: "no_usable_files" };
  if (requiredFilesMissing.length > 0) return { quality: "insufficient", budgetReason: "required_missing" };
  if (requiredFilesBelowMin.length > 0) return { quality: "insufficient", budgetReason: "required_below_min" };
  if (omittedFiles.length > 0) return { quality: "partial", budgetReason: "file_omitted" };
  if (truncatedFiles.length > 0) return { quality: "partial", budgetReason: "per_file_truncation" };
  return { quality: "complete", budgetReason: "ok" };
}

function sourceProjectionWarningReason(warning) {
  const text = safeText(warning, "");
  const explicit = /reason=([A-Za-z0-9_-]+)/.exec(text);
  if (explicit) return explicit[1];
  if (/unsafe/i.test(text)) return "unsafe_path";
  if (/empty/i.test(text)) return "empty_content";
  if (/malformed/i.test(text)) return "malformed";
  if (/truncat/i.test(text)) return "per_file_budget";
  if (/max_files/i.test(text)) return "max_files";
  if (/max_total_bytes/i.test(text)) return "max_total_bytes";
  return text ? "other" : "unknown";
}

function summarizeDroppedByReason(warnings) {
  const counts = {};
  for (const warning of warnings || []) {
    const reason = sourceProjectionWarningReason(warning);
    counts[reason] = (counts[reason] || 0) + 1;
  }
  return counts;
}

function payloadForPrompt(payload) {
  const copy = JSON.parse(JSON.stringify(payload ?? {}));
  if (copy.sourceBundle && typeof copy.sourceBundle === "object" && !Array.isArray(copy.sourceBundle)) {
    copy.sourceBundle = {
      ...copy.sourceBundle,
      files: summarizeSourceEvidenceForPrompt(copy.sourceBundle).files,
      contentOmitted: "sourceBundle file content is shown only in the Read-only source bundle sections below",
    };
  }
  if (Array.isArray(copy.embeddedSourceEvidence)) {
    copy.embeddedSourceEvidence = summarizeSourceEvidenceForPrompt(copy.embeddedSourceEvidence).files;
    copy.embeddedSourceEvidenceContentOmitted = "embedded source content is shown only in the Read-only source bundle sections below";
  }
  if (Array.isArray(copy.sourceEvidence)) {
    copy.sourceEvidence = summarizeSourceEvidenceForPrompt(copy.sourceEvidence).files;
    copy.sourceEvidenceContentOmitted = "source evidence content is shown only in the Read-only source bundle sections below";
  }
  return copy;
}

function messageForPrompt(message, payload) {
  const text = String(message || "");
  const marker = /Payload JSON\s*:/i.exec(text);
  if (!marker) return text;
  const start = marker.index + marker[0].length;
  const jsonOffset = text.slice(start).search(/[\[{]/);
  if (jsonOffset < 0) return text;
  const jsonStart = start + jsonOffset;
  const jsonText = extractBalancedJson(text, jsonStart);
  if (!jsonText) return text;
  return `${text.slice(0, start)}\n${JSON.stringify(payloadForPrompt(payload), null, 2)}${text.slice(jsonStart + jsonText.length)}`;
}

function sourceSectionText(file, contentBudget) {
  const header = `### ${file.repo}:${file.path}${file.truncated ? " (truncated)" : ""}`;
  const contentBytes = Buffer.byteLength(String(file.content || ""), "utf8");
  let content = String(file.content || "");
  let omitted = "";
  if (file.path.startsWith("virtual/") && contentBytes > contentBudget) {
    content = "";
    omitted = `[large virtual source omitted from prompt body: bytes=${contentBytes}. Use the path/summary plus concrete repository files below.]`;
  } else {
    content = truncateUtf8ToBytes(content, contentBudget);
    if (Buffer.byteLength(content, "utf8") < contentBytes) {
      omitted = `\n[truncated source file for prompt budget: originalBytes=${contentBytes} keptBytes=${Buffer.byteLength(content, "utf8")}]`;
    }
  }
  const projectedBytes = Buffer.byteLength(content, "utf8");
  const text = [
    header,
    "```text",
    content || omitted,
    content ? `${omitted}\n\`\`\`` : "```",
  ].join("\n");
  return {
    text,
    detail: {
      path: file.path,
      repo: file.repo,
      originalBytes: contentBytes,
      projectedBytes,
      truncated: projectedBytes < contentBytes,
      reason: projectedBytes < contentBytes ? "per_file_budget" : "ok",
    },
  };
}

function buildSourceProjectionForPrompt(sourceBundle, payload) {
  const maxPromptBytes = sourceBundle.limits?.maxPromptBytes || DEFAULT_MAX_PROMPT_BYTES;
  const policy = normalizeSourceProjectionPolicy(payload);
  const fixedBudget = Math.min(18 * 1024, Math.floor(maxPromptBytes * 0.25));
  const sourceBudget = Math.max(4 * 1024, maxPromptBytes - fixedBudget);
  const orderedFiles = [...sourceBundle.files].sort((a, b) => {
    const rank = sourceFileRank(a, policy) - sourceFileRank(b, policy);
    return rank || safeText(a.path, "").localeCompare(safeText(b.path, ""));
  });
  const totalWeight = Math.max(1, orderedFiles.reduce((sum, file) => sum + sourceFileWeight(file, policy), 0));
  const sourceSections = [];
  const projectedFiles = [];
  const truncatedFiles = [];
  const omittedFiles = [];

  for (const file of orderedFiles) {
    const weight = sourceFileWeight(file, policy);
    const budget = Math.max(512, Math.floor((sourceBudget * weight) / totalWeight));
    const section = sourceSectionText(file, budget);
    sourceSections.push(section.text);
    projectedFiles.push(section.detail);
    if (section.detail.truncated) truncatedFiles.push(section.detail);
  }

  const requiredFilesMissing = policy.requiredPaths.filter(
    (requiredPath) => !sourceBundle.files.some((file) => sourcePathMatches(file, requiredPath)),
  );
  const requiredFilesBelowMin = policy.requiredPaths.flatMap((requiredPath) => {
    const detail = projectedFiles.find((file) => sourcePathMatches(file, requiredPath));
    if (!detail) return [];
    if (policy.failIfRequiredTruncatedBelowMin && detail.projectedBytes < policy.minProjectedBytesPerRequiredFile) {
      return [{ path: requiredPath, projectedBytes: detail.projectedBytes, minProjectedBytes: policy.minProjectedBytesPerRequiredFile }];
    }
    return [];
  });
  const canonicalBytes = sourceBundle.files.reduce((sum, file) => sum + Number(file.bytes || Buffer.byteLength(String(file.content || ""), "utf8")), 0);
  const projectedBytes = projectedFiles.reduce((sum, file) => sum + file.projectedBytes, 0);
  const { quality, budgetReason } = sourceProjectionQuality({
    sourceBundle,
    projectedFiles,
    truncatedFiles,
    omittedFiles,
    requiredFilesMissing,
    requiredFilesBelowMin,
  });
  const warnings = sourceBundle.warnings.slice(0, 20);
  const sourceProjection = {
    canonicalFileCount: sourceBundle.files.length,
    canonicalBytes,
    projectedFileCount: projectedFiles.length,
    projectedBytes,
    omittedFileCount: omittedFiles.length,
    truncatedFiles,
    requiredFilesMissing,
    requiredFilesBelowMin,
    quality,
    budgetReason,
    droppedByReason: summarizeDroppedByReason(sourceBundle.warnings),
    warnings,
    warningCount: sourceBundle.warnings.length,
    requiredPaths: policy.requiredPaths,
    priorityPaths: policy.priorityPaths,
    minProjectedBytesPerRequiredFile: policy.minProjectedBytesPerRequiredFile,
  };
  let sourceBlocked = null;
  if (quality === "insufficient" || (sourceBundle.files.length > 0 && quality === "zero_files")) {
    sourceBlocked = {
      reason: `source projection failed: ${budgetReason}`,
      evidenceRefs: requiredFilesMissing.length ? requiredFilesMissing : ["payload.sourceBundle.files"],
      sourceProjection,
    };
  }
  return { sourceSections, sourceProjection, sourceBlocked };
}

function compactOriginalMessageForPrompt(message, payload) {
  const rewritten = messageForPrompt(message, payload);
  const maxBytes = 6 * 1024;
  if (Buffer.byteLength(rewritten, "utf8") <= maxBytes) return rewritten;
  const marker = /Payload JSON\s*:/i.exec(rewritten);
  const prefix = marker ? rewritten.slice(0, marker.index + marker[0].length) : rewritten;
  return [
    truncateUtf8ToBytes(prefix, maxBytes - 512),
    "[original worker message truncated by source projection guard; sourceBundle content is available in the Read-only source bundle sections above]",
  ].join("\n");
}

function buildHermesPrompt({ message, payload, sourceBundle, flags }) {
  const projection = buildSourceProjectionForPrompt(sourceBundle, payload);

  const warningSection = sourceBundle.warnings.length
    ? `\n\nRead-only source warnings:\n${sourceBundle.warnings.map((item) => `- ${item}`).join("\n")}`
    : "";

  const prompt = [
    "You are a read-only A2A worker analysis bridge running under Hermes Agent.",
    "Your job is to inspect the provided task and source bundle, then produce substantive design/code-analysis evidence.",
    "Hard safety rules: do not write files, deploy, restart services, send external messages, acknowledge terminal rows, mutate databases, move secrets, create commits, or open PRs.",
    "Use only the task text and the read-only source bundle below. If source evidence is insufficient, return status=blocked and explain the missing evidence.",
    "Return JSON only, no markdown, with exactly this shape:",
    '{"status":"done|blocked","summary":"...","findings":["..."],"risks":["..."],"recommendations":["..."],"evidenceRefs":["repo:path"],"sourceProjection":{"quality":"complete|partial|insufficient|zero_files"},"doneCommentUrl":"optional","blockCommentUrl":"optional","startCommentUrl":"optional"}',
    "Human-readable text should be Korean unless quoting code, paths, or test output.",
    `OpenClaw-shaped session id: ${safeText(flags["session-id"], "")}`,
    `Effective model requested by worker: ${safeText(flags.model, "")}`,
    `Effective thinking requested by worker: ${safeText(flags.thinking, "")}`,
    `Read-only source bundle (${sourceBundle.files.length} files):`,
    projection.sourceSections.length ? projection.sourceSections.join("\n\n") : "<no source files available>",
    warningSection,
    `Source projection telemetry:\n${JSON.stringify(projection.sourceProjection, null, 2)}`,
    `Task payload JSON (source content summarized; inspect source sections above):\n${JSON.stringify(payloadForPrompt(payload), null, 2)}`,
    `Original worker message (source content summarized):\n${compactOriginalMessageForPrompt(message, payload)}`,
  ].join("\n\n");
  return { prompt, sourceProjection: projection.sourceProjection, sourceBlocked: projection.sourceBlocked };
}

function isRecoverableHermesNoJsonAbort(child) {
  if (hasUsableHermesAnalysisJson(child.stdout)) return false;
  return child.signal === "SIGABRT" || child.status === 134;
}

function extractHermesSessionId(text) {
  const match = /(?:^|\n)\s*session_id:\s*([A-Za-z0-9_-]+)/.exec(String(text || ""));
  return match ? match[1] : "";
}

function hermesStateDbPath(env) {
  const explicit = safeText(env.HERMES_STATE_DB || env.HERMES_STATE_DB_PATH, "");
  if (explicit) return resolve(explicit);
  const hermesHome = safeText(env.HERMES_HOME, "");
  if (hermesHome) return join(resolve(hermesHome), "state.db");
  const home = safeText(env.HOME, "");
  if (home) return join(resolve(home), ".hermes", "state.db");
  const cwd = resolve(process.cwd());
  return basename(cwd) === ".hermes" ? join(cwd, "state.db") : "";
}

const RECOVERY_SOURCES = new Set(["direct_stdout", "abort_stdout", "state_db", "retry_stdout", "retry_state_db"]);

function normalizeRecoverySource(value) {
  const text = safeText(value, "");
  return RECOVERY_SOURCES.has(text) ? text : "";
}

function recoverHermesAnalysisJsonFromStateDb(child, env) {
  if (!isRecoverableHermesNoJsonAbort(child)) return { stdout: "", recoverySource: "" };
  const sessionId = extractHermesSessionId(`${child.stderr || ""}\n${child.stdout || ""}`);
  if (!sessionId) return { stdout: "", recoverySource: "" };
  const stateDb = hermesStateDbPath(env);
  if (!stateDb || !existsSync(stateDb)) return { stdout: "", recoverySource: "" };

  let db;
  try {
    db = new DatabaseSync(stateDb, { readOnly: true });
    const row = db.prepare([
      "SELECT content FROM messages",
      "WHERE session_id = ? AND role = 'assistant'",
      "ORDER BY id DESC LIMIT 1",
    ].join(" ")).get(sessionId);
    const content = typeof row?.content === "string" ? row.content : "";
    return hasUsableHermesAnalysisJson(content) ? { stdout: content, recoverySource: "state_db" } : { stdout: "", recoverySource: "" };
  } catch {
    return { stdout: "", recoverySource: "" };
  } finally {
    try { db?.close(); } catch {}
  }
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
    if (child.status === 0) return { stdout: child.stdout, recoverySource: attempt > 1 ? "retry_stdout" : "direct_stdout" };
    if (hasUsableHermesAnalysisJson(child.stdout)) return { stdout: child.stdout, recoverySource: attempt > 1 ? "retry_stdout" : "abort_stdout" };
    const savedAnalysis = recoverHermesAnalysisJsonFromStateDb(child, env);
    if (savedAnalysis.stdout) {
      return { stdout: savedAnalysis.stdout, recoverySource: attempt > 1 ? "retry_state_db" : savedAnalysis.recoverySource };
    }
    if (attempt < maxAttempts && isRecoverableHermesNoJsonAbort(child)) continue;
    break;
  }
  const output = safeText(lastChild?.stderr, lastChild?.stdout).slice(0, 4000);
  const signal = lastChild?.signal ? ` signal=${lastChild.signal}` : "";
  throw new Error(`Hermes exited with ${lastChild?.status}${signal}: ${output}`);
}

function normalizeResponse(parsed, diagnostics = {}) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Hermes response JSON must be an object");
  }
  const statusRaw = safeText(parsed.status, "done").toLowerCase();
  const status = ["blocked", "block", "source_blocked"].includes(statusRaw) ? "blocked" : "done";
  const recoverySource = normalizeRecoverySource(diagnostics.recoverySource);
  return {
    status,
    summary: safeText(parsed.summary, status === "blocked" ? "analysis blocked" : "analysis complete"),
    findings: normalizeStringArray(parsed.findings),
    risks: normalizeStringArray(parsed.risks),
    recommendations: normalizeStringArray(parsed.recommendations),
    evidenceRefs: normalizeStringArray(parsed.evidenceRefs),
    ...(recoverySource ? { recoverySource } : {}),
    ...(safeText(parsed.doneCommentUrl, "") ? { doneCommentUrl: safeText(parsed.doneCommentUrl) } : {}),
    ...(safeText(parsed.blockCommentUrl, "") ? { blockCommentUrl: safeText(parsed.blockCommentUrl) } : {}),
    ...(safeText(parsed.startCommentUrl, "") ? { startCommentUrl: safeText(parsed.startCommentUrl) } : {}),
    ...(parsed.sourceProjection && typeof parsed.sourceProjection === "object" && !Array.isArray(parsed.sourceProjection) ? { sourceProjection: parsed.sourceProjection } : {}),
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

  const promptBundle = buildHermesPrompt({ message, payload, sourceBundle, flags });
  const sourceBlocked = sourceBundle.sourceBlocked || promptBundle.sourceBlocked;
  if (sourceBlocked) {
    process.stdout.write(JSON.stringify(buildSourceBlockedResponse(sourceBlocked, promptBundle.sourceProjection)));
    return;
  }

  let hermesResult;
  try {
    hermesResult = runHermes(promptBundle.prompt, flags, process.env);
  } catch (error) {
    die(error.message);
  }

  let parsed;
  try {
    parsed = extractJsonFromLooseText(hermesResult.stdout);
  } catch (error) {
    die(`Hermes analysis bridge response did not contain valid JSON: ${error.message}`);
  }

  let response;
  try {
    response = normalizeResponse(parsed, { recoverySource: hermesResult.recoverySource });
    if (promptBundle.sourceProjection) {
      const reportedSourceProjection = response.sourceProjection && typeof response.sourceProjection === "object" && !Array.isArray(response.sourceProjection)
        ? response.sourceProjection
        : undefined;
      if (reportedSourceProjection) response.bridgeReportedSourceProjection = reportedSourceProjection;
      response.sourceProjection = {
        ...(reportedSourceProjection || {}),
        ...promptBundle.sourceProjection,
      };
    }
  } catch (error) {
    die(`invalid Hermes analysis JSON schema: ${error.message}`);
  }

  process.stdout.write(JSON.stringify({ payloads: [{ text: JSON.stringify(response) }] }));
}

main();
