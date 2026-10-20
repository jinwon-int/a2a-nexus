import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

import { loadConfig } from "./config.js";
import { egressProxyRunTokenDigest } from "./egress-proxy.js";
import {
  buildEgressProxyRunArgs,
  checkEgressProxyReady,
  defaultEgressStateDir,
  EGRESS_PROXY_BUNDLE_FILES,
  EGRESS_PROXY_LABEL_KEY,
  egressStatePaths,
  installEgressProxy,
  parseEgressMode,
  prepareEgressRunCredentials,
  stageEgressProxyBundle,
  type EgressExec,
  type EgressExecResult,
} from "./egress-runtime.js";
import { checkContainerHardening, checkEgressProxy } from "./ops.js";
import { buildRunArgs, runTask } from "./runner.js";
import type { RunnerConfig } from "./types.js";

const trackedTempDirs: string[] = [];
function trackTempDir(dir: string): string {
  trackedTempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of trackedTempDirs) rmSync(dir, { recursive: true, force: true });
});

const DIST_DIR = fileURLToPath(new URL(".", import.meta.url));

const trustedClaude = {
  A2A_DOCKER_RUNNER_SKIP_ENGINE_DETECT: "1",
  A2A_DOCKER_RUNNER_TRUSTED_OPERATOR: "1",
  A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "claude-code",
};

function egressConfig(overrides: Partial<RunnerConfig> = {}): RunnerConfig {
  return {
    rootDir: "/var/lib/openclaw-a2a/tasks",
    image: "a2a-runner:test",
    engine: "docker",
    defaultTimeoutMs: 10_000,
    trustedOperator: true,
    network: "a2a-egress-internal",
    egressMode: "observe",
    egressNetwork: "a2a-egress-internal",
    egressProxyName: "a2a-egress-proxy",
    egressProxyAllowlist: [],
    user: "1000:1000",
    capDrop: ["ALL"],
    readOnlyRootFilesystem: true,
    ...overrides,
  };
}

function ok(stdout = ""): EgressExecResult {
  return { code: 0, stdout, stderr: "" };
}
const missing: EgressExecResult = { code: 1, stdout: "", stderr: "Error: No such object" };

function networkJson(internal: boolean, key: "Internal" | "internal" = "Internal"): string {
  return JSON.stringify([{ Name: "a2a-egress-internal", [key]: internal }]);
}

function proxyJson(opts: { label?: boolean; running?: boolean; restarting?: boolean; health?: string | null; networks?: string[]; mode?: string } = {}): string {
  const { label = true, running = true, restarting = false, health = "healthy", networks = ["bridge", "a2a-egress-internal"], mode = "observe" } = opts;
  return JSON.stringify([
    {
      Config: {
        Labels: label ? { [EGRESS_PROXY_LABEL_KEY]: "1" } : {},
        Env: [`A2A_EGRESS_PROXY_MODE=${mode}`, "A2A_EGRESS_PROXY_ALLOWLIST=", "PATH=/usr/bin"],
      },
      State: { Running: running, Restarting: restarting, ...(health === null ? {} : { Health: { Status: health } }) },
      NetworkSettings: { Networks: Object.fromEntries(networks.map((n) => [n, {}])) },
    },
  ]);
}

function fakeExec(handlers: { network?: EgressExecResult; container?: EgressExecResult; other?: (args: string[]) => EgressExecResult }) {
  const calls: string[][] = [];
  const exec: EgressExec = async (_engine, args) => {
    calls.push(args);
    if (args[0] === "network" && args[1] === "inspect") return handlers.network ?? missing;
    if (args[0] === "container" && args[1] === "inspect") return handlers.container ?? missing;
    return handlers.other ? handlers.other(args) : ok();
  };
  return { exec, calls };
}

test("parseEgressMode defaults to off and rejects unknown values", () => {
  assert.equal(parseEgressMode(undefined), "off");
  assert.equal(parseEgressMode(" "), "off");
  assert.equal(parseEgressMode("Observe"), "observe");
  assert.equal(parseEgressMode("enforce"), "enforce");
  assert.throws(() => parseEgressMode("on"), /off, observe, enforce/);
});

test("mode off leaves the config exactly as before (no egress fields, bridge network)", async () => {
  const config = await loadConfig({ ...trustedClaude });
  assert.equal(config.network, "bridge");
  for (const key of ["egressMode", "egressNetwork", "egressProxyName", "egressProxyAllowlist", "egressStateDir"] as const) {
    assert.equal(key in config, false, key);
  }
  const explicitOff = await loadConfig({ ...trustedClaude, A2A_DOCKER_RUNNER_EGRESS_MODE: "off" });
  assert.deepEqual(Object.keys(explicitOff).sort(), Object.keys(config).sort());
});

test("observe routes the task network onto the managed internal network", async () => {
  const config = await loadConfig({ ...trustedClaude, A2A_DOCKER_RUNNER_EGRESS_MODE: "observe" });
  assert.equal(config.egressMode, "observe");
  assert.equal(config.network, "a2a-egress-internal");
  assert.equal(config.egressProxyName, "a2a-egress-proxy");
  assert.deepEqual(config.egressProxyAllowlist, []);

  const custom = await loadConfig({
    ...trustedClaude,
    A2A_DOCKER_RUNNER_EGRESS_MODE: "enforce",
    A2A_DOCKER_RUNNER_EGRESS_NETWORK: "lane-egress",
    A2A_DOCKER_RUNNER_EGRESS_PROXY_NAME: "lane-proxy",
    A2A_DOCKER_RUNNER_EGRESS_PROXY_ALLOWLIST: "api.github.com,github.com",
    A2A_DOCKER_RUNNER_EGRESS_STATE_DIR: "/srv/egress",
    A2A_DOCKER_RUNNER_NETWORK: "lane-egress",
  });
  assert.equal(custom.network, "lane-egress");
  assert.deepEqual(custom.egressProxyAllowlist, ["api.github.com", "github.com"]);
  assert.equal(custom.egressStateDir, "/srv/egress");
});

test("egress config fails closed on conflicts and unsafe values", async () => {
  const cases: Array<[Record<string, string>, RegExp]> = [
    [{ A2A_DOCKER_RUNNER_EGRESS_MODE: "observe", A2A_DOCKER_RUNNER_NETWORK: "bridge" }, /conflicts with A2A_DOCKER_RUNNER_EGRESS_MODE/],
    [{ A2A_DOCKER_RUNNER_EGRESS_MODE: "sometimes" }, /off, observe, enforce/],
    [{ A2A_DOCKER_RUNNER_EGRESS_MODE: "enforce" }, /requires A2A_DOCKER_RUNNER_EGRESS_PROXY_ALLOWLIST/],
    [{ A2A_DOCKER_RUNNER_EGRESS_MODE: "enforce", A2A_DOCKER_RUNNER_EGRESS_PROXY_ALLOWLIST: "10.0.0.1" }, /IP literals/],
    [{ A2A_DOCKER_RUNNER_EGRESS_MODE: "observe", A2A_DOCKER_RUNNER_EGRESS_NETWORK: "bridge" }, /dedicated managed name/],
    [{ A2A_DOCKER_RUNNER_EGRESS_MODE: "observe", A2A_DOCKER_RUNNER_EGRESS_PROXY_NAME: "bad name" }, /invalid egress proxy name/],
    [{ A2A_DOCKER_RUNNER_EGRESS_MODE: "observe", A2A_DOCKER_RUNNER_EGRESS_PROXY_NAME: "a2a-egress-internal" }, /must differ/],
    [{ A2A_DOCKER_RUNNER_EGRESS_MODE: "observe", A2A_DOCKER_RUNNER_EGRESS_STATE_DIR: "relative/dir" }, /absolute path/],
  ];
  for (const [env, pattern] of cases) {
    await assert.rejects(loadConfig({ ...trustedClaude, ...env }), pattern, JSON.stringify(env));
  }
  await assert.rejects(
    loadConfig({ A2A_DOCKER_RUNNER_SKIP_ENGINE_DETECT: "1", A2A_DOCKER_RUNNER_EGRESS_MODE: "observe" }),
    /trusted-operator patch lanes/,
  );
});

test("egress state lives beside the task root so workDir cleanup never sees it", () => {
  assert.equal(defaultEgressStateDir("/var/lib/openclaw-a2a/tasks"), "/var/lib/openclaw-a2a/tasks-egress");
  assert.equal(defaultEgressStateDir("/srv/runs/"), "/srv/runs-egress");
  const paths = egressStatePaths({ rootDir: "/var/lib/openclaw-a2a/tasks" });
  assert.ok(!paths.base.startsWith("/var/lib/openclaw-a2a/tasks/"));
  assert.equal(egressStatePaths({ rootDir: "/x", egressStateDir: "/srv/egress" }).credentials, "/srv/egress/credentials");
});

test("per-run credentials: digest for the proxy, token only in a 0600 env file, both removed on cleanup", async () => {
  const stateDir = trackTempDir(mkdtempSync(join(tmpdir(), "egress-runtime-state-")));
  const runToken = "20261020T040000-abc-xyz12345";
  const creds = await prepareEgressRunCredentials({ rootDir: "/unused", egressStateDir: stateDir, egressProxyName: "a2a-egress-proxy" }, runToken);
  const envText = readFileSync(creds.envFile, "utf8");
  assert.equal(statSync(creds.envFile).mode & 0o777, 0o600);
  const match = /^HTTPS_PROXY=http:\/\/([^:]+):([^@]+)@a2a-egress-proxy:3128$/m.exec(envText);
  assert.ok(match, envText);
  assert.equal(match[1], runToken);
  const token = match[2]!;
  assert.ok(token.length >= 32);
  for (const key of ["HTTP_PROXY", "https_proxy", "http_proxy"]) assert.match(envText, new RegExp(`^${key}=http://`, "m"));
  assert.match(envText, /^NO_PROXY=$/m);
  assert.match(envText, /^CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1$/m);
  const digestFile = join(stateDir, "credentials", `${runToken}.sha256`);
  assert.equal(readFileSync(digestFile, "utf8").trim(), egressProxyRunTokenDigest(token));
  assert.equal(statSync(digestFile).mode & 0o777, 0o644);
  assert.ok(!readFileSync(digestFile, "utf8").includes(token));
  await creds.cleanup();
  assert.equal(existsSync(creds.envFile), false);
  assert.equal(existsSync(digestFile), false);
});

test("buildRunArgs passes proxy settings by env file, never argv", () => {
  const config = egressConfig();
  const args = buildRunArgs(config, { id: "t1", intent: "verify", commands: ["true"] }, "/tmp/work", "run-1", "/srv/egress/run-env/run-1.env");
  const netIdx = args.indexOf("--network");
  assert.equal(args[netIdx + 1], "a2a-egress-internal");
  const envFileIdx = args.indexOf("--env-file");
  assert.equal(args[envFileIdx + 1], "/srv/egress/run-env/run-1.env");
  assert.ok(envFileIdx < args.indexOf(config.image));
  assert.ok(!args.some((arg) => /PROXY/i.test(arg) && arg !== "/srv/egress/run-env/run-1.env"));
  assert.ok(!buildRunArgs(config, { id: "t1", intent: "verify", commands: ["true"] }, "/tmp/work", "run-1").includes("--env-file"));
});

test("task.env cannot inject proxy variables", () => {
  const args = buildRunArgs(
    egressConfig(),
    { id: "t1", intent: "verify", commands: ["true"], env: { HTTPS_PROXY: "http://evil:1", https_proxy: "http://evil:1", NO_PROXY: "*" } },
    "/tmp/work",
    "run-1",
    "/srv/egress/run-env/run-1.env",
  );
  assert.ok(!args.some((arg) => arg.includes("evil") || arg === "NO_PROXY=*"));
});

test("checkEgressProxyReady names each failure and accepts a ready proxy", async () => {
  const config = egressConfig();
  const cases: Array<[Parameters<typeof fakeExec>[0], string | undefined]> = [
    [{}, "network_missing"],
    [{ network: ok(networkJson(false)) }, "network_not_internal"],
    [{ network: ok(networkJson(true)) }, "proxy_missing"],
    [{ network: ok(networkJson(true)), container: ok(proxyJson({ label: false })) }, "proxy_not_labelled"],
    [{ network: ok(networkJson(true)), container: ok(proxyJson({ running: false })) }, "proxy_not_running"],
    [{ network: ok(networkJson(true)), container: ok(proxyJson({ restarting: true })) }, "proxy_not_running"],
    [{ network: ok(networkJson(true)), container: ok(proxyJson({ health: "starting" })) }, "proxy_unhealthy"],
    [{ network: ok(networkJson(true)), container: ok(proxyJson({ health: "unhealthy" })) }, "proxy_unhealthy"],
    [{ network: ok(networkJson(true)), container: ok(proxyJson({ health: null })) }, "proxy_unhealthy"],
    [{ network: ok(networkJson(true)), container: ok(proxyJson({ networks: ["bridge"] })) }, "proxy_not_on_network"],
    [{ network: ok(networkJson(true)), container: ok(proxyJson({ mode: "enforce" })) }, "proxy_mode_mismatch"],
    [{ network: ok(networkJson(true)), container: ok(proxyJson()) }, undefined],
    [{ network: ok(networkJson(true, "internal")), container: ok(proxyJson()) }, undefined],
  ];
  for (const [handlers, reason] of cases) {
    const readiness = await checkEgressProxyReady(config, fakeExec(handlers).exec);
    assert.equal(readiness.ready, reason === undefined, reason ?? "ready");
    assert.equal(readiness.reason, reason);
  }
  const check = await checkEgressProxy(config, fakeExec({ network: ok(networkJson(true)) }).exec);
  assert.equal(check.status, "fail");
  assert.match(check.message, /install --egress/);
});

test("doctor hardening reports proxy mode instead of unrestricted egress", () => {
  const observe = checkContainerHardening(egressConfig());
  const observeDetail = observe.detail as { egress: { mode: string; proxyWired: boolean }; relaxations: string[] };
  assert.equal(observeDetail.egress.mode, "proxy-observe");
  assert.equal(observeDetail.egress.proxyWired, true);
  assert.ok(observeDetail.relaxations.includes("egress_observe_allows_public_hosts"));
  assert.ok(!observeDetail.relaxations.includes("unrestricted_egress"));

  const enforce = checkContainerHardening(egressConfig({ egressMode: "enforce", egressProxyAllowlist: ["api.github.com"] }));
  const enforceDetail = enforce.detail as { egress: { mode: string; allowlistConfigured: boolean }; relaxations: string[] };
  assert.equal(enforceDetail.egress.mode, "proxy-enforce");
  assert.equal(enforceDetail.egress.allowlistConfigured, true);
  assert.deepEqual(enforceDetail.relaxations, []);

  const off = checkContainerHardening(egressConfig({ egressMode: undefined, network: "bridge" }));
  assert.ok((off.detail as { relaxations: string[] }).relaxations.includes("unrestricted_egress"));
});

test("proxy container is hardened, labelled, and mounts only what it needs", () => {
  const config = egressConfig({ egressMode: "enforce", egressProxyAllowlist: ["api.github.com"], egressStateDir: "/srv/egress" });
  const args = buildEgressProxyRunArgs(config);
  const joined = args.join(" ");
  for (const flag of ["--read-only", "--cap-drop ALL", "--security-opt no-new-privileges", "--user 1000:1000", "--restart unless-stopped", "--network bridge", `--label ${EGRESS_PROXY_LABEL_KEY}=1`]) {
    assert.ok(joined.includes(flag), flag);
  }
  assert.ok(args.includes("/srv/egress/proxy:/opt/a2a-egress:ro"), "only the staged bundle, never the root-only runner dir");
  assert.ok(args.includes("--health-cmd"));
  assert.match(args[args.indexOf("--health-cmd") + 1]!, /127\.0\.0\.1:3128\/healthz/);
  assert.ok(args.includes("/srv/egress/credentials:/run/a2a-egress/credentials:ro"));
  assert.ok(args.includes("/srv/egress/logs:/var/log/a2a-egress:rw"));
  assert.ok(!joined.includes("/srv/egress/run-env"), "the proxy never sees plaintext run tokens");
  assert.ok(args.includes("A2A_EGRESS_PROXY_MODE=enforce"));
  assert.ok(args.includes("A2A_EGRESS_PROXY_ALLOWLIST=api.github.com"));
  assert.deepEqual(args.slice(-2), ["a2a-runner:test", "/opt/a2a-egress/dist/egress-proxy-main.js"]);
  assert.equal(buildEgressProxyRunArgs(egressConfig({ user: undefined })).includes("1000:1000"), true);
});

test("install --egress creates the network, replaces only a labelled proxy, attaches it, and checks readiness", async () => {
  const stateDir = trackTempDir(mkdtempSync(join(tmpdir(), "egress-install-")));
  const config = egressConfig({ egressStateDir: stateDir });
  const chowned: string[] = [];
  const chownLogs = async (path: string, uid: number, gid: number) => {
    chowned.push(`${path}:${uid}:${gid}`);
  };

  // Fresh host: network and container missing; after creation both inspect OK.
  let created = false;
  let started = false;
  const fresh = fakeExec({
    other: (args) => {
      if (args[0] === "network" && args[1] === "create") created = true;
      if (args[0] === "run") started = true;
      return ok();
    },
  });
  const freshExec: EgressExec = async (engine, args) => {
    if (args[0] === "network" && args[1] === "inspect" && created) return ok(networkJson(true));
    if (args[0] === "container" && args[1] === "inspect" && started) return ok(proxyJson());
    return fresh.exec(engine, args);
  };
  const report = await installEgressProxy(config, { exec: freshExec, chownLogs, sourceDistDir: DIST_DIR });
  assert.equal(report.ok, true, JSON.stringify(report.steps));
  assert.deepEqual(report.steps.map((s) => s.step), ["state-dirs", "network", "proxy-run", "proxy-attach", "readiness"]);
  const createCall = fresh.calls.find((c) => c[0] === "network" && c[1] === "create");
  assert.ok(createCall?.includes("--internal"));
  assert.ok(fresh.calls.some((c) => c.join(" ") === "network connect --alias a2a-egress-proxy a2a-egress-internal a2a-egress-proxy"));
  assert.deepEqual(chowned, [`${join(stateDir, "logs")}:1000:1000`]);
  assert.equal(statSync(join(stateDir, "credentials")).mode & 0o777, 0o755);
  assert.equal(statSync(join(stateDir, "run-env")).mode & 0o777, 0o700);

  // Existing labelled proxy: removed and recreated.
  const relabel = fakeExec({ network: ok(networkJson(true)), container: ok(proxyJson()) });
  const replaced = await installEgressProxy(config, { exec: relabel.exec, chownLogs, sourceDistDir: DIST_DIR });
  assert.equal(replaced.ok, true);
  assert.ok(relabel.calls.some((c) => c.join(" ") === "rm --force a2a-egress-proxy"));

  // Foreign container with the same name: refused, nothing removed.
  const foreign = fakeExec({ network: ok(networkJson(true)), container: ok(proxyJson({ label: false })) });
  const refused = await installEgressProxy(config, { exec: foreign.exec, chownLogs, sourceDistDir: DIST_DIR });
  assert.equal(refused.ok, false);
  assert.ok(!foreign.calls.some((c) => c[0] === "rm" || c[0] === "run"));

  // Non-internal network with the managed name: refused.
  const openNet = fakeExec({ network: ok(networkJson(false)) });
  assert.equal((await installEgressProxy(config, { exec: openNet.exec, chownLogs, sourceDistDir: DIST_DIR })).ok, false);

  // Mode off: refused before touching anything.
  const off = fakeExec({});
  assert.equal((await installEgressProxy(egressConfig({ egressMode: "off" }), { exec: off.exec })).ok, false);
  assert.equal(off.calls.length, 0);

  // Dry run: plans only.
  const dry = fakeExec({});
  const plan = await installEgressProxy(config, { exec: dry.exec, dryRun: true });
  assert.equal(plan.ok, true);
  assert.equal(dry.calls.length, 0);
});

test("runTask refuses to start when the proxy is not ready, before creating any workDir", async () => {
  const fixtureDir = trackTempDir(mkdtempSync(join(tmpdir(), "egress-runtask-notready-")));
  const enginePath = join(fixtureDir, "docker");
  writeFileSync(enginePath, "#!/usr/bin/env bash\necho 'Error: No such network' >&2\nexit 1\n");
  chmodSync(enginePath, 0o700);
  const rootDir = join(fixtureDir, "runs");
  const originalPath = process.env.PATH;
  process.env.PATH = `${fixtureDir}:${originalPath ?? ""}`;
  try {
    await assert.rejects(
      runTask(egressConfig({ rootDir, egressStateDir: join(fixtureDir, "egress"), user: undefined }), { id: "egress-notready", intent: "verify", commands: ["true"] }),
      /egress proxy not ready \(network_missing\)/,
    );
    assert.equal(existsSync(rootDir), false);
    assert.equal(existsSync(join(fixtureDir, "egress")), false);
  } finally {
    process.env.PATH = originalPath;
  }
});

test("runTask with a ready proxy runs the container on the internal network with a live env file, then removes the credentials", async () => {
  const fixtureDir = trackTempDir(mkdtempSync(join(tmpdir(), "egress-runtask-ready-")));
  const capture = join(fixtureDir, "capture");
  const stateDir = join(fixtureDir, "egress");
  const enginePath = join(fixtureDir, "docker");
  writeFileSync(
    enginePath,
    `#!/usr/bin/env bash
if [ "$1" = network ] && [ "$2" = inspect ]; then echo '${networkJson(true)}'; exit 0; fi
if [ "$1" = container ] && [ "$2" = inspect ]; then echo '${proxyJson()}'; exit 0; fi
if [ "$1" = run ]; then
  printf '%s\\n' "$@" > "${capture}.args"
  prev=""
  for a in "$@"; do
    if [ "$prev" = --env-file ]; then cp "$a" "${capture}.env"; fi
    prev="$a"
  done
  ls "${stateDir}/credentials" > "${capture}.creds"
  exit 0
fi
exit 0
`,
  );
  chmodSync(enginePath, 0o700);
  const originalPath = process.env.PATH;
  process.env.PATH = `${fixtureDir}:${originalPath ?? ""}`;
  try {
    await runTask(
      egressConfig({ rootDir: join(fixtureDir, "runs"), egressStateDir: stateDir, user: undefined, defaultTimeoutMs: 10_000 }),
      { id: "egress-ready", intent: "verify", commands: ["true"] },
    );
  } finally {
    process.env.PATH = originalPath;
  }
  const args = readFileSync(`${capture}.args`, "utf8").split("\n");
  assert.equal(args[args.indexOf("--network") + 1], "a2a-egress-internal");
  assert.ok(args.includes("--env-file"));
  assert.ok(!args.some((arg) => /PROXY=/.test(arg)), "proxy URL must not appear in argv");
  const envText = readFileSync(`${capture}.env`, "utf8");
  assert.match(envText, /^HTTPS_PROXY=http:\/\/[^:]+:[A-Za-z0-9_-]{32,}@a2a-egress-proxy:3128$/m);
  assert.match(readFileSync(`${capture}.creds`, "utf8"), /\.sha256$/m);
  assert.deepEqual(readdirNames(join(stateDir, "credentials")), []);
  assert.deepEqual(readdirNames(join(stateDir, "run-env")), []);
});

function readdirNames(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

test("the proxy bundle is dependency-closed and staged world-readable", async () => {
  // Every relative import in the bundled files must itself be bundled, or the
  // proxy container dies with ERR_MODULE_NOT_FOUND (it never sees the runner dir).
  const bundled = new Set<string>(EGRESS_PROXY_BUNDLE_FILES);
  for (const name of EGRESS_PROXY_BUNDLE_FILES) {
    const source = readFileSync(join(DIST_DIR, name), "utf8");
    for (const match of source.matchAll(/(?:import|export)[^"']*?from\s*["'](\.[^"']+)["']/g)) {
      const target = match[1]!.replace(/^\.\//, "");
      assert.ok(bundled.has(target), `${name} imports ${match[1]} which is not in EGRESS_PROXY_BUNDLE_FILES`);
    }
  }
  const stateDir = trackTempDir(mkdtempSync(join(tmpdir(), "egress-bundle-")));
  const paths = egressStatePaths({ rootDir: "/unused", egressStateDir: stateDir });
  await stageEgressProxyBundle(paths, DIST_DIR);
  assert.equal(statSync(paths.bundle).mode & 0o777, 0o755);
  assert.equal(statSync(join(paths.bundle, "dist")).mode & 0o777, 0o755);
  assert.deepEqual(JSON.parse(readFileSync(join(paths.bundle, "package.json"), "utf8")).type, "module");
  for (const name of EGRESS_PROXY_BUNDLE_FILES) {
    assert.equal(statSync(join(paths.bundle, "dist", name)).mode & 0o777, 0o644, name);
  }
  assert.deepEqual(readdirSync(join(paths.bundle, "dist")).sort(), [...EGRESS_PROXY_BUNDLE_FILES].sort());
});

test("install waits for the healthcheck and fails when the proxy never becomes healthy", async () => {
  const stateDir = trackTempDir(mkdtempSync(join(tmpdir(), "egress-install-health-")));
  const config = egressConfig({ egressStateDir: stateDir });
  let polls = 0;
  const becomesHealthy = fakeExec({ network: ok(networkJson(true)) });
  const exec: EgressExec = async (engine, args) => {
    if (args[0] === "container" && args[1] === "inspect") {
      polls += 1;
      // first inspect is the pre-replace probe (missing), then starting → healthy
      if (polls === 1) return missing;
      return ok(proxyJson({ health: polls >= 4 ? "healthy" : "starting" }));
    }
    return becomesHealthy.exec(engine, args);
  };
  const report = await installEgressProxy(config, { exec, chownLogs: async () => {}, sourceDistDir: DIST_DIR, sleep: async () => {}, readyTimeoutMs: 60_000 });
  assert.equal(report.ok, true, JSON.stringify(report.steps));
  assert.ok(polls >= 4);

  const never = fakeExec({ network: ok(networkJson(true)), container: ok(proxyJson({ restarting: true })) });
  const failed = await installEgressProxy(config, { exec: never.exec, chownLogs: async () => {}, sourceDistDir: DIST_DIR, sleep: async () => {}, readyTimeoutMs: 0 });
  assert.equal(failed.ok, false);
  assert.equal(failed.readiness?.reason, "proxy_not_running");
});
