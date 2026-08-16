/**
 * A2A piri fanout `subagent` tool — hardened executor fork.
 *
 * Fork of the piri example extension
 * (jinwon-int/piri v0.83.0-piri.1,
 * packages/coding-agent/examples/extensions/subagent/index.ts) hardened per
 * docs/specs/piri-lane-fanout-reuse/phase-2-wiring.md WS2 (#1836):
 *
 * 1. Env inputs (Phase-1 gap 1): the broker-injected budget
 *    (A2A_CONTAINED_SUBAGENTS_MAX / ROLES / OUTPUT_BYTES / REASONS) is
 *    required and A2A_CONTAINED_SUBAGENTS_ENABLED must be "1"; otherwise the
 *    tool refuses with an error result and spawns nothing.
 * 2. Clamp-down (Phase-1 gap 1): MAX_PARALLEL_TASKS / MAX_CONCURRENCY /
 *    PER_TASK_OUTPUT_CAP clamp down to the injected budget; the example's
 *    constants are convenience upper bounds only (see policy.js).
 * 3. Child turn bound (Phase-1 gap 3): piri has no --max-turns, so every
 *    child gets a per-child wall-clock timeout (default
 *    ceil(parentTimeout / (childCount + 1)), override
 *    A2A_PIRI_FANOUT_CHILD_TIMEOUT_SEC, hard-capped at the parent timeout)
 *    enforced with the same SIGTERM -> 5 s -> SIGKILL ladder as aborts.
 * 4. Scope pinning (Phase-1 gap 5): agentScope is pinned to "user" and any
 *    prompt-selected "project"/"both" is refused; agents.js additionally
 *    deletes the project-scope discovery path entirely.
 *
 * Children are spawned with `--mode json -p --no-session` and inherited env
 * (no `env` override), so the injected A2A_CONTAINED_SUBAGENTS_* keys and the
 * guarded PATH reach every child unchanged.
 *
 * Loaded by the piri lane command script via
 * `-e /opt/a2a-runner/piri-fanout-extension` (Phase-2 WS3).
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "./agents.js";
import { ENV, parseSubagentBudget, resolveChildTimeoutSec, truncateOutputBytes } from "./policy.js";

/** Exit code convention for a child killed by its per-child timeout. */
const CHILD_TIMEOUT_EXIT_CODE = 124;
const KILL_GRACE_MS = 5000;

function refusalResult(text) {
	return {
		content: [{ type: "text", text }],
		details: { mode: "single", agentScope: "user", projectAgentsDir: null, results: [] },
		isError: true,
	};
}

function getFinalOutput(messages) {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(result) {
	return (
		result.exitCode !== 0 ||
		result.stopReason === "error" ||
		result.stopReason === "aborted" ||
		result.stopReason === "timeout"
	);
}

function getResultOutput(result) {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function getPiInvocation(args) {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

async function writePromptToTempFile(agentName, prompt) {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

/**
 * Run one child. `childTimeoutSec` bounds the child's wall clock (Phase-1
 * gap 3): on expiry the same SIGTERM -> 5 s -> SIGKILL ladder as aborts fires
 * and the result is recorded as a timeout failure (exit code 124).
 */
async function runSingleAgent(options) {
	const {
		defaultCwd,
		agents,
		agentName,
		task,
		cwd,
		step,
		signal,
		childTimeoutSec,
		onUpdate,
		makeDetails,
	} = options;

	const agent = agents.find((a) => a.name === agentName);
	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "user",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: emptyUsage(),
			step,
		};
	}

	// Children inherit the parent env (no `env` override) so the injected
	// A2A_CONTAINED_SUBAGENTS_* budget keys and the guarded PATH reach them.
	const args = ["--mode", "json", "-p", "--no-session"];
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir = null;
	let tmpPromptPath = null;

	const currentResult = {
		agent: agentName,
		agentSource: "user",
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		model: agent.model,
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;
		let timedOut = false;

		const exitCode = await new Promise((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";
			let settled = false;

			const killProc = () => {
				if (settled || proc.killed) return;
				proc.kill("SIGTERM");
				setTimeout(() => {
					try {
						if (!proc.killed) proc.kill("SIGKILL");
					} catch {
						/* already gone */
					}
				}, KILL_GRACE_MS);
			};

			const childTimer =
				childTimeoutSec !== undefined
					? setTimeout(() => {
							timedOut = true;
							killProc();
						}, childTimeoutSec * 1000)
					: null;
			if (childTimer) childTimer.unref();

			const processLine = (line) => {
				if (!line.trim()) return;
				let event;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (childTimer) clearTimeout(childTimer);
				if (buffer.trim()) processLine(buffer);
				settled = true;
				if (timedOut) {
					currentResult.stopReason = "timeout";
					currentResult.stderr += `\n[a2a-fanout] child exceeded its per-child timeout (${childTimeoutSec}s) and was killed.`;
					resolve(CHILD_TIMEOUT_EXIT_CODE);
					return;
				}
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				if (childTimer) clearTimeout(childTimer);
				settled = true;
				resolve(1);
			});

			if (signal) {
				const onAbort = () => {
					wasAborted = true;
					killProc();
				};
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

function emptyUsage() {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

async function mapWithConcurrencyLimit(items, concurrency, fn) {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"], {
	description:
		'Rejected unless "user": the A2A lane pins user scope so repo-controlled .piri/agents can never load.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

export default function (pi) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			`Agent scope is pinned to the host roster under ${path.join(getAgentDir(), "agents")}.`,
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			// WS2 hardening 4 — scope pinning: refuse any non-user scope up
			// front, before any budget work or spawn.
			const requestedScope = params.agentScope ?? "user";
			if (requestedScope !== "user") {
				return refusalResult(
					`error=a2a_piri_fanout_refused agentScope="${requestedScope}" is not permitted; the A2A lane pins agentScope to "user" (host-controlled roster only).`,
				);
			}

			// WS2 hardening 1 — env inputs: refuse when the lane did not
			// inject an authorized contained-subagent budget.
			const parsed = parseSubagentBudget(process.env);
			if (!parsed.ok) {
				return refusalResult(`error=${parsed.refusal} ${parsed.detail}`);
			}
			const budget = parsed.budget;

			const agents = discoverAgents();
			const childTimeoutSec = resolveChildTimeoutSec({
				parentTimeoutSec: budget.parentTimeoutSec,
				childCount: Math.max(
					1,
					params.tasks?.length ?? params.chain?.length ?? 1,
				),
				overrideSec: process.env[ENV.childTimeoutSec],
			});

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode) =>
				(results) => ({
					mode,
					agentScope: "user",
					projectAgentsDir: null,
					results,
					budget: {
						maxParallelTasks: budget.maxParallelTasks,
						concurrency: budget.concurrency,
						perTaskOutputBytes: budget.perTaskOutputBytes,
						roles: budget.roles,
						childTimeoutSec,
					},
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if (params.chain && params.chain.length > 0) {
				const results = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					const chainUpdate = onUpdate
						? (partial) => {
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent({
						defaultCwd: ctx.cwd,
						agents,
						agentName: step.agent,
						task: taskWithContext,
						cwd: step.cwd,
						step: i + 1,
						signal,
						childTimeoutSec,
						onUpdate: chainUpdate,
						makeDetails: makeDetails("chain"),
					});
					results.push(result);

					if (isFailedResult(result)) {
						const errorMsg = getResultOutput(result);
						return {
							content: [
								{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` },
							],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [
						{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" },
					],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				// WS2 hardening 2 — clamp-down: the parallel-task bound is the
				// injected budget, never the example's convenience constant.
				if (params.tasks.length > budget.maxParallelTasks) {
					return refusalResult(
						`error=a2a_piri_fanout_refused Too many parallel tasks (${params.tasks.length}); the authorized budget allows at most ${budget.maxParallelTasks}.`,
					);
				}

				const allResults = new Array(params.tasks.length);
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "user",
						task: params.tasks[i].task,
						exitCode: -1,
						messages: [],
						stderr: "",
						usage: emptyUsage(),
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, budget.concurrency, async (t, index) => {
					const result = await runSingleAgent({
						defaultCwd: ctx.cwd,
						agents,
						agentName: t.agent,
						task: t.task,
						cwd: t.cwd,
						step: undefined,
						signal,
						childTimeoutSec,
						onUpdate: (partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails: makeDetails("parallel"),
					});
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateOutputBytes(getResultOutput(r), budget.perTaskOutputBytes);
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.agent && params.task) {
				const result = await runSingleAgent({
					defaultCwd: ctx.cwd,
					agents,
					agentName: params.agent,
					task: params.task,
					cwd: params.cwd,
					step: undefined,
					signal,
					childTimeoutSec,
					onUpdate,
					makeDetails: makeDetails("single"),
				});
				if (isFailedResult(result)) {
					const errorMsg = getResultOutput(result);
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},
	});
}
