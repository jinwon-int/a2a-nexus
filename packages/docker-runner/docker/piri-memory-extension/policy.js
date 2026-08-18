/**
 * Policy for the baked piri memory-injection extension
 * (a2a-nexus#1797 item 3a — nunchi/MemPalace memory injection porting).
 *
 * Dependency-free ESM so it can be unit-tested under plain node. Env inputs
 * only; the extension never phones home and never writes to stdout.
 */

export const ENV = {
	ENABLED: "A2A_PIRI_MEMORY_ENABLED",
	FILE: "A2A_PIRI_MEMORY_FILE",
	MAX_BYTES: "A2A_PIRI_MEMORY_MAX_BYTES",
};

export const DEFAULT_MEMORY_FILE = "/work/memory.md";
export const DEFAULT_MAX_BYTES = 32768;
export const MAX_BYTES_CEILING = 131072;

/**
 * Roots a memory snapshot may live under. Deliberately narrow: /work (task
 * workspace) and a dedicated secrets mount. /run/secrets/piri-dir is NOT
 * allowed — a memory file must never be the piri auth/config directory,
 * because the snapshot content is injected into the model prompt.
 */
export const ALLOWED_ROOTS = ["/work/", "/run/secrets/piri-memory/"];

function isAllowedMemoryFile(file) {
	if (typeof file !== "string" || file.length === 0 || file.includes("\0")) return false;
	if (!file.startsWith("/")) return false;
	// Reject traversal before prefix matching: normalize dot segments lexically.
	const segments = file.split("/").filter((segment) => segment.length > 0 && segment !== ".");
	if (segments.some((segment) => segment === "..")) return false;
	const normalized = `/${segments.join("/")}`;
	return ALLOWED_ROOTS.some((root) => normalized.startsWith(root));
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @returns {{ ok: true, config: { file: string, maxBytes: number } } | { ok: false, refusal: string }}
 */
export function parseMemoryConfig(env) {
	if (env[ENV.ENABLED] !== "1") {
		return { ok: false, refusal: "a2a_piri_memory_refused" };
	}

	const file = env[ENV.FILE] && env[ENV.FILE].length > 0 ? env[ENV.FILE] : DEFAULT_MEMORY_FILE;
	if (!isAllowedMemoryFile(file)) {
		return { ok: false, refusal: "a2a_piri_memory_file_refused" };
	}

	let maxBytes = DEFAULT_MAX_BYTES;
	const rawMax = env[ENV.MAX_BYTES];
	if (rawMax !== undefined && rawMax !== "") {
		if (!/^[0-9]+$/.test(rawMax)) {
			return { ok: false, refusal: "a2a_piri_memory_max_bytes_refused" };
		}
		const parsed = Number.parseInt(rawMax, 10);
		if (!Number.isSafeInteger(parsed) || parsed <= 0) {
			return { ok: false, refusal: "a2a_piri_memory_max_bytes_refused" };
		}
		maxBytes = Math.min(parsed, MAX_BYTES_CEILING);
	}

	return { ok: true, config: { file, maxBytes } };
}
