#!/usr/bin/env node
/**
 * danso A2A analysis bridge (jinwon-int/a2a-nexus#2295, analysis lane only).
 *
 * Same OpenClaw-shaped argv/envelope contract as piri-a2a-analysis-bridge.mjs,
 * backed by the fleet-owned danso harness (jinwon-int/danso) so a node whose
 * main session already runs danso can run its A2A analysis lane on the same
 * harness instead of piri.
 *
 * Handler contract (packages/broker/scripts/a2a-task-handler.mjs):
 *   argv:   agent --local --agent <id> --session-id <id> --message <prompt>
 *           --model <m> --thinking <t> --timeout <sec> --json
 *   stdout: {"payloads":[{"text": "<analysis contract JSON string>"}]}
 *   stderr: A2A_BRIDGE_ERROR={...} on failure (structured, #1725 shape)
 *
 * Execution (native only in this slice; no docker image yet):
 *   danso --cwd <empty workspace> --session <fresh journal> --provider <p>
 *         --model <m> [--reasoning-effort <e>] --no-tools -p
 *         --timeout-seconds <t> --max-turns <n> -- <prompt>
 *
 * Read-only by construction: `--no-tools` means danso advertises and executes
 * no tool at all, so the model can only answer from the prompt's read-only
 * source bundle (the same evidence model the piri lane uses). No sandbox
 * backend is therefore required.
 *
 * Environment: the child receives an allowlist only — PATH, an isolated HOME,
 * the selected provider's credential variable, and DANSO_* endpoint settings.
 * Broker/worker secrets in the worker environment are never forwarded.
 *
 * Output: danso `-p` prints only the final answer. danso has no output-schema
 * flag, so (like the claude bridge) the contract JSON is extracted from the
 * answer text and validated; there is no prose recovery — a wrong shape fails
 * honestly.
 *
 * danso exit-code mapping (danso docs/v0.md "Process contract"):
 *   2              → analysis_bridge_invocation_invalid (handler_artifact_failure)
 *   3              → analysis_bridge_provider_failure (provider_or_model_failure)
 *   124 / signal   → analysis_bridge_timeout (provider_or_model_failure)
 *   other non-zero → analysis_bridge_internal_error (provider_or_model_failure)
 * The bounded DANSO_ERROR category rides along as `dansoErrorCategory`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dansoExecutionTelemetry, parseDansoStderrRecord } from "./lib/analysis-execution-telemetry.mjs";
import {
	collectSourceBundle as collectSharedSourceBundle,
	declaredRequiredCarrierPath,
	extractPayload,
	messageForPrompt,
	payloadForPrompt,
	payloadFromStructuredEnv,
	promptViewTelemetry,
	positiveIntegerEnv,
	safeText,
} from "./lib/analysis-source-bundle.mjs";
import { sourceCarrierStatsFromEnv } from "./lib/source-carriers.mjs";
import { truncateUtf8ToBytesSafe } from "./lib/utf8-byte-budget.mjs";

const ENV_PREFIX = "A2A_DANSO_ANALYSIS";
const DEFAULT_TIMEOUT_SEC = 300;
const MAX_DANSO_TIMEOUT_SEC = 3600; // danso short-mode whole-run maximum
const DEFAULT_MAX_TURNS = 4;
// danso rejects any prompt outside 1..65536 bytes ("prompt must be 1..65536
// bytes") before making a model request, whether the prompt arrives via argv,
// --prompt-file or stdin (#2332). This is also well under Linux MAX_ARG_STRLEN
// (128 KiB per argument). The configured budget can lower the limit but never
// raise it, so an oversized task is truncated instead of failing in danso.
const DANSO_MAX_PROMPT_BYTES = 65536;
const DEFAULT_MAX_PROMPT_BYTES = DANSO_MAX_PROMPT_BYTES;
const DEFAULT_DANSO_PROVIDER = "glm";
const DEFAULT_DANSO_MODEL = "glm-5.3-flash";
const DEFAULT_DANSO_EFFORT = "high";
const DEFAULT_WORK_ROOT = join(tmpdir(), "a2a-danso-analysis-tasks");
const BRIDGE_CONTRACT_VERSION = "danso-a2a-analysis.v1";
const STRUCTURED_OUTPUT_MODE = "prompt_contract_text_extract";

const PROVIDERS = Object.freeze({
	anthropic: { credentialEnv: "ANTHROPIC_API_KEY", credentialKind: "env", effort: false },
	openai: { credentialEnv: "OPENAI_API_KEY", credentialKind: "env", effort: true },
	"openai-codex": { credentialEnv: "DANSO_CHATGPT_AUTH_FILE", credentialKind: "file", effort: true },
	glm: { credentialEnv: "ZAI_API_KEY", credentialKind: "env", effort: true },
});
const EFFORTS = Object.freeze(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
// danso docs/v0.md DANSO_ERROR categories — anything else is reported as "other".
const DANSO_ERROR_CATEGORIES = new Set([
	"configuration", "session", "sandbox", "provider", "provider_timeout", "compaction",
	"request_budget", "output", "runtime", "run_timeout", "interrupted",
]);
// Child environment allowlist (besides PATH/HOME and the credential variable).
const PASSTHROUGH_ENV = /^(DANSO_[A-Z0-9_]+|LANG|LC_[A-Z]+|TZ|SSL_CERT_FILE|SSL_CERT_DIR)$/;

function die(message, code = 1) {
	console.error(message);
	process.exit(code);
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

function collectSourceBundle(payload, env) {
	return collectSharedSourceBundle(payload, env, { prefix: ENV_PREFIX });
}

/** Resolve and validate the danso run configuration from the worker env. */
function resolveDansoConfig(env) {
	const provider = safeText(env.A2A_DANSO_ANALYSIS_PROVIDER || env.A2A_DANSO_PROVIDER, DEFAULT_DANSO_PROVIDER).toLowerCase();
	const spec = PROVIDERS[provider];
	if (!spec) throw new Error(`unsupported danso provider "${provider}" (expected one of ${Object.keys(PROVIDERS).join(", ")})`);
	const model = safeText(env.A2A_DANSO_ANALYSIS_MODEL || env.A2A_DANSO_MODEL, DEFAULT_DANSO_MODEL);
	const effortRaw = safeText(env.A2A_DANSO_ANALYSIS_EFFORT || env.A2A_DANSO_EFFORT, spec.effort ? DEFAULT_DANSO_EFFORT : "");
	const effort = effortRaw.toLowerCase();
	if (effort && !spec.effort) throw new Error(`danso provider "${provider}" does not take a reasoning effort (got "${effort}")`);
	if (effort && !EFFORTS.includes(effort)) throw new Error(`unsupported danso reasoning effort "${effort}" (expected one of ${EFFORTS.join(", ")})`);
	return {
		provider,
		model,
		effort,
		credentialEnv: spec.credentialEnv,
		credentialKind: spec.credentialKind,
		cli: safeText(env.A2A_DANSO_CLI, "danso"),
		maxTurns: positiveIntegerEnv(env.A2A_DANSO_ANALYSIS_MAX_TURNS, DEFAULT_MAX_TURNS),
		providerTimeoutSec: positiveIntegerEnv(env.A2A_DANSO_PROVIDER_TIMEOUT_SECONDS, 0),
		maxOutputTokens: positiveIntegerEnv(env.A2A_DANSO_MAX_OUTPUT_TOKENS, 0),
	};
}

/** Presence check only — the credential value is never read or logged here. */
function credentialAvailable(config, env) {
	const value = safeText(env[config.credentialEnv], "");
	if (!value) return false;
	if (config.credentialKind !== "file") return true;
	try {
		return statSync(value).isFile();
	} catch {
		return false;
	}
}

function buildDansoChildEnv(env, config, homeDir) {
	const child = {
		PATH: safeText(env.PATH, "/usr/local/bin:/usr/bin:/bin"),
		HOME: homeDir,
	};
	for (const [key, value] of Object.entries(env)) {
		if (typeof value === "string" && PASSTHROUGH_ENV.test(key)) child[key] = value;
	}
	child[config.credentialEnv] = env[config.credentialEnv];
	return child;
}

function buildDansoPrompt({ message, payload, sourceBundle, flags, model, effort }) {
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
		"You are a read-only A2A worker analysis bridge running under the danso harness with no tools.",
		"Your job is to inspect the provided task and source bundle, then produce substantive design/code-analysis evidence.",
		"Hard safety rules: do not write files, deploy, restart services, send external messages, acknowledge terminal rows, mutate databases, move secrets, create commits, or open PRs.",
		"Use only the task text and the read-only source bundle below. If source evidence is insufficient, return status=blocked and explain the missing evidence.",
		"Your final answer must be exactly one JSON object and nothing else (no markdown fences, no commentary): {\"status\": \"done\"|\"blocked\", \"summary\": string, \"findings\": string[], \"risks\": string[], \"recommendations\": string[], \"evidenceRefs\": string[], optional \"verdict\": \"pass\"|\"fail\", optional \"doneCommentUrl\"/\"blockCommentUrl\"/\"startCommentUrl\": string}.",
		reviewRequired
			? "This task has payload.review.required=true. The top-level verdict field is REQUIRED: use pass for PASS and fail for BLOCK. Do not rely on summary wording as the verdict carrier."
			: "",
		"Human-readable text should be Korean unless quoting code, paths, or test output.",
		`OpenClaw-shaped session id: ${safeText(flags["session-id"], "")}`,
		`Effective model requested by worker: ${model}`,
		`Effective reasoning effort requested by worker: ${effort || "<provider default>"}`,
		// #2301: source carrier content is shown exactly once — in the source
		// sections below — so the payload and the worker message only carry
		// {repo, path, bytes} summaries of each file.
		`Task payload JSON (source content summarized; inspect the source sections below):\n${JSON.stringify(payloadForPrompt(payload), null, 2)}`,
		`Original worker message (source content summarized):\n${messageForPrompt(message, payload)}`,
		`Read-only source bundle (${sourceBundle.files.length} files):`,
		sourceSections.length ? sourceSections.join("\n\n") : "<no source files available>",
		warningSection,
	].join("\n\n");
}

function resolveDansoMaxPromptBytes(env) {
	return Math.min(
		DANSO_MAX_PROMPT_BYTES,
		positiveIntegerEnv(env.A2A_DANSO_ANALYSIS_MAX_PROMPT_BYTES, DEFAULT_MAX_PROMPT_BYTES),
	);
}

function applyDansoPromptBudget(prompt, env) {
	const maxPromptBytes = resolveDansoMaxPromptBytes(env);
	const promptBytes = Buffer.byteLength(prompt, "utf8");
	if (promptBytes <= maxPromptBytes) return prompt;
	const suffix = [
		"",
		"",
		`[truncated by danso-a2a-analysis-bridge prompt budget: originalBytes=${promptBytes} maxBytes=${maxPromptBytes}.]`,
	].join("\n");
	const suffixBytes = Buffer.byteLength(suffix, "utf8");
	const prefixBudget = Math.max(0, maxPromptBytes - suffixBytes);
	return truncateUtf8ToBytesSafe(`${truncateUtf8ToBytesSafe(prompt, prefixBudget)}${suffix}`, maxPromptBytes);
}

function sanitizeName(value) {
	return safeText(value, "task").replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "task";
}

/** All balanced top-level `{...}` spans in `text`, string-aware. */
function extractBalancedJsonObjects(text) {
	const candidates = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let escape = false;
	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];
		if (inString) {
			if (escape) escape = false;
			else if (ch === "\\") escape = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			if (depth > 0) inString = true;
			continue;
		}
		if (ch === "{") {
			if (depth === 0) start = i;
			depth += 1;
		} else if (ch === "}" && depth > 0) {
			depth -= 1;
			if (depth === 0 && start >= 0) {
				candidates.push(text.slice(start, i + 1));
				start = -1;
			}
		}
	}
	return candidates;
}

function isContractShaped(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value)
		&& ["done", "blocked"].includes(safeText(value.status, "").toLowerCase());
}

/**
 * Extract the analysis contract object from danso's final answer. Prefer the
 * whole answer; otherwise take the LAST contract-shaped JSON object (models
 * that think aloud put the answer last). Never synthesizes from prose.
 */
function extractContractJson(stdout) {
	const trimmed = safeText(stdout, "");
	if (!trimmed) throw new Error("danso produced an empty final answer");
	try {
		const whole = JSON.parse(trimmed);
		if (isContractShaped(whole)) return whole;
	} catch {
		// fall through to candidate scanning
	}
	const candidates = extractBalancedJsonObjects(trimmed);
	for (let i = candidates.length - 1; i >= 0; i -= 1) {
		try {
			const parsed = JSON.parse(candidates[i]);
			if (isContractShaped(parsed)) return parsed;
		} catch {
			// try the previous candidate
		}
	}
	throw new Error(`danso final answer contained no contract-shaped JSON object (${candidates.length} JSON candidates)`);
}

function normalizeStringArray(value) {
	if (!Array.isArray(value)) return [];
	return value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim());
}

function normalizeResponse(parsed) {
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("danso response JSON must be an object");
	}
	const statusRaw = safeText(parsed.status, "").toLowerCase();
	if (!["done", "blocked"].includes(statusRaw)) throw new Error(`danso response status must be done|blocked, got ${statusRaw || "<missing>"}`);
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

function dansoErrorCategory(stderr) {
	const record = parseDansoStderrRecord(stderr, "DANSO_ERROR");
	if (!record) return undefined;
	const category = safeText(record.category, "");
	return DANSO_ERROR_CATEGORIES.has(category) ? category : "other";
}

function bridgeError({ code, stage, failureShape, message, elapsedMs, context }) {
	const detail = {
		code,
		stage,
		failureShape,
		adapterClass: "danso",
		bridgeContractVersion: BRIDGE_CONTRACT_VERSION,
		structuredOutputMode: STRUCTURED_OUTPUT_MODE,
		elapsedMs,
		...(context ?? {}),
	};
	const bounded = Object.fromEntries(Object.entries(detail).filter(([, value]) => value !== undefined));
	console.error(`A2A_BRIDGE_ERROR=${JSON.stringify(bounded)}`);
	// Only danso's own plain diagnostics (no DANSO_* records, no prompt text)
	// are relayed, and only as a bounded excerpt.
	if (message) console.error(String(message).slice(0, 2000));
	process.exit(1);
}

function plainDiagnostics(stderr) {
	return String(stderr ?? "")
		.split("\n")
		.filter((line) => line.trim() && !/^[A-Z][A-Z0-9_]*=\{/.test(line))
		.join("\n");
}

/**
 * One danso run in a fresh per-task directory:
 *   <work>/workspace   empty cwd (no tools are enabled, so nothing is read)
 *   <work>/home        isolated HOME so node-local danso/Pi context is not loaded
 *   <work>/session     journal parent, outside the workspace (danso requirement)
 */
function runDanso({ prompt, config, timeoutSec, sessionId, env }) {
	const taskName = sanitizeName(sessionId || `danso-${Date.now()}`);
	const workRoot = safeText(env.A2A_DANSO_WORK_ROOT, DEFAULT_WORK_ROOT);
	const workDir = join(workRoot, taskName);
	const workspace = join(workDir, "workspace");
	const homeDir = safeText(env.A2A_DANSO_HOME, join(workDir, "home"));
	const sessionDir = join(workDir, "session");
	for (const dir of [workspace, homeDir, sessionDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
	// A retried/reused session id must not resume an older journal.
	const sessionPath = join(sessionDir, "analysis.jsonl");
	rmSync(sessionPath, { force: true });
	writeFileSync(join(workDir, "prompt.md"), prompt, { encoding: "utf8", mode: 0o600 });

	const args = [
		"--cwd", workspace,
		"--session", sessionPath,
		"--provider", config.provider,
		"--model", config.model,
		...(config.effort ? ["--reasoning-effort", config.effort] : []),
		"--no-tools",
		"-p",
		"--timeout-seconds", String(timeoutSec),
		"--max-turns", String(config.maxTurns),
		...(config.providerTimeoutSec ? ["--provider-timeout-seconds", String(config.providerTimeoutSec)] : []),
		...(config.maxOutputTokens ? ["--max-output-tokens", String(config.maxOutputTokens)] : []),
		"--",
		prompt,
	];
	const startedAt = Date.now();
	const child = spawnSync(config.cli, args, {
		cwd: workspace,
		env: buildDansoChildEnv(env, config, homeDir),
		encoding: "utf8",
		maxBuffer: 50 * 1024 * 1024,
		// danso enforces its own wall timeout (exit 124); this outer kill is the
		// backstop for a wedged process.
		timeout: (timeoutSec + 30) * 1000,
		killSignal: "SIGKILL",
	});
	return { child, elapsedMs: Date.now() - startedAt, workDir };
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
		const structured = payloadFromStructuredEnv(env);
		// #2023 fail-closed: a declared-required file carrier that is not
		// readable here must not silently degrade to the truncated excerpt.
		if (!structured) {
			const requiredCarrier = declaredRequiredCarrierPath(message);
			if (requiredCarrier) {
				bridgeError({
					code: "analysis_payload_carrier_missing",
					stage: "payload",
					failureShape: "blocked_infra",
					message: `handler declared a required full-payload carrier but it is not readable in this bridge environment: ${requiredCarrier}`,
					context: { declaredCarrierPath: requiredCarrier, envFileSet: Boolean(safeText(env.A2A_ANALYSIS_PAYLOAD_FILE, "")) },
				});
			}
		}
		payload = structured ?? extractPayload(message);
	} catch (error) {
		die(error.message);
	}

	let sourceBundle;
	try {
		sourceBundle = collectSourceBundle(payload, env);
	} catch (error) {
		die(`failed to collect read-only source bundle: ${error.message}`);
	}

	const baseContext = (extra = {}) => ({
		requestedModel: safeText(flags.model, undefined),
		requestedThinking: safeText(flags.thinking, undefined),
		modelInheritanceMode: "bridge_env_pin",
		sourceCarrierStats: sourceCarrierStatsFromEnv(env),
		...extra,
	});

	let config;
	try {
		config = resolveDansoConfig(env);
	} catch (error) {
		bridgeError({
			code: "analysis_bridge_invocation_invalid",
			stage: "preflight",
			failureShape: "handler_artifact_failure",
			message: error instanceof Error ? error.message : String(error),
			elapsedMs: 0,
			context: baseContext(),
		});
	}
	const failureContext = (extra = {}) => baseContext({
		actualRuntimeModel: config.model,
		dansoProvider: config.provider,
		dansoEffort: config.effort || undefined,
		...extra,
	});
	if (!credentialAvailable(config, env)) {
		bridgeError({
			code: "analysis_bridge_credential_unavailable",
			stage: "preflight",
			failureShape: "handler_artifact_failure",
			message: `danso provider "${config.provider}" needs ${config.credentialEnv} in the worker environment${config.credentialKind === "file" ? " (pointing at a regular file)" : ""}`,
			elapsedMs: 0,
			context: failureContext(),
		});
	}
	// An explicit CLI path must exist; a bare name is resolved via PATH at spawn.
	if (config.cli.includes("/") && !existsSync(resolve(config.cli))) {
		bridgeError({
			code: "analysis_bridge_invocation_invalid",
			stage: "preflight",
			failureShape: "handler_artifact_failure",
			message: `danso CLI does not exist: ${config.cli}`,
			elapsedMs: 0,
			context: failureContext(),
		});
	}

	const timeoutSec = Math.min(
		MAX_DANSO_TIMEOUT_SEC,
		positiveIntegerEnv(flags.timeout || env.A2A_DANSO_ANALYSIS_TIMEOUT_SEC, DEFAULT_TIMEOUT_SEC),
	);
	const prompt = applyDansoPromptBudget(
		buildDansoPrompt({ message, payload, sourceBundle, flags, model: config.model, effort: config.effort }),
		env,
	);
	// Defensive invariant: the budget above is clamped to danso's limit, so this
	// only fires if that clamp regresses. Fail before spawn rather than in danso.
	if (Buffer.byteLength(prompt, "utf8") > DANSO_MAX_PROMPT_BYTES) {
		bridgeError({
			code: "analysis_bridge_invocation_invalid",
			stage: "preflight",
			failureShape: "handler_artifact_failure",
			message: `danso prompt is ${Buffer.byteLength(prompt, "utf8")} bytes, above danso's ${DANSO_MAX_PROMPT_BYTES}-byte prompt limit`,
			elapsedMs: 0,
			context: failureContext(),
		});
	}

	let invocation;
	try {
		invocation = runDanso({ prompt, config, timeoutSec, sessionId: safeText(flags["session-id"], ""), env });
	} catch (error) {
		bridgeError({
			code: "analysis_bridge_invocation_invalid",
			stage: "preflight",
			failureShape: "handler_artifact_failure",
			message: error instanceof Error ? error.message : String(error),
			elapsedMs: 0,
			context: failureContext(),
		});
	}
	const { child, elapsedMs } = invocation;
	const executionTelemetry = dansoExecutionTelemetry(child.stderr, elapsedMs);
	const invocationFailureContext = () => failureContext({
		executionTelemetry,
		dansoExitCode: typeof child.status === "number" ? child.status : undefined,
		dansoErrorCategory: dansoErrorCategory(child.stderr),
	});
	const diagnostics = () => plainDiagnostics(child.stderr);

	if (child.error && !child.signal) {
		bridgeError({
			code: "analysis_bridge_spawn_failed",
			stage: "spawn",
			failureShape: "handler_artifact_failure",
			message: child.error.message,
			elapsedMs,
			context: invocationFailureContext(),
		});
	}
	if (child.signal || child.status === null || child.status === 124) {
		bridgeError({
			code: "analysis_bridge_timeout",
			stage: "invoke",
			failureShape: "provider_or_model_failure",
			message: child.status === 124
				? `danso whole-run wall timeout (${timeoutSec}s)`
				: `danso analysis run killed by signal ${child.signal || "unknown"}`,
			elapsedMs,
			context: invocationFailureContext(),
		});
	}
	if (child.status === 2) {
		bridgeError({
			code: "analysis_bridge_invocation_invalid",
			stage: "invoke",
			failureShape: "handler_artifact_failure",
			message: safeText(diagnostics(), "danso exited 2 (configuration/preflight failure)"),
			elapsedMs,
			context: invocationFailureContext(),
		});
	}
	if (child.status === 3) {
		bridgeError({
			code: "analysis_bridge_provider_failure",
			stage: "invoke",
			failureShape: "provider_or_model_failure",
			message: safeText(diagnostics(), "danso exited 3 (provider/run failure)"),
			elapsedMs,
			context: invocationFailureContext(),
		});
	}
	if (child.status !== 0) {
		bridgeError({
			code: "analysis_bridge_internal_error",
			stage: "invoke",
			failureShape: "provider_or_model_failure",
			message: safeText(diagnostics(), `danso exited ${child.status}`),
			elapsedMs,
			context: invocationFailureContext(),
		});
	}

	let parsed;
	try {
		parsed = extractContractJson(child.stdout);
	} catch (error) {
		bridgeError({
			code: "analysis_bridge_invalid_json",
			stage: "extract",
			failureShape: "provider_or_model_failure",
			message: error instanceof Error ? error.message : String(error),
			elapsedMs,
			context: invocationFailureContext(),
		});
	}

	let response;
	try {
		response = {
			...normalizeResponse(parsed),
			bridgeAdapter: "danso",
			bridgeContractVersion: BRIDGE_CONTRACT_VERSION,
			requestedModel: safeText(flags.model, undefined),
			requestedThinking: safeText(flags.thinking, undefined),
			actualRuntimeModel: config.model,
			modelInheritanceMode: "bridge_env_pin",
			executionTelemetry,
			// #2303 item 5: content-free byte counters so a quiet prompt-view
			// regression (source content duplicated back into the prompt) is
			// visible as a rising prompt/source ratio.
			promptView: promptViewTelemetry(payload, prompt),
		};
	} catch (error) {
		bridgeError({
			code: "analysis_bridge_invalid_shape",
			stage: "validate",
			failureShape: "provider_or_model_failure",
			message: error.message,
			elapsedMs,
			context: invocationFailureContext(),
		});
	}

	process.stdout.write(JSON.stringify({ payloads: [{ text: JSON.stringify(response) }] }));
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`;
if (isDirectRun) main();

export const __test = Object.freeze({
	parseArgs,
	collectSourceBundle,
	resolveDansoConfig,
	credentialAvailable,
	buildDansoChildEnv,
	buildDansoPrompt,
	resolveDansoMaxPromptBytes,
	applyDansoPromptBudget,
	extractContractJson,
	normalizeResponse,
	dansoErrorCategory,
	plainDiagnostics,
	sanitizeName,
});
