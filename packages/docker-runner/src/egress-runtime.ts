/**
 * #2395 stage 2b: runner-side wiring for the allowlist egress proxy
 * (`egress-proxy.ts`, design `docs/egress-proxy-design.md` option A).
 *
 * With `A2A_DOCKER_RUNNER_EGRESS_MODE=observe|enforce` the runner:
 * 1. refuses to start a task unless the managed `--internal` network exists and
 *    the labelled proxy container is running on it in the same mode
 *    (`checkEgressProxyReady`, before any workDir or model call);
 * 2. mints a random per-run proxy token, writes its SHA-256 digest where the
 *    proxy reads it and the proxy URL into a 0600 `--env-file` (never argv,
 *    which `ps` shows), and removes both when the run ends
 *    (`prepareEgressRunCredentials`);
 * 3. starts the task container on the internal network only, so a tool that
 *    ignores the proxy env has no route at all (fail-closed).
 *
 * `installEgressProxy` (`a2a-docker-runner install --egress`) creates the
 * network and (re)creates the proxy container. Mode `off` (default) touches
 * none of this.
 */
import { execFile } from "node:child_process";
import { chmod, chown, copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { egressProxyRunTokenDigest, generateEgressProxyRunToken, normalizeEgressProxyAllowlist } from "./egress-proxy.js";
import type { RunnerConfig, RunnerEngine } from "./types.js";

export type EgressMode = "off" | "observe" | "enforce";
export const EGRESS_MODES: readonly EgressMode[] = ["off", "observe", "enforce"];
export const DEFAULT_EGRESS_NETWORK = "a2a-egress-internal";
export const DEFAULT_EGRESS_PROXY_NAME = "a2a-egress-proxy";
export const EGRESS_PROXY_LISTEN_PORT = 3128;
export const EGRESS_PROXY_LABEL_KEY = "a2a.egress.proxy";
/** The staged proxy bundle (package.json + dist/) is mounted here so Node resolves `"type": "module"`. */
export const EGRESS_PROXY_CONTAINER_PACKAGE_DIR = "/opt/a2a-egress";
/**
 * Files the proxy container runs. Kept dependency-closed (a test pins it): the
 * runner install dir is root-only (0700/0600), so install copies just these
 * into a world-readable bundle instead of mounting the runner package.
 */
export const EGRESS_PROXY_BUNDLE_FILES = ["egress-guards.js", "egress-proxy.js", "egress-proxy-main.js"] as const;
export const EGRESS_PROXY_CONTAINER_CREDENTIALS_DIR = "/run/a2a-egress/credentials";
export const EGRESS_PROXY_CONTAINER_LOG_DIR = "/var/log/a2a-egress";
const DEFAULT_PROXY_USER = "1000:1000";
const DOCKER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;

export function parseEgressMode(raw: string | undefined): EgressMode {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") return "off";
  if ((EGRESS_MODES as readonly string[]).includes(value)) return value as EgressMode;
  throw new Error(`A2A_DOCKER_RUNNER_EGRESS_MODE must be one of off, observe, enforce (got ${JSON.stringify(raw)})`);
}

export function isValidEgressResourceName(name: string): boolean {
  return DOCKER_NAME.test(name);
}

export function egressEnabled(config: Pick<RunnerConfig, "egressMode">): boolean {
  return config.egressMode === "observe" || config.egressMode === "enforce";
}

/**
 * Egress state lives NEXT TO the task root, never inside it: `cleanup` treats
 * every directory under the task root as a task root and would expire
 * `credentials/` or `logs/` by mtime.
 */
export function defaultEgressStateDir(rootDir: string): string {
  const root = resolve(rootDir);
  return join(dirname(root), `${basename(root)}-egress`);
}

export interface EgressStatePaths {
  base: string;
  credentials: string;
  runEnv: string;
  logs: string;
  /** Staged proxy bundle mounted read-only into the proxy container. */
  bundle: string;
}

export function egressStatePaths(config: Pick<RunnerConfig, "rootDir" | "egressStateDir">): EgressStatePaths {
  const base = resolve(config.egressStateDir ?? defaultEgressStateDir(config.rootDir));
  return { base, credentials: join(base, "credentials"), runEnv: join(base, "run-env"), logs: join(base, "logs"), bundle: join(base, "proxy") };
}

function proxyName(config: Pick<RunnerConfig, "egressProxyName">): string {
  return config.egressProxyName ?? DEFAULT_EGRESS_PROXY_NAME;
}

function networkName(config: Pick<RunnerConfig, "egressNetwork">): string {
  return config.egressNetwork ?? DEFAULT_EGRESS_NETWORK;
}

/** Env lines handed to the task container through `--env-file` (runner-owned; tasks cannot set them). */
export function buildEgressContainerEnvLines(config: Pick<RunnerConfig, "egressProxyName">, runToken: string, token: string): string[] {
  const url = `http://${runToken}:${token}@${proxyName(config)}:${EGRESS_PROXY_LISTEN_PORT}`;
  return [
    `HTTPS_PROXY=${url}`,
    `HTTP_PROXY=${url}`,
    `https_proxy=${url}`,
    `http_proxy=${url}`,
    "NO_PROXY=",
    "no_proxy=",
    // Background telemetry/update traffic widens any allowlist for no task benefit.
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
    "DISABLE_AUTOUPDATER=1",
  ];
}

/**
 * Create the state dirs with explicit modes (umask-independent): credentials/
 * must be traversable by the non-root proxy, run-env/ and logs/ must not be
 * readable by anyone else.
 */
export async function ensureEgressStateDirs(paths: EgressStatePaths): Promise<void> {
  await mkdir(paths.base, { recursive: true, mode: 0o755 });
  await chmod(paths.base, 0o755);
  for (const [dir, mode] of [[paths.credentials, 0o755], [paths.runEnv, 0o700], [paths.logs, 0o700]] as const) {
    await mkdir(dir, { recursive: true, mode });
    await chmod(dir, mode);
  }
}

export interface EgressRunCredentials {
  envFile: string;
  cleanup(): Promise<void>;
}

export async function prepareEgressRunCredentials(
  config: Pick<RunnerConfig, "rootDir" | "egressStateDir" | "egressProxyName">,
  runToken: string,
): Promise<EgressRunCredentials> {
  const paths = egressStatePaths(config);
  // credentials/: digests only (a SHA-256 of 32 random bytes reveals nothing),
  // readable by the non-root proxy container user. run-env/: the token itself.
  await ensureEgressStateDirs(paths);
  const token = generateEgressProxyRunToken();
  const digestFile = join(paths.credentials, `${runToken}.sha256`);
  const envFile = join(paths.runEnv, `${runToken}.env`);
  await writeFile(envFile, `${buildEgressContainerEnvLines(config, runToken, token).join("\n")}\n`, { mode: 0o600 });
  await writeFile(digestFile, `${egressProxyRunTokenDigest(token)}\n`, { mode: 0o644 });
  // Explicit chmod: a restrictive process umask (e.g. 077) would otherwise make
  // the digest unreadable to the non-root proxy and fail every run's auth.
  await chmod(digestFile, 0o644);
  await chmod(envFile, 0o600);
  return {
    envFile,
    cleanup: async () => {
      await rm(digestFile, { force: true });
      await rm(envFile, { force: true });
    },
  };
}

export interface EgressExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type EgressExec = (engine: RunnerEngine, args: string[]) => Promise<EgressExecResult>;

export const defaultEgressExec: EgressExec = (engine, args) =>
  new Promise((resolvePromise) => {
    execFile(engine, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      // A non-zero exit carries the numeric exit code; spawn failures (ENOENT) carry a string.
      const raw = (error as { code?: unknown } | null)?.code;
      const code = !error ? 0 : typeof raw === "number" ? raw : 1;
      resolvePromise({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });

export type EgressNotReadyReason =
  | "network_missing"
  | "network_not_internal"
  | "proxy_missing"
  | "proxy_not_labelled"
  | "proxy_not_running"
  | "proxy_unhealthy"
  | "proxy_not_on_network"
  | "proxy_mode_mismatch";

export interface EgressReadiness {
  ready: boolean;
  reason?: EgressNotReadyReason;
  detail: {
    mode: EgressMode;
    network: string;
    proxy: string;
    networkInternal?: boolean;
    proxyRunning?: boolean;
    proxyHealth?: string;
    proxyNetworks?: string[];
    proxyMode?: string;
  };
}

function firstInspectObject(stdout: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    return first && typeof first === "object" ? (first as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function field(obj: Record<string, unknown> | undefined, ...keys: string[]): unknown {
  if (!obj) return undefined;
  for (const key of keys) if (key in obj) return obj[key];
  return undefined;
}

/**
 * Inspect the managed network and proxy container. Reads only structure and
 * the proxy's non-secret config env (mode, allowlist); no task data.
 */
export async function checkEgressProxyReady(config: RunnerConfig, exec: EgressExec = defaultEgressExec): Promise<EgressReadiness> {
  const engine = config.engine ?? "docker";
  const mode = config.egressMode ?? "off";
  const network = networkName(config);
  const proxy = proxyName(config);
  const detail: EgressReadiness["detail"] = { mode, network, proxy };

  const net = await exec(engine, ["network", "inspect", network]);
  const netObj = net.code === 0 ? firstInspectObject(net.stdout) : undefined;
  if (!netObj) return { ready: false, reason: "network_missing", detail };
  // docker: "Internal"; podman: "internal".
  detail.networkInternal = field(netObj, "Internal", "internal") === true;
  if (!detail.networkInternal) return { ready: false, reason: "network_not_internal", detail };

  const ctr = await exec(engine, ["container", "inspect", proxy]);
  const ctrObj = ctr.code === 0 ? firstInspectObject(ctr.stdout) : undefined;
  if (!ctrObj) return { ready: false, reason: "proxy_missing", detail };
  const ctrConfig = field(ctrObj, "Config") as Record<string, unknown> | undefined;
  const labels = (field(ctrConfig, "Labels") ?? {}) as Record<string, unknown>;
  if (labels[EGRESS_PROXY_LABEL_KEY] !== "1") return { ready: false, reason: "proxy_not_labelled", detail };
  const state = field(ctrObj, "State") as Record<string, unknown> | undefined;
  // A crash-looping container under --restart reports Running=true between
  // restarts, so Restarting and the healthcheck decide, not Running alone.
  detail.proxyRunning = field(state, "Running") === true && field(state, "Restarting") !== true;
  if (!detail.proxyRunning) return { ready: false, reason: "proxy_not_running", detail };
  const health = field(state, "Health", "Healthcheck") as Record<string, unknown> | undefined;
  const healthStatus = field(health, "Status");
  detail.proxyHealth = typeof healthStatus === "string" ? healthStatus : "none";
  if (detail.proxyHealth !== "healthy") return { ready: false, reason: "proxy_unhealthy", detail };
  const settings = field(ctrObj, "NetworkSettings") as Record<string, unknown> | undefined;
  detail.proxyNetworks = Object.keys((field(settings, "Networks") ?? {}) as Record<string, unknown>).sort();
  if (!detail.proxyNetworks.includes(network)) return { ready: false, reason: "proxy_not_on_network", detail };
  const env = (field(ctrConfig, "Env") ?? []) as unknown[];
  const modeLine = env.find((line): line is string => typeof line === "string" && line.startsWith("A2A_EGRESS_PROXY_MODE="));
  detail.proxyMode = modeLine?.slice("A2A_EGRESS_PROXY_MODE=".length);
  if (detail.proxyMode !== mode) return { ready: false, reason: "proxy_mode_mismatch", detail };
  return { ready: true, detail };
}

export function egressNotReadyMessage(readiness: EgressReadiness): string {
  const { reason, detail } = readiness;
  return (
    `egress proxy not ready (${reason ?? "unknown"}): mode=${detail.mode} network=${detail.network} proxy=${detail.proxy}` +
    (detail.proxyMode !== undefined ? ` proxyMode=${detail.proxyMode}` : "") +
    "; run `a2a-docker-runner install --egress` or set A2A_DOCKER_RUNNER_EGRESS_MODE=off"
  );
}

/** Proxy container user: the task user when non-root, else 1000:1000. */
export function egressProxyUser(config: Pick<RunnerConfig, "user">): string {
  const user = config.user?.trim();
  if (user && !/^(0+|root)(:.*)?$/i.test(user)) return user;
  return DEFAULT_PROXY_USER;
}

/** Directory holding this package's compiled proxy files. */
export function defaultEgressDistDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/** Copy the proxy files into `<state>/proxy` (0755 dirs, 0644 files) with an ESM package.json. */
export async function stageEgressProxyBundle(paths: EgressStatePaths, sourceDistDir: string = defaultEgressDistDir()): Promise<void> {
  const dist = join(paths.bundle, "dist");
  for (const dir of [paths.bundle, dist]) {
    await mkdir(dir, { recursive: true, mode: 0o755 });
    await chmod(dir, 0o755);
  }
  for (const name of EGRESS_PROXY_BUNDLE_FILES) {
    const target = join(dist, name);
    await copyFile(join(sourceDistDir, name), target);
    await chmod(target, 0o644);
  }
  const pkg = join(paths.bundle, "package.json");
  await writeFile(pkg, `${JSON.stringify({ name: "a2a-egress-proxy-bundle", private: true, type: "module" })}\n`);
  await chmod(pkg, 0o644);
}

const EGRESS_PROXY_HEALTH_CMD =
  `node -e "fetch('http://127.0.0.1:${EGRESS_PROXY_LISTEN_PORT}/healthz').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"`;

export function buildEgressProxyRunArgs(config: RunnerConfig): string[] {
  const paths = egressStatePaths(config);
  const allowlist = normalizeEgressProxyAllowlist(config.egressProxyAllowlist ?? []);
  return [
    "run",
    "--detach",
    "--name",
    proxyName(config),
    "--label",
    `${EGRESS_PROXY_LABEL_KEY}=1`,
    "--restart",
    "unless-stopped",
    // Outbound leg: the default bridge. The internal leg is attached afterwards
    // with `network connect --alias`, so the default route stays on the bridge.
    "--network",
    "bridge",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    egressProxyUser(config),
    "--memory",
    "256m",
    "--pids-limit",
    "256",
    "--health-cmd",
    EGRESS_PROXY_HEALTH_CMD,
    "--health-interval",
    "10s",
    "--health-timeout",
    "5s",
    "--health-retries",
    "3",
    "--health-start-period",
    "5s",
    "-v",
    `${paths.bundle}:${EGRESS_PROXY_CONTAINER_PACKAGE_DIR}:ro`,
    "-v",
    `${paths.credentials}:${EGRESS_PROXY_CONTAINER_CREDENTIALS_DIR}:ro`,
    "-v",
    `${paths.logs}:${EGRESS_PROXY_CONTAINER_LOG_DIR}:rw`,
    "-e",
    `A2A_EGRESS_PROXY_MODE=${config.egressMode}`,
    "-e",
    `A2A_EGRESS_PROXY_LISTEN=0.0.0.0:${EGRESS_PROXY_LISTEN_PORT}`,
    "-e",
    `A2A_EGRESS_PROXY_ALLOWLIST=${allowlist.join(",")}`,
    "-e",
    `A2A_EGRESS_PROXY_CREDENTIALS_DIR=${EGRESS_PROXY_CONTAINER_CREDENTIALS_DIR}`,
    "-e",
    `A2A_EGRESS_PROXY_LOG_DIR=${EGRESS_PROXY_CONTAINER_LOG_DIR}`,
    "--entrypoint",
    "node",
    config.image,
    `${EGRESS_PROXY_CONTAINER_PACKAGE_DIR}/dist/egress-proxy-main.js`,
  ];
}

export interface EgressInstallStep {
  step: string;
  ok: boolean;
  detail?: string;
}

export interface EgressInstallReport {
  ok: boolean;
  dryRun: boolean;
  steps: EgressInstallStep[];
  readiness?: EgressReadiness;
}

export interface EgressInstallOptions {
  /** Where the compiled proxy files are copied from (default: this installed package's dist). */
  sourceDistDir?: string;
  /** How long to wait for the proxy healthcheck to pass (default 45 s). */
  readyTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  exec?: EgressExec;
  dryRun?: boolean;
  /** chown for the proxy log directory; injectable for tests. */
  chownLogs?: (path: string, uid: number, gid: number) => Promise<void>;
}

function parseUidGid(user: string): { uid: number; gid: number } | undefined {
  const match = /^(\d+)(?::(\d+))?$/.exec(user.trim());
  if (!match) return undefined;
  const uid = Number(match[1]);
  return { uid, gid: match[2] !== undefined ? Number(match[2]) : uid };
}

/**
 * Idempotent: creates the internal network if missing, replaces only a
 * container carrying the proxy label (a same-named foreign container is
 * refused), starts the proxy, attaches it to the internal network under its
 * alias, and verifies readiness. Recreating the proxy drops open tunnels, so
 * run it when no patch task is in flight.
 */
export async function installEgressProxy(config: RunnerConfig, options: EgressInstallOptions = {}): Promise<EgressInstallReport> {
  const exec = options.exec ?? defaultEgressExec;
  const dryRun = options.dryRun ?? false;
  const engine = config.engine ?? "docker";
  const steps: EgressInstallStep[] = [];
  const done = (ok: boolean, readiness?: EgressReadiness): EgressInstallReport => ({ ok, dryRun, steps, ...(readiness ? { readiness } : {}) });

  if (!egressEnabled(config)) {
    steps.push({ step: "mode", ok: false, detail: "A2A_DOCKER_RUNNER_EGRESS_MODE must be observe or enforce for install --egress" });
    return done(false);
  }
  const network = networkName(config);
  const proxy = proxyName(config);
  const paths = egressStatePaths(config);
  const runArgs = buildEgressProxyRunArgs(config);

  if (dryRun) {
    steps.push({ step: "state-dirs", ok: true, detail: `${paths.credentials} ${paths.logs} ${paths.runEnv} ${paths.bundle}` });
    steps.push({ step: "network", ok: true, detail: `${engine} network create --internal ${network} (if missing)` });
    steps.push({ step: "proxy-run", ok: true, detail: `${engine} ${runArgs.join(" ")}` });
    steps.push({ step: "proxy-attach", ok: true, detail: `${engine} network connect --alias ${proxy} ${network} ${proxy}` });
    return done(true);
  }

  await ensureEgressStateDirs(paths);
  const owner = parseUidGid(egressProxyUser(config));
  if (owner) {
    await (options.chownLogs ?? chown)(paths.logs, owner.uid, owner.gid);
  }
  await stageEgressProxyBundle(paths, options.sourceDistDir);
  steps.push({ step: "state-dirs", ok: true, detail: paths.base });

  const netInspect = await exec(engine, ["network", "inspect", network]);
  const netObj = netInspect.code === 0 ? firstInspectObject(netInspect.stdout) : undefined;
  if (!netObj) {
    const created = await exec(engine, ["network", "create", "--internal", "--label", `${EGRESS_PROXY_LABEL_KEY}=1`, network]);
    steps.push({ step: "network", ok: created.code === 0, detail: created.code === 0 ? `created ${network}` : created.stderr.trim().slice(0, 300) });
    if (created.code !== 0) return done(false);
  } else if (field(netObj, "Internal", "internal") !== true) {
    steps.push({ step: "network", ok: false, detail: `${network} exists but is not --internal; remove it or choose A2A_DOCKER_RUNNER_EGRESS_NETWORK` });
    return done(false);
  } else {
    steps.push({ step: "network", ok: true, detail: `${network} exists (internal)` });
  }

  const ctrInspect = await exec(engine, ["container", "inspect", proxy]);
  const ctrObj = ctrInspect.code === 0 ? firstInspectObject(ctrInspect.stdout) : undefined;
  if (ctrObj) {
    const labels = (field(field(ctrObj, "Config") as Record<string, unknown> | undefined, "Labels") ?? {}) as Record<string, unknown>;
    if (labels[EGRESS_PROXY_LABEL_KEY] !== "1") {
      steps.push({ step: "proxy-replace", ok: false, detail: `container ${proxy} exists without label ${EGRESS_PROXY_LABEL_KEY}=1; refusing to replace it` });
      return done(false);
    }
    const removed = await exec(engine, ["rm", "--force", proxy]);
    steps.push({ step: "proxy-replace", ok: removed.code === 0, detail: removed.code === 0 ? `removed previous ${proxy}` : removed.stderr.trim().slice(0, 300) });
    if (removed.code !== 0) return done(false);
  }

  const started = await exec(engine, runArgs);
  steps.push({ step: "proxy-run", ok: started.code === 0, detail: started.code === 0 ? `started ${proxy}` : started.stderr.trim().slice(0, 300) });
  if (started.code !== 0) return done(false);

  const attached = await exec(engine, ["network", "connect", "--alias", proxy, network, proxy]);
  steps.push({ step: "proxy-attach", ok: attached.code === 0, detail: attached.code === 0 ? `attached to ${network}` : attached.stderr.trim().slice(0, 300) });
  if (attached.code !== 0) return done(false);

  // The healthcheck needs a few intervals before Docker reports `healthy`.
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (options.readyTimeoutMs ?? 45_000);
  let readiness = await checkEgressProxyReady(config, exec);
  while (!readiness.ready && (readiness.reason === "proxy_unhealthy" || readiness.reason === "proxy_not_running") && Date.now() < deadline) {
    await sleep(1_000);
    readiness = await checkEgressProxyReady(config, exec);
  }
  steps.push({ step: "readiness", ok: readiness.ready, ...(readiness.reason ? { detail: readiness.reason } : {}) });
  return done(readiness.ready, readiness);
}
