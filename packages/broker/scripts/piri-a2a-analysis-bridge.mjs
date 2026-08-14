#!/usr/bin/env node
/**
 * piri A2A analysis bridge (jinwon-int/a2a-nexus#1745 Phase 0).
 *
 * OpenClaw-shaped analysis bridge surface (same argv/envelope contract as
 * hermes-a2a-analysis-bridge.mjs) backed by the fleet-owned piri harness
 * instead of an unpatchable one. The model's final answer is schema-locked
 * INSIDE the harness via `piri -p --output-schema` (jinwon-int/piri#6), so
 * this bridge needs no parseJsonFromLooseText repair pass: stdout either is
 * the validated contract JSON or the run failed honestly.
 *
 * Invocation runs in the a2a-docker-runner-piri image so the lane uses the
 * pinned harness, the baked analysis contract, and gets a live
 * content-free progress signal (piri-progress.jsonl) on the host for
 * stale-vs-working attribution (jinwon-int/piri#10, a2a-nexus#1751).
 *
 * Handler contract (packages/broker/scripts/a2a-task-handler.mjs):
 *   argv:   agent --local --agent <id> --session-id <id> --message <prompt>
 *           --model <m> --thinking <t> --timeout <sec> --json
 *   stdout: {"payloads":[{"text": "<analysis contract JSON string>"}]}
 *   stderr: A2A_BRIDGE_ERROR={...} on failure (structured, #1725 shape)
 *
 * piri exit-code mapping (jinwon-int/piri#14 stable contract):
 *   2 usage/config   → analysis_bridge_invocation_invalid (handler_artifact_failure)
 *   3 provider/error → analysis_bridge_provider_failure (provider_or_model_failure)
 *   4 schema budget  → analysis_bridge_schema_unsatisfied (provider_or_model_failure)
 *   other non-zero   → analysis_bridge_internal_error — pre-contract piri builds
 *                      returned 1 for provider and schema failures alike.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { piriExecutionTelemetry } from "./lib/analysis-execution-telemetry.mjs";

const DEFAULT_TIMEOUT_SEC = 300;
const DEFAULT_MAX_FILES = 16;
const DEFAULT_MAX_FILE_BYTES = 24 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 160 * 1024;
const DEFAULT_MAX_TREE_ENTRIES = 80;
const DEFAULT_MAX_PROMPT_BYTES = 96 * 1024;
const DEFAULT_PIRI_MODEL = "kimi-coding/k3";
const DEFAULT_PIRI_THINKING = "high";
const DEFAULT_PIRI_IMAGE = "a2a-docker-runner-piri:latest";
const DEFAULT_PIRI_CONFIG_DIR = "/var/lib/a2a-runner/piri-dir";
const DEFAULT_PIRI_WORK_ROOT = "/var/lib/a2a-runner/piri-tasks";
const BRIDGE_CONTRACT_VERSION = "piri-a2a-analysis.v1";
const STRUCTURED_OUTPUT_MODE = "piri_output_schema";
const IMAGE_SCHEMA_PATH = "/etc/a2a-runner/piri-analysis-output.schema.json";

function die(message, code = 1) {
	console.error(message);
	process.exit(code);
}

function safeText(value, fallback = "") {
	return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function positiveIntegerEnv(value, fallback) {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
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

/**
 * Full-payload carrier preferred by the current dispatcher: the prompt only
 * embeds a bounded "Payload JSON excerpt" and the complete payload JSON lives
 * in A2A_ANALYSIS_PAYLOAD_FILE (payload_file mode, hermes bridge parity).
 */
function payloadFromStructuredEnv(env = process.env) {
	const path = safeText(env.A2A_ANALYSIS_PAYLOAD_FILE, "");
	if (!path) return undefined;
	if (!existsSync(path)) throw new Error(`A2A_ANALYSIS_PAYLOAD_FILE does not exist: ${path}`);
	return parseJsonObject(readFileSync(path, "utf8"), "A2A_ANALYSIS_PAYLOAD_FILE");
}

function parseRepoMap(env) {
	const raw = safeText(env.A2A_ANALYSIS_REPO_MAP_JSON || env.A2A_PIRI_ANALYSIS_REPO_MAP_JSON, "");
	const map = new Map();
	if (raw) {
		const parsed = parseJsonObject(raw, "A2A_ANALYSIS_REPO_MAP_JSON");
		for (const [repo, path] of Object.entries(parsed)) {
			if (typeof path === "string" && path.trim()) map.set(repo, resolve(path));
		}
	}
	const defaultRoot = safeText(env.A2A_ANALYSIS_REPO_ROOT || env.A2A_PIRI_ANALYSIS_REPO_ROOT, "");
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
	if (/1351|scripts[_ -]?inventory|terminal[_ -]?brief[_ -]?sidecar|orchestration[_ -]?intelligence/i.test(text)) {
		paths.push(
			"scripts/npm-scripts-inventory.mjs",
			"docs/npm-scripts-inventory.md",
			"scripts/terminal-brief-sidecar-integration-rehearsal.mjs",
			"scripts/terminal-brief-sidecar-dry-run-gate.mjs",
			"scripts/orchestration-intelligence-worker-subagent-spawn-authorization-bridge.mjs",
		);
	}
	if (/1354|license|public\/stable|public-stable/i.test(text)) {
		paths.push("docs/public-stable-readiness.md", "LICENSE");
	}
	return [...new Set(paths)];
}

function collectEmbeddedSourceEvidence(payload) {
	const candidates = [];
	for (const item of toArray(payload.embeddedSourceEvidence)) candidates.push(item);
	const sourceBundle = payload.sourceBundle;
	if (sourceBundle && typeof sourceBundle === "object" && !Array.isArray(sourceBundle)) {
		for (const item of toArray(sourceBundle.files)) candidates.push(item);
	}
	for (const item of toArray(payload.sourceEvidence)) candidates.push(item);
	return candidates;
}

function normalizeEmbeddedSourceFile(item, fallbackRepo, maxFileBytes, remainingBytes) {
	if (!item || typeof item !== "object" || Array.isArray(item)) return { warning: "skipped malformed embedded source evidence" };
	const repo = safeText(item.repo || item.repository || fallbackRepo || "embedded", "embedded");
	const path = safeText(item.path || item.file || item.name, "");
	if (!isSafeRelativePath(path)) return { warning: `skipped unsafe embedded source path: ${path || "<empty>"}` };
	const rawContent = typeof item.content === "string" ? item.content : typeof item.text === "string" ? item.text : "";
	if (!rawContent) return { warning: `skipped empty embedded source file: ${repo}:${path}` };
	const maxBytes = Math.max(0, Math.min(maxFileBytes, remainingBytes));
	const buffer = Buffer.from(rawContent, "utf8");
	const truncated = buffer.length > maxBytes;
	const content = buffer.subarray(0, maxBytes).toString("utf8");
	return { file: { repo, path, content, truncated, bytes: buffer.length } };
}

function collectSourceBundle(payload, env) {
	const repoMap = parseRepoMap(env);
	const repos = collectRepos(payload);
	if (repos.length === 0 && repoMap.has("__default__")) repos.push({ name: "__default__" });

	const maxFiles = positiveIntegerEnv(env.A2A_PIRI_ANALYSIS_MAX_FILES || env.A2A_HERMES_ANALYSIS_MAX_FILES, DEFAULT_MAX_FILES);
	const maxFileBytes = positiveIntegerEnv(env.A2A_PIRI_ANALYSIS_MAX_FILE_BYTES || env.A2A_HERMES_ANALYSIS_MAX_FILE_BYTES, DEFAULT_MAX_FILE_BYTES);
	const maxTotalBytes = positiveIntegerEnv(env.A2A_PIRI_ANALYSIS_MAX_TOTAL_BYTES || env.A2A_HERMES_ANALYSIS_MAX_TOTAL_BYTES, DEFAULT_MAX_TOTAL_BYTES);
	const maxTreeEntries = positiveIntegerEnv(env.A2A_PIRI_ANALYSIS_MAX_TREE_ENTRIES || env.A2A_HERMES_ANALYSIS_MAX_TREE_ENTRIES, DEFAULT_MAX_TREE_ENTRIES);

	const files = [];
	const warnings = [];
	let totalBytes = 0;

	const fallbackRepo = safeText(payload.repo || payload.repository || "embedded", "embedded");
	for (const embedded of collectEmbeddedSourceEvidence(payload)) {
		if (files.length >= maxFiles || totalBytes >= maxTotalBytes) break;
		const remaining = Math.max(0, maxTotalBytes - totalBytes);
		const normalized = normalizeEmbeddedSourceFile(embedded, fallbackRepo, maxFileBytes, remaining);
		if (normalized.warning) {
			warnings.push(normalized.warning);
			continue;
		}
		if (normalized.file) {
			files.push(normalized.file);
			totalBytes += Math.min(normalized.file.bytes, maxFileBytes, remaining);
		}
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

	return { files, warnings, limits: { maxFiles, maxFileBytes, maxTotalBytes, maxTreeEntries } };
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

function buildPiriPrompt({ message, payload, sourceBundle, flags, model, thinking }) {
	const sourceSections = sourceBundle.files.map((file) => [
		`### ${file.repo}:${file.path}${file.truncated ? " (truncated)" : ""}`,
		"```text",
		file.content,
		"```",
	].join("\n"));

	const warningSection = sourceBundle.warnings.length
		? `\n\nRead-only source warnings:\n${sourceBundle.warnings.map((item) => `- ${item}`).join("\n")}`
		: "";

	const reviewRequired = payload?.review?.required === true;
	return [
		"You are a read-only A2A worker analysis bridge running under the piri harness.",
		"Your job is to inspect the provided task and source bundle, then produce substantive design/code-analysis evidence.",
		"Hard safety rules: do not write files, deploy, restart services, send external messages, acknowledge terminal rows, mutate databases, move secrets, create commits, or open PRs.",
		"Use only the task text and the read-only source bundle below. If source evidence is insufficient, return status=blocked and explain the missing evidence.",
		"Your final answer must satisfy the attached output schema: a JSON object with status (done|blocked), summary, findings, risks, recommendations, evidenceRefs (string arrays), optional verdict (pass|fail), and optional doneCommentUrl/blockCommentUrl/startCommentUrl. No markdown, no commentary outside the JSON value.",
		reviewRequired
			? "This task has payload.review.required=true. The top-level verdict field is REQUIRED: use pass for PASS and fail for BLOCK. Do not rely on summary wording as the verdict carrier."
			: "",
		"Human-readable text should be Korean unless quoting code, paths, or test output.",
		`OpenClaw-shaped session id: ${safeText(flags["session-id"], "")}`,
		`Effective model requested by worker: ${model}`,
		`Effective thinking requested by worker: ${thinking}`,
		`Task payload JSON:\n${JSON.stringify(payload, null, 2)}`,
		`Original worker message:\n${message}`,
		`Read-only source bundle (${sourceBundle.files.length} files):`,
		sourceSections.length ? sourceSections.join("\n\n") : "<no source files available>",
		warningSection,
	].join("\n\n");
}

function applyPiriPromptBudget(prompt, env) {
	const maxPromptBytes = positiveIntegerEnv(env.A2A_PIRI_ANALYSIS_MAX_PROMPT_BYTES, DEFAULT_MAX_PROMPT_BYTES);
	const promptBytes = Buffer.byteLength(prompt, "utf8");
	if (promptBytes <= maxPromptBytes) return prompt;
	const suffix = [
		"",
		"",
		`[truncated by piri-a2a-analysis-bridge prompt budget: originalBytes=${promptBytes} maxBytes=${maxPromptBytes}.]`,
	].join("\n");
	const suffixBytes = Buffer.byteLength(suffix, "utf8");
	const prefixBudget = Math.max(0, maxPromptBytes - suffixBytes);
	return truncateUtf8ToBytes(`${truncateUtf8ToBytes(prompt, prefixBudget)}${suffix}`, maxPromptBytes);
}

function sanitizeName(value) {
	return safeText(value, "task").replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "task";
}

function bridgeError({ code, stage, failureShape, message, elapsedMs }) {
	const detail = {
		code,
		stage,
		failureShape,
		adapterClass: "piri",
		bridgeContractVersion: BRIDGE_CONTRACT_VERSION,
		structuredOutputMode: STRUCTURED_OUTPUT_MODE,
		elapsedMs,
	};
	console.error(`A2A_BRIDGE_ERROR=${JSON.stringify(detail)}`);
	if (message) console.error(String(message).slice(0, 2000));
	process.exit(1);
}

function normalizeResponse(parsed) {
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("piri response JSON must be an object");
	}
	const statusRaw = safeText(parsed.status, "").toLowerCase();
	if (!["done", "blocked"].includes(statusRaw)) throw new Error(`piri response status must be done|blocked, got ${statusRaw || "<missing>"}`);
	const verdictRaw = safeText(parsed.verdict, "").toLowerCase();
	const verdict = ["pass", "passed", "approve", "approved"].includes(verdictRaw)
		? "pass"
		: ["fail", "failed", "block", "blocked", "reject", "rejected"].includes(verdictRaw)
			? "fail"
			: "";
	return {
		status: statusRaw,
		summary: safeText(parsed.summary, statusRaw === "blocked" ? "analysis blocked" : "analysis complete"),
		findings: normalizeStringArray(parsed.findings),
		risks: normalizeStringArray(parsed.risks),
		recommendations: normalizeStringArray(parsed.recommendations),
		evidenceRefs: normalizeStringArray(parsed.evidenceRefs),
		...(verdict ? { verdict } : {}),
		...(safeText(parsed.doneCommentUrl, "") ? { doneCommentUrl: safeText(parsed.doneCommentUrl) } : {}),
		...(safeText(parsed.blockCommentUrl, "") ? { blockCommentUrl: safeText(parsed.blockCommentUrl) } : {}),
		...(safeText(parsed.startCommentUrl, "") ? { startCommentUrl: safeText(parsed.startCommentUrl) } : {}),
	};
}

function normalizeStringArray(value) {
	if (!Array.isArray(value)) return [];
	return value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim());
}

/**
 * Run piri in the runner image with the schema-locked analysis contract.
 * The task workdir is bind-mounted at /work so the model reads the prompt
 * from a file (no argv budget) and the content-free progress file lands on
 * the host while the task is still running.
 */
function runPiri({ prompt, model, thinking, timeoutSec, sessionId, env }) {
	const image = safeText(env.A2A_PIRI_RUNNER_IMAGE, DEFAULT_PIRI_IMAGE);
	const configDir = safeText(env.A2A_PIRI_CONFIG_DIR || env.A2A_DOCKER_RUNNER_PIRI_CONFIG_DIR, DEFAULT_PIRI_CONFIG_DIR);
	const authFile = join(configDir, "agent", "auth.json");
	if (!existsSync(authFile)) {
		throw new Error(`piri credential file does not exist: ${authFile}`);
	}
	const workRoot = safeText(env.A2A_PIRI_WORK_ROOT, DEFAULT_PIRI_WORK_ROOT);
	const network = safeText(env.A2A_PIRI_NETWORK, "bridge");
	const dockerBin = safeText(env.A2A_PIRI_DOCKER_BIN, "docker");
	const taskName = sanitizeName(sessionId || `piri-${Date.now()}`);
	const workDir = join(workRoot, taskName);
	const authMountPoint = join(workDir, "piri-home", ".piri", "agent", "auth.json");
	mkdirSync(join(workDir, "artifacts"), { recursive: true });
	mkdirSync(join(workDir, "piri-home", ".piri", "agent"), { recursive: true });
	writeFileSync(authMountPoint, "", { mode: 0o600 });
	writeFileSync(join(workDir, "prompt.md"), prompt, "utf8");
	// piri opens progress files in append mode. Reset this invocation's file so
	// a retried/reused session id cannot inherit request counts from an older run.
	writeFileSync(join(workDir, "artifacts", "piri-progress.jsonl"), "", "utf8");

	const inner = [
		"set -euo pipefail",
		"export HOME=/work/piri-home",
		`exec piri -p "$(cat /work/prompt.md)" --model ${shellQuote(model)} --thinking ${shellQuote(thinking)} --approve --no-session --output-schema ${IMAGE_SCHEMA_PATH} --progress-file /work/artifacts/piri-progress.jsonl`,
	].join(" && ");

	const containerName = `a2a-piri-analysis-${taskName}-${Date.now()}`;
	const args = [
		"run", "--rm", "--name", containerName,
		"--network", network,
		"-v", `${workDir}:/work`,
		"-v", `${authFile}:/work/piri-home/.piri/agent/auth.json:ro`,
		image,
		"bash", "-c", inner,
	];
	const startedAt = Date.now();
	const child = spawnSync(dockerBin, args, {
		env,
		encoding: "utf8",
		maxBuffer: 50 * 1024 * 1024,
		timeout: (timeoutSec + 30) * 1000,
		killSignal: "SIGKILL",
	});
	// Docker requires a target file for the nested bind mount. It remains empty
	// on the host and is removed after the container exits; credential bytes are
	// never copied into the task workdir.
	rmSync(authMountPoint, { force: true });
	const elapsedMs = Date.now() - startedAt;
	if (child.error || child.signal) {
		spawnSync(dockerBin, ["rm", "-f", containerName], { env, stdio: "ignore" });
	}
	return { child, elapsedMs, workDir };
}

function shellQuote(value) {
	return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function main() {
	const flags = parseArgs(process.argv);
	if (flags.subcommand !== "agent") die("expected OpenClaw-shaped subcommand: agent");
	if (!flags.json) die("expected --json flag");
	const message = safeText(flags.message, "");
	if (!message) die("missing --message");

	const env = process.env;
	let payload;
	try {
		payload = payloadFromStructuredEnv(env) ?? extractPayload(message);
	} catch (error) {
		die(error.message);
	}

	let sourceBundle;
	try {
		sourceBundle = collectSourceBundle(payload, env);
	} catch (error) {
		die(`failed to collect read-only source bundle: ${error.message}`);
	}

	const model = safeText(env.A2A_PIRI_ANALYSIS_MODEL || env.A2A_PIRI_MODEL, DEFAULT_PIRI_MODEL);
	const thinking = safeText(env.A2A_PIRI_ANALYSIS_THINKING || env.A2A_PIRI_THINKING, DEFAULT_PIRI_THINKING);
	const timeoutSec = positiveIntegerEnv(flags.timeout || env.A2A_PIRI_ANALYSIS_TIMEOUT_SEC, DEFAULT_TIMEOUT_SEC);
	const prompt = applyPiriPromptBudget(
		buildPiriPrompt({ message, payload, sourceBundle, flags, model, thinking }),
		env,
	);

	let invocation;
	try {
		invocation = runPiri({ prompt, model, thinking, timeoutSec, sessionId: safeText(flags["session-id"], ""), env });
	} catch (error) {
		bridgeError({
			code: "analysis_bridge_credential_unavailable",
			stage: "preflight",
			failureShape: "handler_artifact_failure",
			message: error instanceof Error ? error.message : String(error),
			elapsedMs: 0,
		});
	}
	const { child, elapsedMs, workDir } = invocation;
	const executionTelemetry = piriExecutionTelemetry(join(workDir, "artifacts", "piri-progress.jsonl"), elapsedMs);

	if (child.error) {
		bridgeError({
			code: "analysis_bridge_spawn_failed",
			stage: "spawn",
			failureShape: "handler_artifact_failure",
			message: child.error.message,
			elapsedMs,
		});
	}
	if (child.signal || child.status === null) {
		bridgeError({
			code: "analysis_bridge_timeout",
			stage: "invoke",
			failureShape: "provider_or_model_failure",
			message: `piri analysis run killed by signal ${child.signal || "unknown"}`,
			elapsedMs,
		});
	}
	if (child.status === 2) {
		bridgeError({
			code: "analysis_bridge_invocation_invalid",
			stage: "invoke",
			failureShape: "handler_artifact_failure",
			message: safeText(child.stderr, "piri exited 2 (usage/config error)"),
			elapsedMs,
		});
	}
	// jinwon-int/piri#14 stable exit contract: 3 = provider/request failure,
	// 4 = output schema unsatisfied within the attempt budget.
	if (child.status === 3) {
		bridgeError({
			code: "analysis_bridge_provider_failure",
			stage: "invoke",
			failureShape: "provider_or_model_failure",
			message: safeText(child.stderr, "piri exited 3 (provider/request failure)"),
			elapsedMs,
		});
	}
	if (child.status === 4) {
		bridgeError({
			code: "analysis_bridge_schema_unsatisfied",
			stage: "validate",
			failureShape: "provider_or_model_failure",
			message: safeText(child.stderr, "piri could not satisfy the output schema within the attempt budget"),
			elapsedMs,
		});
	}
	if (child.status !== 0) {
		// Pre-contract piri builds returned 1 for provider and schema failures
		// alike; treat any other non-zero as an internal harness failure.
		bridgeError({
			code: "analysis_bridge_internal_error",
			stage: "invoke",
			failureShape: "provider_or_model_failure",
			message: safeText(child.stderr, `piri exited ${child.status} (internal error)`),
			elapsedMs,
		});
	}

	let parsed;
	try {
		parsed = JSON.parse(safeText(child.stdout, ""));
	} catch {
		bridgeError({
			code: "analysis_bridge_invalid_json",
			stage: "extract",
			failureShape: "provider_or_model_failure",
			message: "schema-locked piri stdout was not valid JSON (contract regression)",
			elapsedMs,
		});
	}

	let response;
	try {
		response = {
			...normalizeResponse(parsed),
			bridgeAdapter: "piri",
			bridgeContractVersion: BRIDGE_CONTRACT_VERSION,
			requestedModel: safeText(flags.model, undefined),
			requestedThinking: safeText(flags.thinking, undefined),
			actualRuntimeModel: model,
			modelInheritanceMode: "bridge_env_pin",
			executionTelemetry,
		};
	} catch (error) {
		bridgeError({
			code: "analysis_bridge_invalid_shape",
			stage: "validate",
			failureShape: "provider_or_model_failure",
			message: error.message,
			elapsedMs,
		});
	}

	process.stdout.write(JSON.stringify({ payloads: [{ text: JSON.stringify(response) }] }));
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`;
if (isDirectRun) main();

export const __test = Object.freeze({
	extractPayload,
	payloadFromStructuredEnv,
	collectSourceBundle,
	buildPiriPrompt,
	normalizeResponse,
	applyPiriPromptBudget,
	parseArgs,
	sanitizeName,
});
