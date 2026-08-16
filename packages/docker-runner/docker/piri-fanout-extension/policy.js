/**
 * A2A piri fanout policy — pure budget clamps and child-timeout math.
 *
 * Fork-hardening of the piri example `subagent` extension
 * (jinwon-int/piri v0.83.0-piri.1,
 * packages/coding-agent/examples/extensions/subagent/) per
 * docs/specs/piri-lane-fanout-reuse/phase-2-wiring.md WS2 (#1836).
 *
 * Plain ESM on purpose: piri's extension loader (jiti) loads it in-image and
 * the docker-runner unit tests import it under plain `node` with no piri
 * install, so this module must stay dependency-free. Only index.js/agents.js
 * import piri-provided modules.
 */

/** Example convenience bound — an upper bound only, never an expansion. */
export const EXAMPLE_MAX_PARALLEL_TASKS = 8;
/** Example convenience bound — an upper bound only, never an expansion. */
export const EXAMPLE_MAX_CONCURRENCY = 4;
/** Example convenience bound — an upper bound only, never an expansion. */
export const EXAMPLE_PER_TASK_OUTPUT_CAP = 50 * 1024;
/** Hard ceiling from the broker contract: at most 4 contained children. */
export const HARD_CONCURRENCY_CAP = 4;
/** Lane default from docker-runner config.ts (DEFAULT_PIRI_TIMEOUT_SEC). */
export const DEFAULT_PARENT_TIMEOUT_SEC = 3600;

export const ENV = {
	enabled: "A2A_CONTAINED_SUBAGENTS_ENABLED",
	max: "A2A_CONTAINED_SUBAGENTS_MAX",
	roles: "A2A_CONTAINED_SUBAGENTS_ROLES",
	outputBytes: "A2A_CONTAINED_SUBAGENTS_OUTPUT_BYTES",
	reasons: "A2A_CONTAINED_SUBAGENTS_REASONS",
	parentTimeoutSec: "A2A_PIRI_TIMEOUT_SEC",
	childTimeoutSec: "A2A_PIRI_FANOUT_CHILD_TIMEOUT_SEC",
};

function parsePositiveInt(raw) {
	if (raw === undefined || raw === null || String(raw).trim() === "") return undefined;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1) return undefined;
	return value;
}

function parseList(raw) {
	if (raw === undefined || raw === null) return [];
	const seen = [];
	for (const item of String(raw).split(",")) {
		const trimmed = item.trim();
		if (trimmed && !seen.includes(trimmed)) seen.push(trimmed);
	}
	return seen;
}

/**
 * Parse and clamp the broker-injected contained-subagent budget.
 *
 * Refuses (no spawn) when the lane did not opt in
 * (`A2A_CONTAINED_SUBAGENTS_ENABLED != "1"`) or any required budget env is
 * absent/invalid. The example extension's constants are convenience upper
 * bounds only — a valid budget can only clamp down, never expand them.
 *
 * @returns {{ ok: true, budget: object } | { ok: false, refusal: string, detail: string }}
 */
export function parseSubagentBudget(env) {
	if (env[ENV.enabled] !== "1") {
		return {
			ok: false,
			refusal: "a2a_piri_fanout_refused",
			detail: `${ENV.enabled} is not "1"; contained subagents are not authorized for this lane run.`,
		};
	}

	const injectedMax = parsePositiveInt(env[ENV.max]);
	if (injectedMax === undefined) {
		return {
			ok: false,
			refusal: "a2a_piri_fanout_refused",
			detail: `${ENV.max} is absent or not a positive integer.`,
		};
	}

	const injectedOutputBytes = parsePositiveInt(env[ENV.outputBytes]);
	if (injectedOutputBytes === undefined) {
		return {
			ok: false,
			refusal: "a2a_piri_fanout_refused",
			detail: `${ENV.outputBytes} is absent or not a positive integer.`,
		};
	}

	const roles = parseList(env[ENV.roles]);
	if (roles.length === 0) {
		return {
			ok: false,
			refusal: "a2a_piri_fanout_refused",
			detail: `${ENV.roles} is absent or empty.`,
		};
	}

	const reasons = parseList(env[ENV.reasons]);
	if (reasons.length === 0) {
		return {
			ok: false,
			refusal: "a2a_piri_fanout_refused",
			detail: `${ENV.reasons} is absent or empty.`,
		};
	}

	const parentTimeoutSec = parsePositiveInt(env[ENV.parentTimeoutSec]) ?? DEFAULT_PARENT_TIMEOUT_SEC;

	return {
		ok: true,
		budget: {
			// Convenience bounds only clamp down, never expand.
			maxParallelTasks: Math.min(injectedMax, EXAMPLE_MAX_PARALLEL_TASKS),
			concurrency: Math.min(EXAMPLE_MAX_CONCURRENCY, HARD_CONCURRENCY_CAP, injectedMax),
			perTaskOutputBytes: Math.min(injectedOutputBytes, EXAMPLE_PER_TASK_OUTPUT_CAP),
			roles,
			reasons,
			parentTimeoutSec,
		},
	};
}

/**
 * Resolve the per-child timeout (the piri lane's turn bound, Phase-1 gap 3).
 *
 * piri has no `--max-turns`, so each child gets a bounded wall-clock budget:
 * default ceil(parentTimeout / (childCount + 1)) seconds, configurable via
 * `A2A_PIRI_FANOUT_CHILD_TIMEOUT_SEC`, always floored at 1 s and hard-capped
 * at the lane parent timeout. The parent `timeout` wrapper stays the outer
 * bound; the SIGTERM -> 5 s -> SIGKILL ladder stays layered underneath.
 */
export function resolveChildTimeoutSec({ parentTimeoutSec, childCount, overrideSec }) {
	const parent = Math.max(1, Math.floor(parentTimeoutSec));
	const override = parsePositiveInt(overrideSec);
	if (override !== undefined) {
		return Math.min(parent, Math.max(1, override));
	}
	const count = Math.max(1, Math.floor(childCount));
	const share = Math.ceil(parent / (count + 1));
	return Math.min(parent, Math.max(1, share));
}

/**
 * Truncate a child's model-visible output to `capBytes` UTF-8 bytes without
 * splitting code points (same contract as the broker-side byte bounds).
 */
export function truncateOutputBytes(output, capBytes) {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= capBytes) return output;

	let truncated = output.slice(0, capBytes);
	while (Buffer.byteLength(truncated, "utf8") > capBytes) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted.]`;
}
