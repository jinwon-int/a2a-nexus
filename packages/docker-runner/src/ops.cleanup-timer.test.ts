import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTtlMs, resolveWorkdirTtl } from "./config.js";
import { checkWorkdirRetention, installCleanupTimer } from "./ops.js";

/** #2267 R2: opt-in workDir retention — timer unit files + doctor probe. */

test("#2267 parseTtlMs accepts d/h/m/s/ms and rejects garbage", () => {
  assert.equal(parseTtlMs("14d"), 14 * 86_400_000);
  assert.equal(parseTtlMs("36h"), 36 * 3_600_000);
  assert.equal(parseTtlMs(" 30m "), 30 * 60_000);
  assert.equal(parseTtlMs("5000"), 5000);
  assert.throws(() => parseTtlMs("2 weeks"), /invalid ttl/);
  assert.throws(() => parseTtlMs("-1d"), /invalid ttl/);
});

test("#2267 resolveWorkdirTtl is undefined when unset and throws on an invalid value", () => {
  assert.equal(resolveWorkdirTtl({}), undefined);
  assert.equal(resolveWorkdirTtl({ A2A_DOCKER_RUNNER_WORKDIR_TTL: "  " }), undefined);
  assert.deepEqual(resolveWorkdirTtl({ A2A_DOCKER_RUNNER_WORKDIR_TTL: "14d" }), { raw: "14d", ttlMs: 14 * 86_400_000 });
  assert.throws(() => resolveWorkdirTtl({ A2A_DOCKER_RUNNER_WORKDIR_TTL: "fortnight" }), /invalid ttl/);
});

test("#2267 installCleanupTimer writes service+timer units, is idempotent, and never touches systemctl", async () => {
  const unitDir = await mkdtemp(join(tmpdir(), "a2a-cleanup-timer-"));
  const options = {
    cliPath: "/opt/a2a-docker-runner/dist/cli.js",
    envFile: "/etc/default/a2a-hermes-worker",
    ttl: "14d",
    unitDir,
    nodePath: "/usr/bin/node",
  };

  const first = await installCleanupTimer(options);
  assert.equal(first.ok, true);
  assert.equal(first.unitName, "a2a-docker-runner-cleanup");
  assert.equal(first.ttlMs, 14 * 86_400_000);
  assert.deepEqual(first.changed, [first.service, first.timer]);
  assert.equal((await stat(first.service)).mode & 0o777, 0o644);

  const service = await readFile(first.service, "utf8");
  assert.match(service, /^Type=oneshot$/m);
  assert.match(
    service,
    /^ExecStart=\/usr\/bin\/node \/opt\/a2a-docker-runner\/dist\/cli\.js cleanup --env-file \/etc\/default\/a2a-hermes-worker --ttl 14d$/m,
  );
  const timer = await readFile(first.timer, "utf8");
  assert.match(timer, /^OnCalendar=daily$/m);
  assert.match(timer, /^Persistent=true$/m);
  assert.match(timer, /^Unit=a2a-docker-runner-cleanup\.service$/m);
  assert.match(timer, /^WantedBy=timers\.target$/m);

  // Operator steps are reported, not executed.
  assert.ok(first.nextSteps.some((step) => /--dry-run/.test(step)));
  assert.ok(first.nextSteps.some((step) => /systemctl enable --now a2a-docker-runner-cleanup\.timer/.test(step)));

  const second = await installCleanupTimer(options);
  assert.deepEqual(second.changed, []);

  const retuned = await installCleanupTimer({ ...options, ttl: "7d" });
  assert.deepEqual(retuned.changed, [retuned.service]);
  assert.match(await readFile(retuned.service, "utf8"), /--ttl 7d$/m);
});

test("#2267 installCleanupTimer rejects an invalid TTL before writing anything", async () => {
  const unitDir = await mkdtemp(join(tmpdir(), "a2a-cleanup-timer-"));
  await assert.rejects(
    installCleanupTimer({ cliPath: "/x/cli.js", envFile: "/x/env", ttl: "soon", unitDir }),
    /invalid ttl/,
  );
  await assert.rejects(stat(join(unitDir, "a2a-docker-runner-cleanup.service")));
});

test("#2267 workdir retention doctor: unset TTL warns with a hint", async () => {
  const report = await checkWorkdirRetention({ env: {} });
  assert.equal(report.status, "warn");
  assert.match(report.message, /no workDir retention configured/);
  assert.match(String(report.detail?.hint), /install --cleanup-timer/);
});

test("#2267 workdir retention doctor: TTL set but units missing warns", async () => {
  const unitDir = await mkdtemp(join(tmpdir(), "a2a-retention-"));
  const report = await checkWorkdirRetention({ env: { A2A_DOCKER_RUNNER_WORKDIR_TTL: "14d" }, unitDir });
  assert.equal(report.status, "warn");
  assert.match(report.message, /timer unit is not installed/);
  assert.equal(report.detail?.ttlMs, 14 * 86_400_000);
});

test("#2267 workdir retention doctor: installed + active timer is ok, inactive warns, no systemctl warns", async () => {
  const unitDir = await mkdtemp(join(tmpdir(), "a2a-retention-"));
  await installCleanupTimer({ cliPath: "/x/cli.js", envFile: "/x/env", ttl: "14d", unitDir });
  const env = { A2A_DOCKER_RUNNER_WORKDIR_TTL: "14d" };

  const active = await checkWorkdirRetention({ env, unitDir, systemctl: () => ({ status: 0, stdout: "active" }) });
  assert.equal(active.status, "ok", JSON.stringify(active));
  assert.equal(active.detail?.timerState, "active");

  const inactive = await checkWorkdirRetention({ env, unitDir, systemctl: () => ({ status: 3, stdout: "inactive" }) });
  assert.equal(inactive.status, "warn");
  assert.match(inactive.message, /not active \(inactive\)/);

  const noSystemctl = await checkWorkdirRetention({ env, unitDir, systemctl: () => undefined });
  assert.equal(noSystemctl.status, "warn");
  assert.match(noSystemctl.message, /systemctl is unavailable/);
});

test("#2267 workdir retention doctor: invalid TTL value warns instead of throwing", async () => {
  const report = await checkWorkdirRetention({ env: { A2A_DOCKER_RUNNER_WORKDIR_TTL: "never" } });
  assert.equal(report.status, "warn");
  assert.match(report.message, /invalid/);
});
