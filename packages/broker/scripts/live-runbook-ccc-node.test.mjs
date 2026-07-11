import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const suite = join(here, "live-runbooks", "ccc-node-3node-rollout.test.py");

test("ccc-node deterministic live runbook unit suite passes", () => {
  const result = spawnSync("python3", [suite], {
    encoding: "utf8",
    shell: false,
    timeout: 30_000,
    env: { PATH: "/usr/bin:/bin" },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
