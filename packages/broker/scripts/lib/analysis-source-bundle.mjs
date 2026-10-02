/**
 * Read-only analysis payload + source-bundle assembly shared by analysis
 * bridges (jinwon-int/a2a-nexus#2295).
 *
 * The behavior is lifted verbatim from piri-a2a-analysis-bridge.mjs (#1880,
 * #1891, #2005, #2023 semantics included); the only change is that the
 * bridge-specific env prefix (A2A_PIRI_ANALYSIS_* / A2A_DANSO_ANALYSIS_*) is a
 * parameter instead of a literal. The piri bridge still carries its own copy so
 * the live piri lane is untouched by #2295; analysis-source-bundle.test.mjs
 * pins this module to the piri implementation until piri is migrated onto it.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { sliceUtf8AtBoundary } from "./utf8-byte-budget.mjs";

export const DEFAULT_MAX_FILES = 16;
export const DEFAULT_MAX_FILE_BYTES = 24 * 1024;
export const DEFAULT_MAX_TOTAL_BYTES = 160 * 1024;
export const DEFAULT_MAX_TREE_ENTRIES = 80;

export function safeText(value, fallback = "") {
	return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function positiveIntegerEnv(value, fallback) {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function parseJsonObject(text, label = "JSON") {
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

export function extractBalancedJson(text, startIndex) {
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

export function extractPayload(message) {
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
 * #2023: the handler stamps `A2A_PAYLOAD_CARRIER_REQUIRED=<path>` when the
 * prompt payload excerpt is truncated and the file carrier is therefore the
 * only complete evidence source.
 */
export function declaredRequiredCarrierPath(message) {
	const match = /A2A_PAYLOAD_CARRIER_REQUIRED=(\S+)/.exec(message || "");
	return match ? safeText(match[1], "").trim() : "";
}

/** Full-payload carrier (A2A_ANALYSIS_PAYLOAD_FILE, payload_file mode). */
export function payloadFromStructuredEnv(env = process.env) {
	const path = safeText(env.A2A_ANALYSIS_PAYLOAD_FILE, "");
	if (!path) return undefined;
	if (!existsSync(path)) throw new Error(`A2A_ANALYSIS_PAYLOAD_FILE does not exist: ${path}`);
	return parseJsonObject(readFileSync(path, "utf8"), "A2A_ANALYSIS_PAYLOAD_FILE");
}

function parseRepoMap(env, prefix) {
	const raw = safeText(env.A2A_ANALYSIS_REPO_MAP_JSON || env[`${prefix}_REPO_MAP_JSON`], "");
	const map = new Map();
	if (raw) {
		const parsed = parseJsonObject(raw, "A2A_ANALYSIS_REPO_MAP_JSON");
		for (const [repo, path] of Object.entries(parsed)) {
			if (typeof path === "string" && path.trim()) map.set(repo, resolve(path));
		}
	}
	const defaultRoot = safeText(env.A2A_ANALYSIS_REPO_ROOT || env[`${prefix}_REPO_ROOT`], "");
	if (defaultRoot) map.set("__default__", resolve(defaultRoot));
	return map;
}

function toArray(value) {
	if (Array.isArray(value)) return value;
	if (typeof value === "string" && value.trim()) return [value];
	return [];
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
	const sliced = truncated ? sliceUtf8AtBoundary(buffer, maxBytes) : buffer;
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

/**
 * #1891 / #1880: resolve a detached `contentRef` host-side. Fail-closed: a
 * declared contentRef that is non-absolute, missing, or escapes the payload
 * directory is a hard error, never a silent skip.
 */
function resolveDetachedContentRef(item, contentRefRoot) {
	const ref = item?.contentRef;
	if (!ref || typeof ref !== "object" || Array.isArray(ref)) return undefined;
	const refPath = safeText(ref.path, "");
	if (!refPath || refPath.includes("\0") || !isAbsolute(refPath)) {
		throw new Error(`contentRef path must be an absolute path: ${refPath || "<empty>"}`);
	}
	if (!contentRefRoot) {
		throw new Error(`contentRef ${refPath} requires the payload-file carrier (A2A_ANALYSIS_PAYLOAD_FILE)`);
	}
	let realRoot;
	let realRef;
	try {
		realRoot = realpathSync(contentRefRoot);
		realRef = realpathSync(refPath);
	} catch {
		throw new Error(`contentRef file is unreadable: ${refPath}`);
	}
	if (!insideRoot(realRoot, realRef)) {
		throw new Error(`contentRef path escapes the payload directory: ${refPath}`);
	}
	if (!statSync(realRef).isFile()) {
		throw new Error(`contentRef path is not a regular file: ${refPath}`);
	}
	return readFileSync(realRef, "utf8");
}

function normalizeEmbeddedSourceFile(item, fallbackRepo, maxFileBytes, remainingBytes, contentRefRoot = "") {
	if (!item || typeof item !== "object" || Array.isArray(item)) return { warning: "skipped malformed embedded source evidence" };
	const repo = safeText(item.repo || item.repository || fallbackRepo || "embedded", "embedded");
	const path = safeText(item.path || item.file || item.name, "");
	if (!isSafeRelativePath(path)) return { warning: `skipped unsafe embedded source path: ${path || "<empty>"}` };
	let rawContent = typeof item.content === "string" ? item.content : typeof item.text === "string" ? item.text : "";
	if (!rawContent) {
		const detached = resolveDetachedContentRef(item, contentRefRoot);
		if (detached !== undefined) rawContent = detached;
	}
	if (!rawContent) return { warning: `skipped empty embedded source file: ${repo}:${path}` };
	const maxBytes = Math.max(0, Math.min(maxFileBytes, remainingBytes));
	const buffer = Buffer.from(rawContent, "utf8");
	const truncated = buffer.length > maxBytes;
	// #2005: byte-capped cuts land on a UTF-8 character boundary.
	const content = sliceUtf8AtBoundary(buffer, maxBytes).toString("utf8");
	return { file: { repo, path, content, truncated, bytes: buffer.length } };
}

/**
 * Collect the read-only source bundle for one analysis task.
 *
 * `prefix` names the bridge-specific env family, e.g. "A2A_DANSO_ANALYSIS" reads
 * A2A_DANSO_ANALYSIS_MAX_FILES; each limit falls back to the matching
 * A2A_HERMES_ANALYSIS_* value and then to the default, exactly as the piri
 * bridge does for A2A_PIRI_ANALYSIS_*.
 */
export function collectSourceBundle(payload, env, { prefix }) {
	if (!prefix) throw new Error("collectSourceBundle requires an env prefix");
	const repoMap = parseRepoMap(env, prefix);
	const repos = collectRepos(payload);
	if (repos.length === 0 && repoMap.has("__default__")) repos.push({ name: "__default__" });

	const limit = (suffix, fallback) => positiveIntegerEnv(env[`${prefix}_${suffix}`] || env[`A2A_HERMES_ANALYSIS_${suffix}`], fallback);
	const maxFiles = limit("MAX_FILES", DEFAULT_MAX_FILES);
	const maxFileBytes = limit("MAX_FILE_BYTES", DEFAULT_MAX_FILE_BYTES);
	const maxTotalBytes = limit("MAX_TOTAL_BYTES", DEFAULT_MAX_TOTAL_BYTES);
	const maxTreeEntries = limit("MAX_TREE_ENTRIES", DEFAULT_MAX_TREE_ENTRIES);

	const files = [];
	const warnings = [];
	let totalBytes = 0;

	const fallbackRepo = safeText(payload.repo || payload.repository || "embedded", "embedded");
	// #1891: contentRef detach files live under the payload file's directory.
	const payloadFilePath = safeText(env.A2A_ANALYSIS_PAYLOAD_FILE, "");
	const contentRefRoot = payloadFilePath ? dirname(resolve(payloadFilePath)) : "";
	for (const embedded of collectEmbeddedSourceEvidence(payload)) {
		if (files.length >= maxFiles || totalBytes >= maxTotalBytes) break;
		const remaining = Math.max(0, maxTotalBytes - totalBytes);
		const normalized = normalizeEmbeddedSourceFile(embedded, fallbackRepo, maxFileBytes, remaining, contentRefRoot);
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

// ---------------------------------------------------------------------------
// #2301: prompt-side payload view. The worker handler embeds the full payload
// JSON (source carriers included) in the task message, and bridges also print
// a "Task payload JSON" section, so a bundle's file content used to reach the
// model three times (payload section, worker message, source sections). The
// 2026-10-02 danso canary paid for that with a 32.6KB prompt for 8KB of source
// and a provider timeout. These helpers keep the structural payload but replace
// every source carrier's content with {repo, path, bytes, hasContent} so file
// content appears exactly once — in the bridge's read-only source sections.
// ---------------------------------------------------------------------------

const SOURCE_CARRIER_KEYS = ["sourceFiles", "sourceEvidence", "embeddedSourceEvidence"];
const CONTENT_OMITTED_NOTE = "source content omitted here; it is shown exactly once in the Read-only source bundle sections";

function summarizeSourceCarrierItem(item) {
	if (typeof item === "string") return { path: item, bytes: 0, hasContent: false };
	if (!item || typeof item !== "object" || Array.isArray(item)) return null;
	const repo = safeText(item.repo || item.repository, "");
	const path = safeText(item.path || item.file || item.name, "");
	const content = typeof item.content === "string" ? item.content : typeof item.text === "string" ? item.text : "";
	const rawRef = item.contentRef ?? item.contentPath;
	const contentRef = typeof rawRef === "object" && rawRef !== null ? safeText(rawRef.path || rawRef.file, "") : safeText(rawRef, "");
	return {
		...(repo ? { repo } : {}),
		...(path ? { path } : {}),
		bytes: Buffer.byteLength(content, "utf8"),
		hasContent: content.length > 0,
		...(contentRef ? { contentRef } : {}),
		...(item.truncated ? { truncated: true } : {}),
	};
}

/** `{ files, fileCount }` summary of a carrier array or `{ files: [...] }` object. */
export function summarizeSourceCarriersForPrompt(value) {
	const files = [];
	for (const item of toArray(value?.files ?? value)) {
		const summary = summarizeSourceCarrierItem(item);
		if (summary) files.push(summary);
	}
	return { files, fileCount: files.length };
}

/** Deep copy of `payload` with every source carrier's content replaced by a summary. */
export function payloadForPrompt(payload) {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload ?? {};
	const copy = structuredClone(payload);
	if (copy.sourceBundle && typeof copy.sourceBundle === "object" && !Array.isArray(copy.sourceBundle)) {
		copy.sourceBundle = {
			...copy.sourceBundle,
			files: summarizeSourceCarriersForPrompt(copy.sourceBundle).files,
			contentOmitted: CONTENT_OMITTED_NOTE,
		};
	}
	for (const key of SOURCE_CARRIER_KEYS) {
		if (!Array.isArray(copy[key])) continue;
		copy[key] = summarizeSourceCarriersForPrompt(copy[key]).files;
		copy[`${key}ContentOmitted`] = CONTENT_OMITTED_NOTE;
	}
	return copy;
}

/**
 * The worker message with its embedded `Payload JSON …:` block rewritten
 * through `payloadForPrompt`. The block is located by the handler's marker and
 * a string-aware balanced-JSON scan; a truncated (unbalanced) excerpt or a
 * message without the marker is returned unchanged. When the embedded block
 * parses, its own content is summarized so the rewrite never invents fields;
 * otherwise `payload` (the bridge's resolved payload) is used.
 */
export function messageForPrompt(message, payload) {
	const text = String(message ?? "");
	const marker = /Payload JSON[^\n:]*:/i.exec(text);
	if (!marker) return text;
	const start = marker.index + marker[0].length;
	const jsonText = extractBalancedJson(text, start);
	if (!jsonText) return text;
	const jsonStart = text.indexOf(jsonText, start);
	let embedded = payload;
	try {
		embedded = JSON.parse(jsonText);
	} catch {
		// keep the resolved payload
	}
	const replacement = JSON.stringify(payloadForPrompt(embedded), null, 2);
	return `${text.slice(0, start)}\n${replacement}${text.slice(jsonStart + jsonText.length)}`;
}
