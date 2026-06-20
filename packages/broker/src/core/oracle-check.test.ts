/**
 * oracle-check.test.ts — ground-truth oracle adapter tests (#971)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkOracle, type OracleClaim } from "./oracle-check.js";

const checkedAt = "2026-06-21T04:30:00.000Z";

function githubClaim(overrides: Partial<OracleClaim> = {}): OracleClaim {
  return {
    taskId: "task-oracle-1",
    field: "merged",
    claimedValue: true,
    evidenceRef: "https://github.com/jinwon-int/a2a-nexus/pull/974",
    sourceKind: "github",
    ...overrides,
  };
}

describe("checkOracle (#971)", () => {
  it("matches a GitHub PR merged claim against injected trusted-source reality", async () => {
    const verdict = await checkOracle(githubClaim(), {
      now: () => checkedAt,
      github: async () => ({ kind: "github", exists: true, merged: true }),
    });

    assert.deepEqual(verdict, {
      match: true,
      actualValue: true,
      detail: "github.merged matched claimed value",
      checkedAt,
      sourceKind: "github",
      evidenceRef: "https://github.com/jinwon-int/a2a-nexus/pull/974",
    });
  });

  it("flags a GitHub PR merged claim as mismatch when reality says it is still open", async () => {
    const verdict = await checkOracle(githubClaim(), {
      now: () => checkedAt,
      github: async () => ({ kind: "github", exists: true, merged: false, state: "OPEN" }),
    });

    assert.equal(verdict.match, false);
    assert.equal(verdict.actualValue, false);
    assert.match(verdict.detail, /github\.merged mismatch/);
    assert.match(verdict.detail, /claimed=true/);
    assert.match(verdict.detail, /actual=false/);
  });

  it("returns unresolved, not mismatch, when the trusted-source fetcher cannot resolve evidence", async () => {
    const verdict = await checkOracle(githubClaim({ evidenceRef: "not-a-github-url" }), {
      now: () => checkedAt,
      github: async () => null,
    });

    assert.equal(verdict.match, "unresolved");
    assert.equal(verdict.actualValue, undefined);
    assert.match(verdict.detail, /unresolved/i);
  });

  it("supports hermetic file and CI claims through injected fetchers", async () => {
    const fileVerdict = await checkOracle({
      taskId: "task-file-claim",
      field: "exists",
      claimedValue: true,
      evidenceRef: "packages/broker/src/core/oracle-check.ts",
      sourceKind: "file",
    }, {
      now: () => checkedAt,
      file: async () => ({ kind: "file", exists: true }),
    });
    assert.equal(fileVerdict.match, true);

    const ciVerdict = await checkOracle({
      taskId: "task-ci-claim",
      field: "conclusion",
      claimedValue: "success",
      evidenceRef: "https://github.com/jinwon-int/a2a-nexus/actions/runs/1",
      sourceKind: "ci",
    }, {
      now: () => checkedAt,
      ci: async () => ({ kind: "ci", conclusion: "failure" }),
    });
    assert.equal(ciVerdict.match, false);
    assert.equal(ciVerdict.actualValue, "failure");
  });
});
