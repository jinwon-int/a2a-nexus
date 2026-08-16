function safeText(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) return [value];
  return [];
}

function carrierFiles(value) {
  return Array.isArray(value) ? value.filter((file) => file && typeof file === "object" && !Array.isArray(file)) : [];
}

export function collectSourceCarrierItems(payload) {
  const items = [];
  for (const item of carrierFiles(payload?.embeddedSourceEvidence)) items.push({ carrier: "embeddedSourceEvidence", item });
  const sourceBundle = payload?.sourceBundle;
  if (sourceBundle && typeof sourceBundle === "object" && !Array.isArray(sourceBundle)) {
    for (const item of carrierFiles(sourceBundle.files)) items.push({ carrier: "sourceBundle.files", item });
  }
  for (const item of carrierFiles(payload?.sourceFiles)) items.push({ carrier: "sourceFiles", item });
  for (const item of carrierFiles(payload?.sourceEvidence)) items.push({ carrier: "sourceEvidence", item });
  return items;
}

export function payloadSourceFiles(payload) {
  return collectSourceCarrierItems(payload).map((entry) => entry.item);
}

export function sourceCarrierPath(file) {
  return safeText(file?.path || file?.file || file?.name || file?.id, "<unnamed>");
}

export function sourceCarrierRepo(file, fallbackRepo = "sourceCarrier") {
  return safeText(file?.repo || file?.repository || file?.carrier || fallbackRepo, fallbackRepo);
}

export function sourceCarrierContent(file) {
  for (const field of ["content", "contentText", "text", "summary"]) {
    if (typeof file?.[field] === "string") return { content: file[field], field };
  }
  return { content: "", field: "" };
}

export function sourceCarrierBytes(file) {
  return Buffer.byteLength(sourceCarrierContent(file).content, "utf8");
}

export function isSafeRelativePath(candidate) {
  if (!candidate || typeof candidate !== "string") return false;
  if (candidate.includes("\0")) return false;
  if (candidate.startsWith("/") || /^[A-Za-z]:[\\/]/.test(candidate)) return false;
  const normalized = candidate.replace(/\\/g, "/");
  return !normalized.split("/").some((part) => part === "..") && normalized !== ".";
}

export function normalizeSourceCarrierFile(item, options = {}) {
  const fallbackRepo = safeText(options.fallbackRepo, "embedded");
  const maxFileBytes = Math.max(0, Number(options.maxFileBytes ?? Number.MAX_SAFE_INTEGER));
  const remainingBytes = Math.max(0, Number(options.remainingBytes ?? maxFileBytes));
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return { reason: "malformed", warning: "skipped malformed embedded source evidence" };
  }
  const repo = sourceCarrierRepo(item, fallbackRepo);
  const path = sourceCarrierPath(item);
  if (!isSafeRelativePath(path)) {
    return { reason: "unsafe_path", warning: `skipped unsafe embedded source path: ${path || "<empty>"}` };
  }
  const { content: rawContent, field: contentField } = sourceCarrierContent(item);
  if (!rawContent) {
    return { reason: "empty_content", warning: `skipped empty embedded source file: ${repo}:${path}` };
  }
  const maxBytes = Math.max(0, Math.min(maxFileBytes, remainingBytes));
  if (maxBytes <= 0) {
    return { reason: "total_budget_exhausted", warning: `dropped embedded source file: reason=total_budget_exhausted path=${repo}:${path}` };
  }
  const buffer = Buffer.from(rawContent, "utf8");
  const truncated = buffer.length > maxBytes;
  const content = buffer.subarray(0, maxBytes).toString("utf8");
  return {
    reason: "ok",
    file: { repo, path, content, contentField, truncated, bytes: buffer.length },
    ...(truncated ? { warning: `truncated embedded source file: reason=per_file_budget path=${repo}:${path} originalBytes=${buffer.length} keptBytes=${Buffer.byteLength(content, "utf8")}` } : {}),
  };
}

/**
 * Diagnostic-only source-carrier stats the task handler injects via env
 * (A2A_ANALYSIS_SOURCE_CARRIER_STATS). Bridges echo them on failure records
 * so postmortems know how much source the lane actually saw (#1725). The
 * value is parsed as-is here; the task-handler trust boundary re-projects
 * it onto the bounded numeric key set before it reaches a task error.
 */
export function sourceCarrierStatsFromEnv(env = process.env) {
  const raw = safeText(env.A2A_ANALYSIS_SOURCE_CARRIER_STATS, "");
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // fall through: stats are diagnostic only, never fail the failure path
  }
  return undefined;
}

export function sourceCarrierStats(payload) {
  const entries = collectSourceCarrierItems(payload);
  return {
    sourceBundleFiles: entries.filter((entry) => entry.carrier === "sourceBundle.files").length,
    sourceFiles: entries.filter((entry) => entry.carrier === "sourceFiles").length,
    sourceEvidence: entries.filter((entry) => entry.carrier === "sourceEvidence").length,
    embeddedSourceEvidence: entries.filter((entry) => entry.carrier === "embeddedSourceEvidence").length,
    totalFiles: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + sourceCarrierBytes(entry.item), 0),
  };
}

export function normalizeStringArray(value) {
  return Array.isArray(value) ? value.map((item) => safeText(item, "")).filter(Boolean) : [];
}
