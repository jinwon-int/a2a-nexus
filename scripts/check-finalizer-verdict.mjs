#!/usr/bin/env node
/**
 * Finalizer-verdict enforcement gate (#1383 V-d) — the "teeth" that make an
 * independent, verifiable finalizer verdict enforceable at the merge point.
 *
 * Contract: contracts/a2a/finalizer-verdict.md
 *
 * The gate checks VALIDITY, never quality — it does not re-run the judgment.
 * For a PR it requires, fail-closed:
 *   1. a well-formed, signed verdict whose finalizerKeyId is in the REGISTERED
 *      finalizer keyring (integrity + registered-key, via verifyVerdict),
 *   2. the verdict subject bound to this exact PR head SHA (no transplant/stale),
 *   3. decision === "go",
 *   4. INDEPENDENCE: the finalizer key is not a key that produced the subject
 *      (self-certification rejected — judge != player).
 *
 * Rollout: `warn` reports violations without blocking; `enforce` blocks (the
 * G1 warn->enforce pattern). Structural independence comes from finalizer keys
 * and worker keys living in disjoint role registries (#1383 V-c); the explicit
 * producing-worker-key check here is belt-and-suspenders and works standalone.
 *
 * Safety: source-only. No network, no writes, no dispatch/restart. No secrets.
 *
 * Usage:
 *   node scripts/check-finalizer-verdict.mjs --verdict <v.json> --head-sha <sha> \
 *     --finalizer-keyring <k.json> [--worker-keys id1,id2] [--mode warn|enforce] [--json]
 */
import fs from "node:fs";
import { parseArgs } from "node:util";

import { verifyVerdict } from "./verify-finalizer-verdict.mjs";

/**
 * Evaluate the gate for a PR. Returns { ok, blocked, mode, decision,
 * finalizerKeyId, reasons }. `ok` = the verdict fully satisfies the gate;
 * `blocked` = the gate blocks the merge (enforce mode with violations).
 */
export function evaluateVerdictGate({ verdict, headSha, finalizerKeyring, producingWorkerKeyIds = [], mode = "warn" }) {
  const reasons = [];
  const expectedSubject = { kind: "pr", prHeadSha: headSha };
  const v = verifyVerdict(verdict, finalizerKeyring, { expectedSubject });
  for (const c of v.checks) {
    if (!c.ok) reasons.push(`${c.id}: ${c.detail}`);
  }
  if (v.decision !== "go") {
    reasons.push(`decision is '${v.decision ?? "absent"}', gate requires 'go'`);
  }
  if (v.finalizerKeyId && producingWorkerKeyIds.includes(v.finalizerKeyId)) {
    reasons.push(`independence violation: finalizerKeyId '${v.finalizerKeyId}' produced the subject (self-certification)`);
  }
  const violations = reasons.length > 0;
  const enforce = mode === "enforce";
  return {
    ok: !violations,
    blocked: enforce && violations,
    mode,
    decision: v.decision,
    finalizerKeyId: v.finalizerKeyId,
    reasons,
  };
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      verdict: { type: "string" },
      "head-sha": { type: "string" },
      "finalizer-keyring": { type: "string" },
      "worker-keys": { type: "string" },
      mode: { type: "string", default: "warn" },
      json: { type: "boolean", default: false },
    },
  });
  if (!values.verdict || !values["head-sha"] || !values["finalizer-keyring"]) {
    process.stderr.write("usage: check-finalizer-verdict.mjs --verdict <v.json> --head-sha <sha> --finalizer-keyring <k.json> [--worker-keys id1,id2] [--mode warn|enforce]\n");
    return 2;
  }
  if (values.mode !== "warn" && values.mode !== "enforce") {
    process.stderr.write(`invalid --mode '${values.mode}' (expected warn|enforce)\n`);
    return 2;
  }
  let verdict;
  let finalizerKeyring;
  try {
    verdict = JSON.parse(fs.readFileSync(values.verdict, "utf8"));
    finalizerKeyring = JSON.parse(fs.readFileSync(values["finalizer-keyring"], "utf8"));
  } catch (err) {
    process.stderr.write(`cannot read input: ${err.message}\n`);
    return 2;
  }
  const producingWorkerKeyIds = (values["worker-keys"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  const result = evaluateVerdictGate({
    verdict,
    headSha: values["head-sha"],
    finalizerKeyring,
    producingWorkerKeyIds,
    mode: values.mode,
  });

  if (values.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok) {
    process.stdout.write(`finalizer-verdict gate ok (decision=go, key=${result.finalizerKeyId}, mode=${result.mode})\n`);
  } else {
    const label = result.blocked ? "BLOCKED" : "WARN";
    for (const r of result.reasons) process.stdout.write(`${label}  ${r}\n`);
    process.stdout.write(`finalizer-verdict gate ${result.blocked ? "blocked the merge" : "found violations (warn mode — not blocking)"}\n`);
  }
  // Fail (block) only when enforcing and violations exist.
  return result.blocked ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
