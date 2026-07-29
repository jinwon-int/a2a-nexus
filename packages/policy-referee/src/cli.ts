#!/usr/bin/env node
import { closeSync, fstatSync, openSync, readFileSync, writeFileSync } from "node:fs";

import {
  POLICY_REFEREE_ERROR_SCHEMA,
  POLICY_REFEREE_EXIT,
  PolicyRefereeInputError,
  evaluatePolicyRefereeCli,
  parsePolicyRefereePolicyDocument,
  parsePolicyRefereeTaskEnvelope,
  parsePolicyRefereeWorkerEnvelope,
  type PolicyRefereeErrorCode,
  type PolicyRefereeInputKind,
} from "./cli-contract.js";

const MAX_FILE_BYTES: Readonly<Record<"policy" | "task" | "worker", number>> = Object.freeze({
  policy: 65_536,
  task: 4_096,
  worker: 4_096,
});

function cliError(
  code: PolicyRefereeErrorCode,
  input: PolicyRefereeInputKind,
  path = "$",
): PolicyRefereeInputError {
  return new PolicyRefereeInputError(code, input, path);
}

function readJsonInput(sourcePath: string, input: "policy" | "task" | "worker"): unknown {
  let descriptor: number | undefined;
  let bytes: Buffer;
  try {
    descriptor = openSync(sourcePath, "r");
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw cliError("file_unreadable", input);
    if (stat.size > MAX_FILE_BYTES[input]) throw cliError("file_too_large", input);
    bytes = readFileSync(descriptor);
    if (bytes.byteLength > MAX_FILE_BYTES[input]) throw cliError("file_too_large", input);
  } catch (error) {
    if (error instanceof PolicyRefereeInputError) throw error;
    throw cliError("file_unreadable", input);
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // A close failure is handled by the outer fail-closed boundary.
      }
    }
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw cliError("invalid_utf8", input);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw cliError("invalid_json", input);
  }
}

function writeStableError(
  code: PolicyRefereeErrorCode | "internal_failure",
  input: PolicyRefereeInputKind,
  path: string,
): void {
  writeFileSync(2, `${JSON.stringify({
    schemaVersion: POLICY_REFEREE_ERROR_SCHEMA,
    code,
    input,
    path,
  })}\n`);
}

export function main(args: readonly string[]): number {
  if (args.length !== 4 || args[0] !== "check") {
    writeStableError("invalid_usage", "arguments", "$");
    return POLICY_REFEREE_EXIT.invalidInput;
  }

  try {
    const policy = parsePolicyRefereePolicyDocument(readJsonInput(args[1], "policy"));
    const task = parsePolicyRefereeTaskEnvelope(readJsonInput(args[2], "task"));
    const worker = parsePolicyRefereeWorkerEnvelope(readJsonInput(args[3], "worker"));
    const result = evaluatePolicyRefereeCli(policy, task, worker);
    writeFileSync(1, `${JSON.stringify(result.decision)}\n`);
    return result.exitCode;
  } catch (error) {
    if (error instanceof PolicyRefereeInputError) {
      writeStableError(error.code, error.input, error.path);
      return POLICY_REFEREE_EXIT.invalidInput;
    }
    writeStableError("internal_failure", "arguments", "$");
    return POLICY_REFEREE_EXIT.internalFailure;
  }
}

process.exitCode = main(process.argv.slice(2));
