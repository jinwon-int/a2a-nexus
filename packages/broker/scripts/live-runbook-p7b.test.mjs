// Runs the hermetic bash suites of the shared-state Phase 7-B operator runbook
// (live-runbooks/phase7b, a2a-nexus#1504 / #2379). Every host probe (docker,
// systemctl, shutdown, apt-config, ssh, gh) is stubbed inside the suites; they
// never touch a broker, systemd or apt.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "live-runbooks", "phase7b");

for (const [suite, target] of [
  ["test-run-b.sh", "run-b.sh"],
  ["test-collect-p7b.sh", "collect-p7b.sh"],
]) {
  test(`phase7b ${suite} passes`, () => {
    const result = spawnSync("bash", [join(dir, suite), join(dir, target)], {
      encoding: "utf8",
      shell: false,
      timeout: 240_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME ?? "/tmp", LANG: "C.UTF-8" },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /---- \d+ passed, 0 failed/);
  });
}
