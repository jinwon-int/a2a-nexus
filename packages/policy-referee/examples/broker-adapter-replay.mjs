#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  POLICY_REFEREE_EXIT,
  POLICY_REFEREE_TASK_SCHEMA,
  POLICY_REFEREE_WORKER_SCHEMA,
  evaluatePolicyRefereeCli,
  parsePolicyRefereePolicyDocument,
  parsePolicyRefereeTaskEnvelope,
  parsePolicyRefereeWorkerEnvelope,
} from "a2a-policy-referee";

const MANIFEST_SCHEMA = "a2a.policy-referee.broker-example-manifest.v1";
const RESULT_SCHEMA = "a2a.policy-referee.broker-example-result.v1";
const ERROR_SCHEMA = "a2a.policy-referee.broker-example-error.v1";
const MAX_MANIFEST_BYTES = 32_768;
const MAX_CASES = 16;
const CASE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const DECISIONS = new Set(["allow", "deny", "require_approval"]);
const CALLER_ACTIONS = new Set(["proceed", "observe_proceed", "reject", "route_approval"]);

const defaultManifestPath = fileURLToPath(
  new URL("./broker-adapter-cases.json", import.meta.url),
);

function invalidExample() {
  throw new Error("invalid_example");
}

function closedRecord(value, required, optional = []) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    invalidExample();
  }
  const record = value;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(record);
  if (
    required.some((key) => !Object.hasOwn(record, key)) ||
    keys.some((key) => !allowed.has(key)) ||
    Object.getOwnPropertySymbols(record).length !== 0
  ) {
    invalidExample();
  }
  return record;
}

function readManifest(path) {
  const bytes = readFileSync(path);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_MANIFEST_BYTES) invalidExample();
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text);
}

function parseBrokerInput(value) {
  const input = closedRecord(
    value,
    ["operation", "intent", "workerClass"],
    ["mode", "tasksToday", "implementation"],
  );
  if (input.operation !== "create" && input.operation !== "claim") invalidExample();

  const task = parsePolicyRefereeTaskEnvelope({
    schemaVersion: POLICY_REFEREE_TASK_SCHEMA,
    intent: input.intent,
    ...(Object.hasOwn(input, "mode") ? { mode: input.mode } : {}),
    evaluationPoint: input.operation,
    ...(Object.hasOwn(input, "tasksToday") ? { tasksToday: input.tasksToday } : {}),
  });
  const worker = parsePolicyRefereeWorkerEnvelope({
    schemaVersion: POLICY_REFEREE_WORKER_SCHEMA,
    workerClass: input.workerClass,
    ...(Object.hasOwn(input, "implementation")
      ? { implementation: input.implementation }
      : {}),
  });
  return { task, worker };
}

function callerActionFor(decision) {
  if (decision.action === "allow") return "proceed";
  if (decision.policyMode === "warn") return "observe_proceed";
  if (decision.action === "require_approval") return "route_approval";
  return "reject";
}

function replayManifest(rawManifest) {
  const manifest = closedRecord(rawManifest, ["schemaVersion", "cases"]);
  if (manifest.schemaVersion !== MANIFEST_SCHEMA) invalidExample();
  if (
    !Array.isArray(manifest.cases) ||
    Object.getPrototypeOf(manifest.cases) !== Array.prototype ||
    manifest.cases.length === 0 ||
    manifest.cases.length > MAX_CASES
  ) {
    invalidExample();
  }

  const ids = new Set();
  const results = [];
  for (const rawCase of manifest.cases) {
    const exampleCase = closedRecord(
      rawCase,
      ["id", "policy", "brokerInput", "expected"],
    );
    if (
      typeof exampleCase.id !== "string" ||
      exampleCase.id.length > 64 ||
      !CASE_ID_PATTERN.test(exampleCase.id) ||
      ids.has(exampleCase.id)
    ) {
      invalidExample();
    }
    ids.add(exampleCase.id);

    const expected = closedRecord(
      exampleCase.expected,
      ["decision", "callerAction"],
    );
    if (
      !DECISIONS.has(expected.decision) ||
      !CALLER_ACTIONS.has(expected.callerAction)
    ) {
      invalidExample();
    }

    const policy = parsePolicyRefereePolicyDocument(exampleCase.policy);
    const { task, worker } = parseBrokerInput(exampleCase.brokerInput);
    const { decision } = evaluatePolicyRefereeCli(policy, task, worker);
    const callerAction = callerActionFor(decision);
    if (
      decision.action !== expected.decision ||
      callerAction !== expected.callerAction
    ) {
      invalidExample();
    }
    results.push({
      schemaVersion: RESULT_SCHEMA,
      caseId: exampleCase.id,
      decision: decision.action,
      callerAction,
    });
  }
  return results;
}

function main() {
  if (process.argv.length > 3) invalidExample();
  const manifestPath = process.argv[2] ?? defaultManifestPath;
  const results = replayManifest(readManifest(manifestPath));
  process.stdout.write(`${results.map((result) => JSON.stringify(result)).join("\n")}\n`);
}

try {
  main();
} catch {
  process.stderr.write(
    `${JSON.stringify({ schemaVersion: ERROR_SCHEMA, code: "invalid_example" })}\n`,
  );
  process.exitCode = POLICY_REFEREE_EXIT.invalidInput;
}
