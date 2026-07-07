#!/usr/bin/env node
/**
 * Round replay CLI (#1302 M4) — replays a preserved dispatch payload through
 * the broker's DETERMINISTIC orchestration paths so projection/readiness-class
 * incidents reproduce and bisect locally, without live workers. The zero_files
 * mystery took seven live rounds to root-cause because every hypothesis needed
 * a worker dispatch; the round inputs those rounds consumed are preserved
 * (payload file + 3-point carrier instrumentation), so this tool re-runs them.
 *
 * Stages (in order):
 *   readiness    — dist/task-readiness.js evaluateTaskReadiness (real path)
 *   projection   — scripts/lib/source-carriers.mjs collect + normalize (real path)
 *   bridge-input — writeAnalysisBridgeInputFiles-equivalent: task.json/payload.json
 *                  + the 3-point carrier stats, plus the pre-#1278 failure-mode
 *                  probe (message-excerpt payload extraction vs payload file)
 *   bridge       — spawns the deterministic source-only local analysis bridge
 *                  on the bridge-input files (no provider); provider-backed
 *                  bridges (hermes/claude) are explicitly SKIPPED
 *   acceptance   — dist/worker-acceptance.js validateAcceptanceEvidence over a
 *                  preserved worker result (the acceptance COMMAND is never run)
 *
 * NOT replayed, by design (explicit skip markers in the report): provider/model
 * calls, worker dispatch, GitHub side effects, acceptance command execution.
 * Read-only: the only writes are the bridge-input files in a fresh temp dir,
 * removed afterwards unless --keep-dir.
 *
 * Usage:
 *   node scripts/replay-round.mjs --payload <file.json> [--task <task.json>]
 *     [--result <result.json>] [--intent analyze] [--stage <name>] [--keep-dir] [--json]
 *
 * --payload accepts either a bare payload object or a replay bundle
 * { task, payload, result } (the committed replay fixtures use the bundle
 * form). Exit 0 = every executed stage passed; 1 = a stage failed; 2 = usage.
 */
import fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

import { evaluateTaskReadiness } from "../dist/task-readiness.js";
import { validateAcceptanceEvidence } from "../dist/worker-acceptance.js";
import {
  collectSourceCarrierItems,
  normalizeSourceCarrierFile,
  sourceCarrierPath,
  sourceCarrierStats,
} from "./lib/source-carriers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_ONLY_BRIDGE = join(HERE, "source-only-local-analysis-bridge.mjs");

export const REPLAY_STAGES = ["readiness", "projection", "bridge-input", "bridge", "acceptance"];

/**
 * Balanced-brace JSON extraction from prompt message text — a faithful probe
 * of the pre-#1278 failure mode. Bridges used to recover their payload from
 * the task message's "Payload JSON:" excerpt; the handler bounds that excerpt
 * intentionally, so a large sourceBundle truncates it and balanced extraction
 * yields nothing → zero carriers → zero_files with a healthy-looking worker
 * exit. Current bridges read A2A_ANALYSIS_PAYLOAD_FILE instead; this probe
 * exists so replay reports show what a message-excerpt parser WOULD have seen.
 */
function messageExcerptPayload(message) {
  if (typeof message !== "string") return undefined;
  const marker = /Payload JSON\s*:/i.exec(message);
  if (!marker) return undefined;
  let depth = 0;
  let start = -1;
  for (let i = marker.index + marker[0].length; i < message.length; i += 1) {
    const ch = message[i];
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      if (depth === 0) return {};
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(message.slice(start, i + 1));
        } catch {
          return {};
        }
      }
    }
  }
  return {}; // never balanced — truncated excerpt
}

function synthesizedTask(payload, intent) {
  return {
    id: "replay-task",
    intent,
    status: "claimed",
    createdAt: new Date().toISOString(),
    payload,
  };
}

function stageReadiness(payload, intent) {
  const readiness = evaluateTaskReadiness(payload, { intent, mode: "enforce" });
  return {
    stage: "readiness",
    status: readiness.ok ? "pass" : "fail",
    ...(readiness.code ? { code: readiness.code } : {}),
    detail: { applies: readiness.applies, missing: readiness.missing, ...(readiness.details ? { details: readiness.details } : {}) },
  };
}

function stageProjection(payload) {
  const entries = collectSourceCarrierItems(payload);
  const drops = [];
  let projected = 0;
  for (const { carrier, item } of entries) {
    const outcome = normalizeSourceCarrierFile(item, { fallbackRepo: "replay" });
    if (outcome.reason === "ok") projected += 1;
    else drops.push({ carrier, path: sourceCarrierPath(item), reason: outcome.reason });
  }
  const stats = sourceCarrierStats(payload);
  return {
    stage: "projection",
    status: projected > 0 ? "pass" : "fail",
    ...(projected > 0 ? {} : { code: "source_projection_empty" }),
    detail: { stats, projectedFiles: projected, drops },
  };
}

function stageBridgeInput(task, payload) {
  // writeAnalysisBridgeInputFiles-equivalent (a2a-task-handler.mjs): the
  // handler's function is not importable (the handler executes on import), so
  // replay reproduces the same files + 3-point carrier instrumentation.
  const dir = mkdtempSync(join(tmpdir(), "a2a-replay-"));
  const taskFile = join(dir, "task.json");
  const payloadFile = join(dir, "payload.json");
  const payloadText = `${JSON.stringify(payload, null, 2)}\n`;
  writeFileSync(taskFile, `${JSON.stringify(task, null, 2)}\n`, "utf8");
  writeFileSync(payloadFile, payloadText, "utf8");
  const taskReceipt = sourceCarrierStats(payload);
  let payloadFileStats = taskReceipt;
  try {
    payloadFileStats = sourceCarrierStats(JSON.parse(fs.readFileSync(payloadFile, "utf8")));
  } catch {
    // fall through — mismatch below reports the corruption
  }
  const roundTripLossless = payloadFileStats.totalFiles === taskReceipt.totalFiles
    && payloadFileStats.totalBytes === taskReceipt.totalBytes;

  const excerpt = messageExcerptPayload(task?.message);
  const messageExcerpt = excerpt === undefined
    ? { present: false }
    : (() => {
      const stats = sourceCarrierStats(excerpt);
      return {
        present: true,
        stats,
        // The incident signature: a message-excerpt parser sees fewer carriers
        // than the payload file. Diagnostic, not a failure — current bridges
        // read the payload file (#1278).
        drift: stats.totalFiles !== payloadFileStats.totalFiles,
      };
    })();

  return {
    result: {
      stage: "bridge-input",
      status: roundTripLossless ? "pass" : "fail",
      ...(roundTripLossless ? {} : { code: "payload_file_roundtrip_lossy" }),
      detail: {
        sourceCarrierStats: {
          taskReceipt,
          payloadFile: payloadFileStats,
          payloadFileBytes: Buffer.byteLength(payloadText, "utf8"),
        },
        messageExcerpt,
      },
    },
    dir,
    taskFile,
    payloadFile,
  };
}

function stageBridge(payload, bridgeInput) {
  const sourceOnly = payload?.sourceOnly === true || payload?.source_only === true;
  if (!sourceOnly) {
    return {
      stage: "bridge",
      status: "skipped",
      detail: { reason: "provider-backed bridge (hermes/claude) is non-deterministic — replay stops at bridge-input for non-source-only payloads" },
    };
  }
  const spawned = spawnSync(process.execPath, [SOURCE_ONLY_BRIDGE], {
    env: {
      ...process.env,
      A2A_ANALYSIS_TASK_FILE: bridgeInput.taskFile,
      A2A_ANALYSIS_PAYLOAD_FILE: bridgeInput.payloadFile,
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  if (spawned.status !== 0) {
    return {
      stage: "bridge",
      status: "fail",
      code: "bridge_exit_nonzero",
      detail: { exitCode: spawned.status, stderr: (spawned.stderr ?? "").slice(0, 500) },
    };
  }
  let projection;
  try {
    const envelope = JSON.parse(spawned.stdout);
    projection = JSON.parse(envelope.payloads[0].text).sourceProjection;
  } catch (error) {
    return { stage: "bridge", status: "fail", code: "bridge_output_unparseable", detail: { error: String(error) } };
  }
  const blocked = projection?.quality === "zero_files" || projection?.quality === "insufficient";
  return {
    stage: "bridge",
    status: blocked ? "fail" : "pass",
    ...(blocked ? { code: `projection_${projection.quality}` } : {}),
    detail: { sourceProjection: projection },
  };
}

function stageAcceptance(task, result) {
  if (!result) {
    return {
      stage: "acceptance",
      status: "skipped",
      detail: { reason: "no preserved worker result supplied (--result) — nothing to judge" },
    };
  }
  // The acceptance COMMAND is side-effecting and never replayed; only the
  // preserved validations[] are judged, exactly as the broker judges them.
  const error = validateAcceptanceEvidence(task, result);
  return {
    stage: "acceptance",
    status: error ? "fail" : "pass",
    ...(error ? { code: error.code } : {}),
    detail: error ? { message: error.message } : { judged: "preserved validations[] (acceptance command execution skipped: side-effecting)" },
  };
}

/**
 * Replay one preserved round input. Pure orchestration over the deterministic
 * paths above; the only filesystem writes are the bridge-input files in a
 * fresh temp dir (removed unless keepDir). Returns
 * { ok, stages: [...], skippedBoundaries: [...], bridgeDir? }.
 */
export function replayRound({ task, payload, result, intent = "analyze", stage, keepDir = false } = {}) {
  if (!payload || typeof payload !== "object") {
    throw new Error("replayRound requires a payload object");
  }
  const effectiveTask = task && typeof task === "object" ? { ...task, payload: task.payload ?? payload } : synthesizedTask(payload, intent);
  const effectiveIntent = typeof effectiveTask.intent === "string" && effectiveTask.intent ? effectiveTask.intent : intent;
  const wanted = stage ? [stage] : REPLAY_STAGES;
  if (stage && !REPLAY_STAGES.includes(stage)) {
    throw new Error(`unknown stage '${stage}' (expected one of ${REPLAY_STAGES.join(", ")})`);
  }

  const stages = [];
  let bridgeInput;
  try {
    if (wanted.includes("readiness")) stages.push(stageReadiness(payload, effectiveIntent));
    if (wanted.includes("projection")) stages.push(stageProjection(payload));
    if (wanted.includes("bridge-input") || wanted.includes("bridge")) {
      bridgeInput = stageBridgeInput(effectiveTask, payload);
      if (wanted.includes("bridge-input")) stages.push(bridgeInput.result);
    }
    if (wanted.includes("bridge")) stages.push(stageBridge(payload, bridgeInput));
    if (wanted.includes("acceptance")) stages.push(stageAcceptance(effectiveTask, result));
  } finally {
    if (bridgeInput && !keepDir) rmSync(bridgeInput.dir, { recursive: true, force: true });
  }

  return {
    ok: stages.every((entry) => entry.status !== "fail"),
    stages,
    skippedBoundaries: [
      "provider/model calls",
      "worker dispatch",
      "GitHub side effects",
      "acceptance command execution",
    ],
    ...(bridgeInput && keepDir ? { bridgeDir: bridgeInput.dir } : {}),
  };
}

function readBundle(payloadPath, taskPath, resultPath) {
  const parsed = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
  const isBundle = parsed && typeof parsed === "object" && parsed.payload && typeof parsed.payload === "object";
  return {
    payload: isBundle ? parsed.payload : parsed,
    task: taskPath ? JSON.parse(fs.readFileSync(taskPath, "utf8")) : (isBundle ? parsed.task : undefined),
    result: resultPath ? JSON.parse(fs.readFileSync(resultPath, "utf8")) : (isBundle ? parsed.result : undefined),
  };
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      payload: { type: "string" },
      task: { type: "string" },
      result: { type: "string" },
      intent: { type: "string", default: "analyze" },
      stage: { type: "string" },
      "keep-dir": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });
  if (!values.payload) {
    process.stderr.write("usage: replay-round.mjs --payload <file.json> [--task t.json] [--result r.json] [--intent analyze] [--stage <name>] [--keep-dir] [--json]\n");
    return 2;
  }
  let bundle;
  try {
    bundle = readBundle(values.payload, values.task, values.result);
  } catch (error) {
    process.stderr.write(`cannot read replay input: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  let report;
  try {
    report = replayRound({ ...bundle, intent: values.intent, stage: values.stage, keepDir: values["keep-dir"] });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (values.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    for (const entry of report.stages) {
      const code = entry.code ? ` code=${entry.code}` : "";
      process.stdout.write(`${entry.status.toUpperCase().padEnd(7)} ${entry.stage}${code}\n`);
      if (entry.stage === "bridge-input" && entry.detail.messageExcerpt?.drift) {
        process.stdout.write(`        NOTE message-excerpt carrier drift detected (pre-#1278 parsers would see ${entry.detail.messageExcerpt.stats.totalFiles} file(s) vs ${entry.detail.sourceCarrierStats.payloadFile.totalFiles} in the payload file)\n`);
      }
    }
    process.stdout.write(`replay ${report.ok ? "ok" : "FAILED"} (skipped by design: ${report.skippedBoundaries.join(", ")})\n`);
    if (report.bridgeDir) process.stdout.write(`bridge input kept at ${report.bridgeDir}\n`);
  }
  return report.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
