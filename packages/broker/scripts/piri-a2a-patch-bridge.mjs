#!/usr/bin/env node
/**
 * Host Piri A2A PATCH bridge (jinwon-int/a2a-nexus#1886).
 *
 * Non-docker GitHub patch path. Analysis stays on piri-a2a-analysis-bridge.mjs.
 * Docker GitHub patch stays on A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=piri.
 *
 * Handler contract (same as claude-a2a-patch-bridge.mjs):
 *   argv:   agent --local --agent <id> --session-id <id> --message <prompt>
 *           --model <m> --thinking <t> --timeout <sec> --json
 *   stdout: {"payloads":[{"text": "<patch result JSON string>"}]}
 *   stderr: A2A_BRIDGE_ERROR={...} on failure
 *
 * Split of responsibility (matches docker piri runner):
 *   - Piri edits files in the checkout only. It must not git commit/push or gh pr create.
 *   - This bridge owns clone/branch/commit/push/gh pr create and the evidence URLs.
 */
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT_SEC = 1800;
const DEFAULT_PIRI_MODEL = "kimi-coding/k3";
const DEFAULT_PIRI_THINKING = "high";
const DEFAULT_PIRI_CONFIG_DIR = "/var/lib/a2a-runner/piri-dir";
const BRIDGE_CONTRACT_VERSION = "piri-a2a-patch.v1";
const BOOTSTRAP_LEAK = /(^|\/)(\.env|\.piri|AGENTS\.md|SOUL\.md|\.openclaw)(\/|$)/i;
// Mirrors packages/broker/src/worker-acceptance.ts (#1218) so the bridge-side
// execution follows the same acceptance contract rules as the worker client.
const DEFAULT_ACCEPTANCE_TIMEOUT_MS = 120_000;
const MAX_ACCEPTANCE_NOTE_COMMAND_LENGTH = 200;

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

function sanitizeName(value) {
	return safeText(value).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80) || "default";
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
		flags[key] = args[i + 1];
		i += 1;
	}
	return flags;
}

function isPatchIntent(message) {
	const text = safeText(message);
	return (
		/GitHub development assignment/i.test(text) ||
		/open a pull request/i.test(text) ||
		/"prUrl"/.test(text) ||
		/pr_opened/.test(text)
	);
}

function parseTaskContext(message) {
	const text = safeText(message);
	const repoMatch = /Repository:\s*([^\s\n]+)/.exec(text);
	const issueHash = /Issue:\s*#(\d+)/.exec(text);
	const issueUrlBare = /Issue URL:\s*(\S+)/.exec(text);
	const issueUrlHash = /github\.com\/[^/\s]+\/[^/\s]+\/issues\/(\d+)/.exec(
		safeText(issueUrlBare && issueUrlBare[1], ""),
	);
	return {
		repo: repoMatch ? safeText(repoMatch[1]) : "",
		issueNumber: issueHash ? issueHash[1] : issueUrlHash ? issueUrlHash[1] : "",
	};
}

/**
 * Parse task.payload.acceptance from the handler prompt (#1904).
 *
 * The handler prompt ends with `Payload JSON:\n{...}` (a2a-task-handler.mjs
 * runOpenClawBridge), so the LAST occurrence of that marker is the task
 * payload. Truncated or malformed payloads return null — the worker client
 * then falls back to its own execution. All shape rules mirror the broker's
 * acceptance contract (#1218): command is a non-empty string argv,
 * expectExitCode an integer (default 0), timeoutMs a positive finite number
 * (default 120s).
 */
function parseAcceptanceSpec(message) {
	const marker = "Payload JSON:\n";
	const idx = safeText(message).lastIndexOf(marker);
	if (idx === -1) return null;
	const rest = safeText(message).slice(idx + marker.length).trim();
	if (!rest.startsWith("{")) return null;
	let payload;
	try {
		payload = JSON.parse(rest);
	} catch {
		return null;
	}
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
	const raw = payload.acceptance;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const { command } = raw;
	if (!Array.isArray(command) || command.length === 0 || !command.every((part) => typeof part === "string" && part.length > 0)) {
		return null;
	}
	let expectExitCode = 0;
	if (raw.expectExitCode !== undefined) {
		if (typeof raw.expectExitCode !== "number" || !Number.isInteger(raw.expectExitCode)) return null;
		expectExitCode = raw.expectExitCode;
	}
	let timeoutMs = DEFAULT_ACCEPTANCE_TIMEOUT_MS;
	if (raw.timeoutMs !== undefined) {
		if (typeof raw.timeoutMs !== "number" || !Number.isFinite(raw.timeoutMs) || raw.timeoutMs <= 0) return null;
		timeoutMs = raw.timeoutMs;
	}
	return { command, expectExitCode, timeoutMs };
}

/**
 * Execute the acceptance spec inside the patch clone (#1904). The worker
 * client cannot run it there: its cwd has no checkout, and this bridge
 * deletes the clone in `finally`. The verdict mirrors the worker's
 * TaskValidationPayload smoke shape (worker-acceptance.ts runTaskAcceptance)
 * so the client adopts it instead of re-running a doomed local spawn.
 */
function runAcceptanceInClone({ spec, cloneDir, env }) {
	const startedAt = Date.now();
	const [bin, ...args] = spec.command;
	const run = runTool(bin, args, { cwd: cloneDir, env, timeoutMs: spec.timeoutMs });
	const durationMs = Date.now() - startedAt;
	const timedOut = Boolean(run.error) && run.error.code === "ETIMEDOUT";
	const exitCode = typeof run.status === "number" ? run.status : -1;
	const pass = !run.error && exitCode === spec.expectExitCode;
	const commandNote = spec.command.join(" ").slice(0, MAX_ACCEPTANCE_NOTE_COMMAND_LENGTH);
	return {
		kind: "smoke",
		verdict: pass ? "pass" : "fail",
		metrics: {
			acceptance: true,
			exitCode,
			expectedExitCode: spec.expectExitCode,
			durationMs,
			timedOut,
		},
		note: pass
			? `acceptance passed: ${commandNote}`
			: `acceptance failed (${timedOut ? "timeout" : `exit ${exitCode}, expected ${spec.expectExitCode}`}): ${commandNote}`,
		acceptanceContext: "piri-host-patch-clone",
	};
}

function buildPiriPatchPrompt(message) {
	return [
		"You are a Piri-backed A2A GitHub PATCH worker on the host (non-docker fallback).",
		"HARD CONSTRAINTS:",
		"- Edit files only inside the current working directory checkout.",
		"- Do NOT run git commit, git push, git checkout, git switch, merge, rebase, or gh pr create. The bridge owns those after you exit.",
		"- Do NOT print secrets, tokens, or .env contents.",
		"- Do NOT modify AGENTS.md, SOUL.md, .piri/, or .openclaw/.",
		"- If you cannot finish safely, write nothing and print a one-line blocker starting with BLOCK:",
		"- Otherwise print a short summary of files you changed. The bridge will open the pull request.",
		"",
		"----- BROKER TASK -----",
		message,
	].join("\n");
}

function bridgeError({ code, message, extra = {}, exitCode = 1 }) {
	const record = { code, message, bridgeAdapter: "piri", bridgeContractVersion: BRIDGE_CONTRACT_VERSION, ...extra };
	process.stderr.write(`A2A_BRIDGE_ERROR=${JSON.stringify(record)}\n`);
	process.exit(exitCode);
}

function resolvePiriBin(env = process.env) {
	const explicit = safeText(env.A2A_PIRI_CLI);
	if (explicit) return explicit;
	if (existsSync("/opt/piri/piri-test.sh")) return "/opt/piri/piri-test.sh";
	return "piri";
}

function resolvePiriConfigDir(env = process.env) {
	return safeText(env.A2A_PIRI_CONFIG_DIR || env.A2A_DOCKER_RUNNER_PIRI_CONFIG_DIR, DEFAULT_PIRI_CONFIG_DIR);
}

function copyPiriHome(configDir, destHome) {
	const authFile = join(configDir, "agent", "auth.json");
	if (!existsSync(authFile)) {
		throw new Error(`piri credential file does not exist: ${authFile}`);
	}
	mkdirSync(join(destHome, ".piri", "agent"), { recursive: true });
	// Copy the auth file bytes only. Do not log contents.
	writeFileSync(join(destHome, ".piri", "agent", "auth.json"), readFileSync(authFile), { mode: 0o600 });
	const models = join(configDir, "models-store.json");
	if (existsSync(models)) {
		writeFileSync(join(destHome, ".piri", "models-store.json"), readFileSync(models), { mode: 0o600 });
	}
}

function runTool(bin, args, { cwd, env, timeoutMs }) {
	return spawnSync(bin, args, {
		cwd,
		env,
		encoding: "utf8",
		maxBuffer: 20 * 1024 * 1024,
		timeout: timeoutMs,
		killSignal: "SIGKILL",
	});
}

function runPiriEdit({ prompt, model, thinking, timeoutSec, cloneDir, piriHome, env }) {
	const bin = resolvePiriBin(env);
	const promptFile = join(piriHome, "prompt.md");
	writeFileSync(promptFile, prompt, "utf8");
	const childEnv = { ...env, HOME: piriHome };
	const args = [
		"-p",
		readFileSync(promptFile, "utf8"),
		"--model",
		model,
		"--thinking",
		thinking,
		"--approve",
		"--no-session",
	];
	return runTool(bin, args, { cwd: cloneDir, env: childEnv, timeoutMs: (timeoutSec + 30) * 1000 });
}

function listChangedFiles(cloneDir, env) {
	const child = runTool("git", ["-C", cloneDir, "status", "--porcelain"], {
		cwd: cloneDir,
		env,
		timeoutMs: 30_000,
	});
	if (child.status !== 0) {
		throw new Error(safeText(child.stderr, "git status failed"));
	}
	return safeText(child.stdout)
		.split("\n")
		.map((line) => {
			const match = /^(?:[ MADRCU?!]{1,2}) (.*)$/.exec(line);
			return (match ? match[1] : line).trim();
		})
		.filter(Boolean);
}

function isBootstrapLeakPath(path) {
	return BOOTSTRAP_LEAK.test(path);
}

function cloneAndBranch({ repo, cloneDir, branch, env }) {
	const clone = runTool("gh", ["repo", "clone", repo, cloneDir, "--", "--depth", "1"], {
		cwd: tmpdir(),
		env,
		timeoutMs: 180_000,
	});
	if (clone.status !== 0) {
		throw new Error(safeText(clone.stderr, `gh repo clone failed for ${repo}`));
	}
	const checkout = runTool("git", ["-C", cloneDir, "checkout", "-b", branch], {
		cwd: cloneDir,
		env,
		timeoutMs: 30_000,
	});
	if (checkout.status !== 0) {
		throw new Error(safeText(checkout.stderr, "git checkout -b failed"));
	}
}

function commitPushAndCreatePr({ cloneDir, repo, branch, issueNumber, filesChanged, env }) {
	const add = runTool("git", ["-C", cloneDir, "add", "-A"], { cwd: cloneDir, env, timeoutMs: 30_000 });
	if (add.status !== 0) throw new Error(safeText(add.stderr, "git add failed"));
	const label = issueNumber ? `#${issueNumber}` : "patch";
	const commit = runTool(
		"git",
		["-C", cloneDir, "commit", "-m", `a2a(piri-host): ${label}`],
		{ cwd: cloneDir, env, timeoutMs: 30_000 },
	);
	if (commit.status !== 0) throw new Error(safeText(commit.stderr, "git commit failed"));
	const push = runTool(
		"git",
		["-C", cloneDir, "push", "-u", "origin", branch],
		{ cwd: cloneDir, env, timeoutMs: 180_000 },
	);
	if (push.status !== 0) throw new Error(safeText(push.stderr, "git push failed"));
	const title = issueNumber ? `a2a(piri-host): patch for #${issueNumber}` : "a2a(piri-host): patch";
	const body = [
		issueNumber ? `Closes #${issueNumber}` : "A2A host Piri patch.",
		"",
		"Generated by piri-a2a-patch-bridge.mjs. Piri edited files; the bridge opened the PR.",
		"",
		"Files changed:",
		...filesChanged.map((file) => `- \`${file}\``),
	].join("\n");
	const pr = runTool(
		"gh",
		// --head is required: a "gh repo clone --depth 1" checkout has a single-branch
		// fetch refspec, so a freshly pushed branch gets no local remote-tracking ref
		// and gh aborts with "you must first push the current branch to a remote".
		["pr", "create", "--repo", repo, "--head", branch, "--title", title, "--body", body],
		{ cwd: cloneDir, env, timeoutMs: 120_000 },
	);
	if (pr.status !== 0) throw new Error(safeText(pr.stderr, "gh pr create failed"));
	const prUrl = safeText(pr.stdout).split(/\s+/).find((token) => token.startsWith("https://")) || safeText(pr.stdout);
	if (!prUrl.startsWith("https://")) {
		throw new Error("gh pr create produced no parseable prUrl");
	}
	return prUrl;
}

function normalizePatchResponse(result) {
	return {
		status: safeText(result.status, "pr_opened"),
		summary: safeText(result.summary),
		branch: safeText(result.branch, undefined),
		prUrl: safeText(result.prUrl, undefined),
		doneCommentUrl: safeText(result.doneCommentUrl, undefined),
		blockCommentUrl: safeText(result.blockCommentUrl, undefined),
		filesChanged: Array.isArray(result.filesChanged) ? result.filesChanged : [],
		tests: Array.isArray(result.tests) ? result.tests : [],
		risks: Array.isArray(result.risks) ? result.risks : [],
		...(result.acceptance && typeof result.acceptance === "object"
			? { acceptance: result.acceptance }
			: {}),
		bridgeAdapter: "piri",
		bridgeContractVersion: BRIDGE_CONTRACT_VERSION,
	};
}

function emitSuccess(result) {
	process.stdout.write(`${JSON.stringify({ payloads: [{ text: JSON.stringify(normalizePatchResponse(result)) }] })}\n`);
}

function runPatch(message, flags, env = process.env) {
	const context = parseTaskContext(message);
	if (!context.repo) {
		bridgeError({
			code: "patch_bridge_invalid_task",
			message: "host piri patch requires Repository: <owner/repo> in the task message",
			exitCode: 2,
		});
	}
	const model = safeText(env.A2A_PIRI_MODEL, DEFAULT_PIRI_MODEL);
	const thinking = safeText(env.A2A_PIRI_THINKING || flags.thinking, DEFAULT_PIRI_THINKING);
	const timeoutSec = positiveIntegerEnv(flags.timeout || env.A2A_PIRI_TIMEOUT_SEC, DEFAULT_TIMEOUT_SEC);
	const sessionId = sanitizeName(flags["session-id"] || `piri-patch-${Date.now()}`);
	const workspace = mkdtempSync(join(tmpdir(), `a2a-piri-patch-${sessionId}-`));
	const cloneDir = join(workspace, "repo");
	const piriHome = join(workspace, "piri-home");
	const branch = `a2a/piri-host-${Date.now().toString(36)}`;
	// Acceptance (#1904): the clone is the only place the patched files exist,
	// so the spec (if any) must execute here, before the `finally` cleanup.
	const acceptanceSpec = parseAcceptanceSpec(message);
	try {
		copyPiriHome(resolvePiriConfigDir(env), piriHome);
		cloneAndBranch({ repo: context.repo, cloneDir, branch, env });
		const child = runPiriEdit({
			prompt: buildPiriPatchPrompt(message),
			model,
			thinking,
			timeoutSec,
			cloneDir,
			piriHome,
			env,
		});
		if (child.error) {
			bridgeError({
				code: "patch_bridge_spawn_failed",
				message: child.error.message,
				extra: { elapsedHint: "spawn" },
			});
		}
		if (child.signal || child.status === null) {
			bridgeError({
				code: "patch_bridge_timeout",
				message: `piri patch run killed by signal ${child.signal || "unknown"}`,
			});
		}
		if (child.status === 2) {
			bridgeError({
				code: "patch_bridge_invocation_invalid",
				message: safeText(child.stderr, "piri exited 2 (usage/config error)"),
				exitCode: 2,
			});
		}
		if (child.status === 3) {
			bridgeError({
				code: "patch_bridge_provider_failure",
				message: safeText(child.stderr, "piri exited 3 (provider/request failure)"),
			});
		}
		if (child.status !== 0) {
			bridgeError({
				code: "patch_bridge_internal_error",
				message: safeText(child.stderr, `piri exited ${child.status}`),
			});
		}
		const stdout = safeText(child.stdout);
		const acceptanceReport = acceptanceSpec
			? runAcceptanceInClone({ spec: acceptanceSpec, cloneDir, env })
			: null;
		if (/^BLOCK:/m.test(stdout)) {
			emitSuccess({
				status: "blocked",
				summary: stdout.split("\n").find((line) => line.startsWith("BLOCK:")) || stdout,
				filesChanged: [],
				...(acceptanceReport ? { acceptance: acceptanceReport } : {}),
			});
			return;
		}
		const filesChanged = listChangedFiles(cloneDir, env);
		const leaked = filesChanged.filter(isBootstrapLeakPath);
		if (leaked.length > 0) {
			bridgeError({
				code: "patch_bridge_bootstrap_leak",
				message: `patch blocked: bootstrap/agent-context files changed (${leaked.join(", ")})`,
			});
		}
		if (filesChanged.length === 0) {
			bridgeError({
				code: "patch_bridge_no_changes",
				message: "piri exited 0 but the checkout has no file changes",
			});
		}
		const prUrl = commitPushAndCreatePr({
			cloneDir,
			repo: context.repo,
			branch,
			issueNumber: context.issueNumber,
			filesChanged,
			env,
		});
		emitSuccess({
			status: "pr_opened",
			summary: `host piri patch opened ${prUrl}`,
			branch,
			prUrl,
			filesChanged,
			...(acceptanceReport ? { acceptance: acceptanceReport } : {}),
		});
	} catch (error) {
		bridgeError({
			code: "patch_bridge_failed",
			message: error instanceof Error ? error.message : String(error),
		});
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
}

function main() {
	const flags = parseArgs(process.argv);
	if (flags.subcommand !== "agent") die("expected OpenClaw-shaped subcommand: agent");
	if (!flags.json) die("expected --json flag");
	const message = safeText(flags.message, "");
	if (!message) die("missing --message");
	if (!isPatchIntent(message)) {
		bridgeError({
			code: "patch_bridge_wrong_intent",
			message: "piri-a2a-patch-bridge is patch-only; use piri-a2a-analysis-bridge.mjs for analysis",
			exitCode: 2,
		});
	}
	runPatch(message, flags, process.env);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}

export const __test = Object.freeze({
	parseArgs,
	isPatchIntent,
	parseTaskContext,
	parseAcceptanceSpec,
	runAcceptanceInClone,
	buildPiriPatchPrompt,
	resolvePiriBin,
	resolvePiriConfigDir,
	isBootstrapLeakPath,
	normalizePatchResponse,
	sanitizeName,
});
