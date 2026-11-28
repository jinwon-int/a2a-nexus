/**
 * Start-up configuration for the MCP Tasks server entry point (a2a-nexus #2591
 * design §4.2, step 3 preparation).
 *
 * Everything comes from the environment the MCP client passes to the stdio
 * subprocess — EXCEPT the edge secret. Design §4.2: the server reads the
 * secret from the node's existing env file at start-up and never takes it
 * from MCP config, arguments, or its own environment, so a registration
 * (`claude mcp add … -e …`) can never carry it. Only the file's location is
 * configured. The loader fails closed: a refused config throws
 * {@link McpTasksServerConfigError} and the entry point exits without
 * serving.
 */
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { BrokerIdentity } from "./broker-client.js";
import { McpTasksServerConfigError, assertServerIdentity } from "./server.js";

/** Environment variable names the entry point reads. None of them may hold a secret. */
export const CONFIG_ENV = Object.freeze({
  brokerUrl: "A2A_MCP_TASKS_BROKER_URL",
  envFile: "A2A_MCP_TASKS_ENV_FILE",
  requesterId: "A2A_MCP_TASKS_REQUESTER_ID",
  requesterKind: "A2A_MCP_TASKS_REQUESTER_KIND",
  requesterRole: "A2A_MCP_TASKS_REQUESTER_ROLE",
  allowedTargets: "A2A_MCP_TASKS_ALLOWED_TARGETS",
  stateDir: "A2A_MCP_TASKS_STATE_DIR",
  sessionId: "A2A_MCP_TASKS_SESSION_ID",
});

/** Keys looked up, in order, inside the env file. Same names the operator dispatch scripts use. */
export const EDGE_SECRET_FILE_KEYS = ["A2A_BROKER_EDGE_SECRET", "A2A_EDGE_SECRET"] as const;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const KINDS = new Set<BrokerIdentity["kind"]>(["session", "node", "user", "service"]);

export interface McpTasksServerConfig {
  brokerUrl: string;
  edgeSecret: string;
  identity: BrokerIdentity;
  allowedTargetNodeIds: string[];
  stateDir: string;
  sessionId: string;
  /** Where the secret came from (path + key name only), for the redacted summary. */
  edgeSecretSource: { file: string; key: string };
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new McpTasksServerConfigError(`${name} is not set`);
  return value;
}

/** https anywhere, or plain http only to a loopback host (the operator node's private tunnel). */
export function assertBrokerUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new McpTasksServerConfigError(`${CONFIG_ENV.brokerUrl} is not a valid URL`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new McpTasksServerConfigError(`${CONFIG_ENV.brokerUrl} must not carry credentials, query, or fragment`);
  }
  if (url.protocol === "https:") return url.toString();
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return url.toString();
  throw new McpTasksServerConfigError(`${CONFIG_ENV.brokerUrl} must be https, or http to a loopback host`);
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && (trimmed[0] === '"' || trimmed[0] === "'") && trimmed.at(-1) === trimmed[0]) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Reads the edge secret from a KEY=VALUE env file (`export ` prefix and quotes
 * allowed, `#` comments ignored). The file must be a regular file owned by
 * this user with no group/other permission bits — the same rule the node's
 * other credential files follow. Error messages name the file and key only.
 */
export function readEdgeSecret(file: string): { secret: string; key: string } {
  let meta;
  try {
    meta = lstatSync(file);
  } catch {
    throw new McpTasksServerConfigError(`env file ${file} is missing or unreadable`);
  }
  if (meta.isSymbolicLink() || !meta.isFile()) throw new McpTasksServerConfigError(`env file ${file} is not a regular file`);
  const uid = typeof process.geteuid === "function" ? process.geteuid() : undefined;
  if (uid !== undefined && meta.uid !== uid) throw new McpTasksServerConfigError(`env file ${file} is not owned by this user`);
  if ((meta.mode & 0o077) !== 0) throw new McpTasksServerConfigError(`env file ${file} is accessible by group or other`);
  const values = new Map<string, string>();
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match) values.set(match[1]!, unquote(match[2]!));
  }
  for (const key of EDGE_SECRET_FILE_KEYS) {
    const secret = values.get(key);
    if (secret) return { secret, key };
  }
  throw new McpTasksServerConfigError(`env file ${file} has none of ${EDGE_SECRET_FILE_KEYS.join(", ")}`);
}

export function defaultStateDir(env: Env): string {
  const base = env.XDG_STATE_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".local", "state");
  return join(base, "a2a-mcp-tasks");
}

/** Builds the full configuration or throws. Never returns a config whose identity the server would refuse. */
export function loadServerConfig(env: Env): McpTasksServerConfig {
  const brokerUrl = assertBrokerUrl(required(env, CONFIG_ENV.brokerUrl));
  const kindValue = env[CONFIG_ENV.requesterKind]?.trim() || "node";
  if (!KINDS.has(kindValue as BrokerIdentity["kind"])) {
    throw new McpTasksServerConfigError(`${CONFIG_ENV.requesterKind} must be one of ${[...KINDS].join(", ")}`);
  }
  const identity: BrokerIdentity = {
    id: required(env, CONFIG_ENV.requesterId),
    kind: kindValue as BrokerIdentity["kind"],
    role: required(env, CONFIG_ENV.requesterRole),
  };
  assertServerIdentity(identity);
  const allowedTargetNodeIds = required(env, CONFIG_ENV.allowedTargets)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (allowedTargetNodeIds.length === 0) throw new McpTasksServerConfigError(`${CONFIG_ENV.allowedTargets} is empty`);
  const envFile = required(env, CONFIG_ENV.envFile);
  const { secret, key } = readEdgeSecret(envFile);
  return {
    brokerUrl,
    edgeSecret: secret,
    identity,
    allowedTargetNodeIds,
    stateDir: env[CONFIG_ENV.stateDir]?.trim() || defaultStateDir(env),
    sessionId: env[CONFIG_ENV.sessionId]?.trim() || "default",
    edgeSecretSource: { file: envFile, key },
  };
}

/** Everything but the secret, for `--check-config` and start-up logs. */
export function redactedConfigSummary(config: McpTasksServerConfig): Record<string, unknown> {
  return {
    brokerUrl: config.brokerUrl,
    identity: config.identity,
    allowedTargetNodeIds: config.allowedTargetNodeIds,
    stateDir: config.stateDir,
    sessionId: config.sessionId,
    edgeSecret: { source: config.edgeSecretSource.file, key: config.edgeSecretSource.key, present: true },
  };
}
