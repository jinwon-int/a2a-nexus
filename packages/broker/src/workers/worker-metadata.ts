/**
 * Worker metadata & analysis-artifact probe (#1601 churn-relief slice 4).
 *
 * Extracted verbatim from worker.ts: the worker metadata / analysis-probe
 * cluster (parseMetadataEnv, buildWorkerMetadata, AnalysisArtifactProbe,
 * the probe-adapter helpers, probeWorkerBuildRevision,
 * probeAnalysisArtifactReadiness, withAnalysisProbeMetadata) plus the two
 * shared env-parse helpers it owns (optionalTrimmed, parseBooleanEnv).
 * worker.ts imports them back; only the required `export` keywords differ.
 */
import { accessSync, constants as fsConstants, existsSync } from "node:fs";
import { delimiter as pathDelimiter, isAbsolute, join as joinPath, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { readGeneratedBuildInfo } from "../broker-build-info.js";

/**
 * Runtime profile vocabulary shared by worker.ts and workers/worker-env.ts
 * (extracted from worker.ts slice 6): how this worker process talks to the
 * broker.
 */
export type WorkerRuntimeProfile = "broker-poll-only" | "openclaw-poll-only";

export function optionalTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function parseBooleanEnv(value: string | undefined, fallback = false): boolean {
  const normalized = optionalTrimmed(value)?.toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`invalid boolean value: ${value}`);
}

function parseMetadataEnv(value: string | undefined): Record<string, string> | undefined {
  const trimmed = optionalTrimmed(value);
  if (!trimmed) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      `expected metadata JSON object but received ${value}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("WORKER_METADATA_JSON must be a JSON object");
  }

  const entries = Object.entries(parsed as Record<string, unknown>).map(([key, item]) => [key, String(item)]);
  return Object.fromEntries(entries);
}

export function buildWorkerMetadata(
  env: NodeJS.ProcessEnv,
  runtimeProfile?: WorkerRuntimeProfile,
): Record<string, string> | undefined {
  const metadata = parseMetadataEnv(env.WORKER_METADATA_JSON ?? env.A2A_WORKER_METADATA_JSON) ?? {};
  if (runtimeProfile) {
    const legacyOpenClawProfile = runtimeProfile === "openclaw-poll-only";
    return {
      ...metadata,
      workerProfile: runtimeProfile,
      runtimeFlavor: legacyOpenClawProfile ? "openclaw-poll-handler" : "broker-poll-http-handler",
      executionPlane: "broker-poll-http-handler",
      handlerContract: "stdin-stdout",
      gatewayHookRequired: "false",
      ...(legacyOpenClawProfile ? { openclawBridge: "disabled" } : {}),
    };
  }
  return Object.keys(metadata).length ? metadata : undefined;
}

// ---------------------------------------------------------------------------
// Registration-time analysis handler artifact probe (#1597, routed from #1725
// finding 2). The 2026-08-03 A2AD audit watched two workers advertise
// `online` + `canAnalyze=true`, accept analysis tasks, and die in 3–5 s with
// MODULE_NOT_FOUND because the declared handler artifact was absent. A worker
// must therefore verify the selected handler path (exists + readable /
// executable) BEFORE advertising `canAnalyze=true` at registration or
// heartbeat. Adapter class and handler path are derived from the actual
// wiring — the same env vars the execution handler resolves — never from
// static self-report.
//
// That derivation is a *mirror* of the handler's resolution, not a shared
// implementation, so it is not drift-proof by construction: #1788 changed the
// handler's fallback bridge and the probe's fallback silently disagreed until
// it was caught. Anything resolved here must therefore be pinned against the
// handler by test (`worker-analysis-readiness.test.ts`), and any future change
// to one side must move the other.
// ---------------------------------------------------------------------------

export interface AnalysisArtifactProbe {
  /** False when the probe did not run (worker does not declare canAnalyze). */
  probed: boolean;
  ready: boolean;
  reason?: "handler_artifact_missing";
  adapterClass?: string;
  handlerPath?: string;
}

const PROBE_ADAPTER_ALIASES: Record<string, string> = {
  openclaw: "openclaw",
  "claude-code": "claude_code",
  claude_code: "claude_code",
  claudecode: "claude_code",
  codex: "codex",
  hermes: "hermes",
  builtin: "builtin",
};

function normalizeProbeAdapter(value: string | undefined): string | undefined {
  const normalized = optionalTrimmed(value)?.toLowerCase();
  if (!normalized) return undefined;
  return PROBE_ADAPTER_ALIASES[normalized];
}

/**
 * The bridge the execution handler falls back to when no `*_ANALYSIS_BIN` is
 * configured. Must stay identical to `DEFAULT_ANALYSIS_BRIDGE` in
 * `scripts/a2a-task-handler.mjs`; `worker-analysis-readiness.test.ts` pins the
 * two together.
 *
 * The probe used to default to the literal `"openclaw"` instead. After #1788
 * moved the handler default to the in-repo piri bridge ("not a binary nobody
 * has"), the probe kept looking for exactly that binary nobody has: a worker
 * with the bridge enabled and no explicit `*_ANALYSIS_BIN` failed a PATH
 * lookup for `openclaw`, was marked `handler_artifact_missing`, and had
 * `canAnalyze` flipped to false — while the handler it was about to run would
 * have resolved the piri bridge and worked. A healthy worker went dark.
 */
const PROBE_DEFAULT_ANALYSIS_BRIDGE = fileURLToPath(
  // #1601 slice 4: same target as before, but this module lives one directory
  // deeper than worker.ts, so the anchor gained one ../ segment (the only
  // non-verbatim change): src/workers/../../scripts == src/../scripts.
  new URL("../../scripts/piri-a2a-analysis-bridge.mjs", import.meta.url),
);

function analysisBridgeCommandForProbe(env: NodeJS.ProcessEnv): string {
  return (
    optionalTrimmed(env.A2A_HERMES_ANALYSIS_BIN) ??
    optionalTrimmed(env.A2A_OPENCLAW_ANALYSIS_BIN) ??
    optionalTrimmed(env.OPENCLAW_BIN) ??
    PROBE_DEFAULT_ANALYSIS_BRIDGE
  );
}

/** Mirror of the execution handler's adapter telemetry heuristic. */
function deriveAnalysisAdapterClass(env: NodeJS.ProcessEnv, command: string): string {
  const explicit = normalizeProbeAdapter(env.A2A_ANALYSIS_BRIDGE_ADAPTER ?? env.A2A_WORKER_BRIDGE_ADAPTER);
  if (explicit) return explicit;
  const combined = [
    command,
    optionalTrimmed(env.A2A_CLAUDE_CODE_BIN) ?? "",
    optionalTrimmed(env.CLAUDE_BIN) ?? "",
    optionalTrimmed(env.A2A_WORKER_RUNTIME_FLAVOR ?? env.WORKER_RUNTIME_FLAVOR) ?? "",
    optionalTrimmed(env.WORKER_METADATA_JSON) ?? "",
  ].join("\n").toLowerCase();
  if (combined.includes("codex")) return "codex";
  if (combined.includes("claude")) return "claude_code";
  if (combined.includes("hermes")) return "hermes";
  return "openclaw";
}

function isExecutableFile(candidate: string): boolean {
  try {
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathLookupExecutable(name: string, pathEnv: string | undefined): string | undefined {
  for (const dir of (pathEnv ?? "").split(pathDelimiter)) {
    if (!dir) continue;
    const candidate = joinPath(dir, name);
    if (existsSync(candidate) && isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

function probeWorkerBuildRevision(env: NodeJS.ProcessEnv): string | undefined {
  const explicit = optionalTrimmed(env.A2A_WORKER_BUILD_SHA ?? env.A2A_WORKER_BUILD_REVISION ?? env.A2A_BROKER_REVISION);
  if (explicit) return explicit;
  try {
    const revision = readGeneratedBuildInfo()?.revision;
    return typeof revision === "string" && revision.trim() ? revision.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function probeAnalysisArtifactReadiness(
  env: NodeJS.ProcessEnv,
  canAnalyze: boolean,
): AnalysisArtifactProbe {
  if (!canAnalyze) return { probed: false, ready: false };
  const bridgeEnabled =
    parseBooleanEnv(env.A2A_HERMES_ANALYSIS_ENABLED) || parseBooleanEnv(env.A2A_OPENCLAW_ANALYSIS_ENABLED);
  if (!bridgeEnabled) {
    // Builtin structured analysis needs no external artifact: nothing to
    // verify, no metadata to publish (legacy semantics preserved).
    return { probed: false, ready: true, adapterClass: "builtin" };
  }
  const command = analysisBridgeCommandForProbe(env);
  const adapterClass = deriveAnalysisAdapterClass(env, command);
  const looksLikeScript = /\.(?:mjs|cjs|js)$/i.test(command);
  const hasPathSeparator = command.includes("/") || command.includes("\\") || command.startsWith(".");

  if (looksLikeScript && hasPathSeparator) {
    const cwd = optionalTrimmed(env.A2A_HANDLER_CWD ?? env.WORKER_HANDLER_CWD) ?? process.cwd();
    const resolved = isAbsolute(command) ? command : resolvePath(cwd, command);
    const ready = existsSync(resolved) && (() => {
      try {
        accessSync(resolved, fsConstants.R_OK);
        return true;
      } catch {
        return false;
      }
    })();
    return ready
      ? { probed: true, ready: true, adapterClass, handlerPath: resolved }
      : { probed: true, ready: false, reason: "handler_artifact_missing", adapterClass, handlerPath: resolved };
  }

  if (hasPathSeparator) {
    const ready = existsSync(command) && isExecutableFile(command);
    return ready
      ? { probed: true, ready: true, adapterClass, handlerPath: command }
      : { probed: true, ready: false, reason: "handler_artifact_missing", adapterClass, handlerPath: command };
  }

  const onPath = pathLookupExecutable(command, env.PATH);
  return onPath
    ? { probed: true, ready: true, adapterClass, handlerPath: onPath }
    : { probed: true, ready: false, reason: "handler_artifact_missing", adapterClass, handlerPath: command };
}

export function withAnalysisProbeMetadata(
  metadata: Record<string, string> | undefined,
  probe: AnalysisArtifactProbe,
  env: NodeJS.ProcessEnv,
): Record<string, string> | undefined {
  if (!probe.probed) return metadata;
  const out: Record<string, string> = { ...(metadata ?? {}) };
  out.analysisReady = probe.ready ? "true" : "false";
  if (probe.adapterClass) out.analysisAdapterClass = probe.adapterClass;
  if (probe.handlerPath) out.analysisHandlerPath = probe.handlerPath;
  if (!probe.ready) {
    out.analysisReadyReason = probe.reason ?? "handler_artifact_missing";
    // The probe only runs when canAnalyze was declared; keep the declaration
    // visible so operators can tell "declared but drifted" from "never
    // declared" without diffing env.
    out.analysisDeclaredCanAnalyze = "true";
  }
  const buildRevision = probeWorkerBuildRevision(env);
  if (buildRevision) out.analysisBuildSha = buildRevision;
  return out;
}
