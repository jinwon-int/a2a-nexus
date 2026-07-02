#!/usr/bin/env node
/**
 * Round-coordinator dispatch — build per-broker dispatch manifests for a
 * "PRs × workers" PR-review round, then hand off to a2a-dispatch-round.mjs.
 *
 * `a2a-dispatch-round.mjs` already dispatches a manifest to ONE broker with
 * fail-closed classification and queue-drain handling. The missing piece (this
 * script) is the round-level fan-out: expand a small set of PRs across each
 * team's workers, stamp parent-round provenance, and split lanes per team's
 * home broker (team1 → brokerAlpha, team2 → brokerBeta by default; #633) since a single
 * manifest targets a single brokerUrl.
 *
 * Usage:
 *   node scripts/round-coordinator-dispatch.mjs \
 *     --round-id pr-review-001 --prs 615,617,618,620 \
 *     --workers-team1 workerBeta,workerAlpha --workers-team2 workerEpsilon,workerZeta \
 *     --repo jinwon-int/a2a-nexus \
 *     --team1-broker-url https://brokerAlpha.example --team2-broker-url https://brokerBeta.example \
 *     --out-dir /tmp/round --dry-run
 *
 * --dry-run (default) writes the per-team manifests and prints the exact
 * dispatch commands. --execute additionally shells out to a2a-dispatch-round.mjs
 * per team (requires A2A_EDGE_SECRET; the secret is never a flag and never
 * printed). This script only creates broker tasks via that dispatcher — no
 * deploy, restart, DB/outbox mutation, release, or secret movement.
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_REPO = "jinwon-int/a2a-nexus";
// Team → home broker id mapping (BROKER_ID is the routing key of record, #633).
const DEFAULT_TEAM_BROKER_IDS = { team1: "brokerAlpha", team2: "brokerBeta" };

function csv(value) {
  return typeof value === "string"
    ? value.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
    : [];
}

function reviewMessage({ repo, pr, prUrl, roundId }) {
  return [
    `A2A dialectic PR review round ${roundId}.`,
    `Independently analyze pull request ${repo}#${pr} (${prUrl}).`,
    "Return findings, risks, and a recommendation (approve / request_changes / comment).",
    "Read-only: do not merge, push, or post external actions; evidence only.",
  ].join(" ");
}

/**
 * Build one dispatch manifest per team that has workers. Lanes are expanded as
 * team → pr → worker with a global parent-round order/total spanning the whole
 * round (across both teams), so a finalizer can track the full round even
 * though lanes are dispatched to separate brokers.
 *
 * @returns {{ manifests: object[], total: number, summary: object[] }}
 */
export function buildRoundManifests(input) {
  const errors = [];
  const roundId = typeof input.roundId === "string" ? input.roundId.trim() : "";
  if (!roundId) errors.push("roundId is required");

  const prs = (Array.isArray(input.prs) ? input.prs : []).map((p) => String(p).trim()).filter(Boolean);
  if (prs.length === 0) errors.push("at least one PR is required");

  const repo = (typeof input.repo === "string" && input.repo.trim()) || DEFAULT_REPO;
  const intent = (typeof input.intent === "string" && input.intent.trim()) || "analyze";
  const requester = {
    id: input.requester?.id?.trim() || "round-coordinator",
    role: input.requester?.role?.trim() || "operator",
  };

  const teams = (Array.isArray(input.teams) ? input.teams : [])
    .map((team) => ({
      teamId: String(team.teamId ?? "").trim(),
      homeBrokerId: String(team.homeBrokerId ?? "").trim(),
      brokerUrl: String(team.brokerUrl ?? "").trim(),
      workers: (Array.isArray(team.workers) ? team.workers : []).map((w) => String(w).trim()).filter(Boolean),
    }))
    .filter((team) => team.workers.length > 0);

  if (teams.length === 0) errors.push("at least one team with workers is required");
  for (const team of teams) {
    if (!team.teamId) errors.push("each team needs a teamId");
    if (!team.homeBrokerId) errors.push(`team ${team.teamId || "(unknown)"} needs a homeBrokerId`);
    if (!team.brokerUrl) errors.push(`team ${team.teamId || "(unknown)"} needs a brokerUrl`);
  }

  if (errors.length) {
    const err = new Error(`invalid round input:\n- ${errors.join("\n- ")}`);
    err.validationErrors = errors;
    throw err;
  }

  // Deterministic global ordering: team → pr → worker.
  const flat = [];
  for (const team of teams) {
    for (const pr of prs) {
      for (const worker of team.workers) {
        flat.push({ team, pr, worker });
      }
    }
  }
  const total = flat.length;

  const lanesByTeam = new Map();
  flat.forEach((entry, index) => {
    const order = index + 1; // 1-based global parent-round order
    const { team, pr, worker } = entry;
    const prUrl = `https://github.com/${repo}/pull/${pr}`;
    const lane = {
      id: `${roundId}:pr${pr}:${worker}`,
      intent,
      target: { id: worker, kind: "agent", role: "analyst" },
      assignedWorkerId: worker,
      message: reviewMessage({ repo, pr, prUrl, roundId }),
      payload: {
        prUrl,
        prRepo: repo,
        pr: Number(pr),
        teamId: team.teamId,
        homeBrokerId: team.homeBrokerId,
        reviewMode: "source-only",
        // Explicit global parent-round provenance (do NOT let the dispatcher
        // default parentRoundTotal to a single team's lane count).
        parentRoundId: roundId,
        parentRoundTotal: total,
        parentRoundOrder: order,
      },
    };
    if (!lanesByTeam.has(team.teamId)) lanesByTeam.set(team.teamId, []);
    lanesByTeam.get(team.teamId).push(lane);
  });

  const manifests = teams.map((team) => ({
    roundId,
    teamId: team.teamId,
    homeBrokerId: team.homeBrokerId,
    brokerUrl: team.brokerUrl,
    requester,
    defaults: { intent },
    lanes: lanesByTeam.get(team.teamId) ?? [],
  }));

  const summary = manifests.map((m) => ({
    teamId: m.teamId,
    homeBrokerId: m.homeBrokerId,
    lanes: m.lanes.length,
  }));

  return { manifests, total, summary };
}

function manifestFileName(roundId, teamId) {
  const safe = `${roundId}.${teamId}`.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${safe}.manifest.json`;
}

function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "round-id": { type: "string" },
      prs: { type: "string" },
      repo: { type: "string" },
      "workers-team1": { type: "string" },
      "workers-team2": { type: "string" },
      "team1-broker-url": { type: "string" },
      "team2-broker-url": { type: "string" },
      "team1-broker-id": { type: "string" },
      "team2-broker-id": { type: "string" },
      "requester-id": { type: "string" },
      "requester-role": { type: "string" },
      intent: { type: "string" },
      "out-dir": { type: "string" },
      "dry-run": { type: "boolean" },
      execute: { type: "boolean" },
      "execute-timeout-ms": { type: "string" },
    },
    allowPositionals: false,
  });
  return values;
}

function buildTeamsFromCli(values) {
  const teams = [];
  const t1 = csv(values["workers-team1"]);
  if (t1.length) {
    teams.push({
      teamId: "team1",
      homeBrokerId: values["team1-broker-id"] || DEFAULT_TEAM_BROKER_IDS.team1,
      brokerUrl: values["team1-broker-url"] || "",
      workers: t1,
    });
  }
  const t2 = csv(values["workers-team2"]);
  if (t2.length) {
    teams.push({
      teamId: "team2",
      homeBrokerId: values["team2-broker-id"] || DEFAULT_TEAM_BROKER_IDS.team2,
      brokerUrl: values["team2-broker-url"] || "",
      workers: t2,
    });
  }
  return teams;
}

const DEFAULT_EXECUTE_TIMEOUT_MS = 600000; // 10 min per child dispatch

/**
 * Classify one child dispatch into the execution report: dispatched | failed |
 * timeout, with bounded evidence and any task ids / lane classifications parsed
 * from the dispatcher's --json output. Surfacing classifications (e.g.
 * already-exists) makes the idempotent re-run behavior explicit.
 */
export function classifyChildResult(entry, child) {
  const base = { teamId: entry.teamId, brokerUrl: entry.brokerUrl };
  const timedOut = Boolean(child.error && (child.error.code === "ETIMEDOUT" || child.signal === "SIGTERM"));
  if (timedOut) {
    return { ...base, status: "timeout", exitCode: child.status ?? null, error: "child dispatch exceeded execute timeout" };
  }

  let report = null;
  if (typeof child.stdout === "string" && child.stdout.trim()) {
    try {
      report = JSON.parse(child.stdout);
    } catch {
      /* dispatcher produced non-JSON output; leave report null */
    }
  }
  const laneResults = report && Array.isArray(report.results) ? report.results : [];
  const taskIds = laneResults.map((r) => r && r.taskId).filter(Boolean);
  const classifications = {};
  for (const r of laneResults) {
    const c = r && typeof r.classification === "string" ? r.classification : "unknown";
    classifications[c] = (classifications[c] ?? 0) + 1;
  }

  const ok = child.status === 0;
  const result = { ...base, status: ok ? "dispatched" : "failed", exitCode: child.status ?? null, taskIds, classifications };
  if (!ok) {
    const stderr = typeof child.stderr === "string" ? child.stderr : "";
    result.error = stderr.slice(-500) || "dispatch exited non-zero";
  }
  return result;
}

/**
 * Execute each team's manifest by invoking the dispatcher with a per-child
 * timeout. Lane ids are deterministic, so a re-run is idempotent and surfaces
 * already-created tasks via the dispatcher's classifications. The injected
 * spawn keeps this unit-testable; no network/secret handling lives here.
 */
export function runExecute(written, { dispatcherPath, timeoutMs = DEFAULT_EXECUTE_TIMEOUT_MS, spawnImpl, nodePath = process.execPath }) {
  const results = [];
  for (const entry of written) {
    const child = spawnImpl(nodePath, [dispatcherPath, "--manifest", entry.file, "--json"], {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    results.push(classifyChildResult(entry, child));
  }
  return { ok: results.every((r) => r.status === "dispatched"), timeoutMs, results };
}

function main() {
  const values = parseCli(process.argv.slice(2));
  const execute = Boolean(values.execute);
  const outDir = values["out-dir"] || process.cwd();

  let built;
  try {
    built = buildRoundManifests({
      roundId: values["round-id"],
      prs: csv(values.prs),
      repo: values.repo,
      intent: values.intent,
      requester: { id: values["requester-id"], role: values["requester-role"] },
      teams: buildTeamsFromCli(values),
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const manifest of built.manifests) {
    const file = path.join(outDir, manifestFileName(manifest.roundId, manifest.teamId));
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
    written.push({ teamId: manifest.teamId, file, brokerUrl: manifest.brokerUrl });
  }

  console.log(JSON.stringify({ roundId: values["round-id"], total: built.total, summary: built.summary, written: written.map((w) => ({ teamId: w.teamId, file: w.file })) }, null, 2));

  const dispatcher = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "a2a-dispatch-round.mjs");
  for (const w of written) {
    console.log(`# ${w.teamId} → ${w.brokerUrl}`);
    console.log(`node ${dispatcher} --manifest ${w.file}${execute ? "" : " --dry-run"}`);
  }

  if (!execute) {
    return;
  }

  // Execute: dispatch each team's manifest to its broker (A2A_EDGE_SECRET from
  // the environment only) with a per-child timeout. Fail-closed: a failed or
  // timed-out team makes the run exit non-zero. The structured report records
  // per-team status, exit code, task ids, and lane classifications.
  const rawTimeout = Number(values["execute-timeout-ms"]);
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_EXECUTE_TIMEOUT_MS;
  const report = runExecute(written, { dispatcherPath: dispatcher, timeoutMs, spawnImpl: spawnSync });
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
