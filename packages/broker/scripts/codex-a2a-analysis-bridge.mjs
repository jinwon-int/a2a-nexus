#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  chownSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const BRIDGE_CONTRACT_VERSION = "codex-a2a-analysis.v1";
const SELF_PATH = fileURLToPath(import.meta.url);
const CLAUDE_BRIDGE_PATH = join(dirname(SELF_PATH), "claude-a2a-analysis-bridge.mjs");
const TERMUX_CHILD_ENV_KEYS = [
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "PREFIX",
  "TERMUX_EXEC__PROC_SELF_EXE",
  "TERMUX_VERSION",
];
const MAX_AUTH_BYTES = 1024 * 1024;
const REFRESHABLE_TOKEN_FIELDS = new Set(["access_token", "id_token", "refresh_token"]);

function safeText(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function redactSecrets(value) {
  return safeText(value)
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, "[redacted-token]")
    .replace(/\b(Authorization\s*[:=]\s*Bearer\s+)[^\s"']+/gi, "$1[redacted]")
    .replace(/\b(BROKER_EDGE_SECRET|A2A_EDGE_SECRET|EDGE_SECRET|TOKEN|SECRET|API[_-]?KEY|PASSWORD)=\S+/gi, "$1=[redacted]")
    .slice(0, 4000);
}

function die(message) {
  process.stderr.write(`${redactSecrets(message || "Codex analysis bridge failed")}\n`);
  process.exit(1);
}

function parseOpenClawArgs(argv) {
  const flags = { subcommand: argv[2] };
  for (let index = 3; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    if (key === "json" || key === "local") {
      flags[key] = true;
      continue;
    }
    flags[key] = argv[index + 1];
    index += 1;
  }
  return flags;
}

function parseClaudeAdapterArgs(argv) {
  const promptIndex = argv.indexOf("-p");
  if (promptIndex < 0 || !safeText(argv[promptIndex + 1], "")) {
    throw new Error("Codex adapter expected Claude-shaped -p prompt");
  }
  return { prompt: argv[promptIndex + 1] };
}

function normalizedModel(value) {
  return safeText(value, "gpt-5.6-sol").replace(/^openai-codex\//, "") || "gpt-5.6-sol";
}

function normalizedReasoning(value) {
  const level = safeText(value, "high").toLowerCase();
  return ["minimal", "low", "medium", "high", "xhigh"].includes(level) ? level : "high";
}

function termuxChildEnv(env = process.env) {
  return Object.fromEntries(
    TERMUX_CHILD_ENV_KEYS
      .filter((key) => safeText(env[key], ""))
      .map((key) => [key, env[key]]),
  );
}

function extractCodexMessage(stdout) {
  let lastMessage = "";
  for (const line of safeText(stdout).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed);
      if (event?.type === "item.completed" && event?.item?.type === "agent_message") {
        lastMessage = safeText(event.item.text, lastMessage);
      } else if (event?.type === "agent_message") {
        lastMessage = safeText(event.text, lastMessage);
      } else if (event?.type === "result") {
        lastMessage = safeText(event.result, lastMessage);
      }
    } catch {
      // Codex --json should emit JSONL. Ignore bounded non-JSON diagnostics and
      // fail closed below if no final agent message was observed.
    }
  }
  if (!lastMessage.trim()) throw new Error("Codex JSONL contained no final agent message");
  return lastMessage.trim();
}

function authRecord(value, label) {
  if (!Buffer.isBuffer(value) || value.byteLength === 0 || value.byteLength > MAX_AUTH_BYTES) {
    throw new Error(`${label} must be between 1 byte and ${MAX_AUTH_BYTES} bytes`);
  }
  let parsed;
  try {
    parsed = JSON.parse(value.toString("utf8"));
  } catch {
    throw new Error(`${label} must contain valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return parsed;
}

function assertSameKeys(original, candidate, label) {
  if (!isDeepStrictEqual(Object.keys(original).sort(), Object.keys(candidate).sort())) {
    throw new Error(`${label} changed credential schema`);
  }
}

function validateCodexAuthRefreshCandidate(originalBytes, candidateBytes) {
  const original = authRecord(originalBytes, "source Codex auth.json");
  const candidate = authRecord(candidateBytes, "refreshed Codex auth.json");
  assertSameKeys(original, candidate, "refreshed Codex auth.json");

  for (const key of Object.keys(original)) {
    if (key === "last_refresh" || key === "tokens") continue;
    if (!isDeepStrictEqual(candidate[key], original[key])) {
      throw new Error(`refreshed Codex auth.json changed protected field ${key}`);
    }
  }

  if (original.tokens === undefined) return;
  if (
    !original.tokens ||
    typeof original.tokens !== "object" ||
    Array.isArray(original.tokens) ||
    !candidate.tokens ||
    typeof candidate.tokens !== "object" ||
    Array.isArray(candidate.tokens)
  ) {
    throw new Error("refreshed Codex auth.json changed tokens schema");
  }

  assertSameKeys(original.tokens, candidate.tokens, "refreshed Codex auth.json tokens");
  for (const key of Object.keys(original.tokens)) {
    if (REFRESHABLE_TOKEN_FIELDS.has(key)) {
      if (
        typeof original.tokens[key] === "string" &&
        original.tokens[key] &&
        (typeof candidate.tokens[key] !== "string" || !candidate.tokens[key])
      ) {
        throw new Error(`refreshed Codex auth.json emptied required token field ${key}`);
      }
      continue;
    }
    if (!isDeepStrictEqual(candidate.tokens[key], original.tokens[key])) {
      throw new Error(`refreshed Codex auth.json changed protected token field ${key}`);
    }
  }
}

function requireRegularFile(path, label) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file`);
  }
  return info;
}

function buildCodexHome(configDir) {
  const authPath = join(configDir, "auth.json");
  if (!existsSync(authPath)) throw new Error("Codex analysis credential directory is missing auth.json");
  const authInfo = requireRegularFile(authPath, "Codex analysis auth.json");
  const originalAuth = readFileSync(authPath);
  authRecord(originalAuth, "source Codex auth.json");
  const home = mkdtempSync(join(tmpdir(), "a2a-codex-home-"));
  copyFileSync(authPath, join(home, "auth.json"));
  chmodSync(join(home, "auth.json"), 0o600);
  const configPath = join(configDir, "config.toml");
  if (existsSync(configPath)) {
    requireRegularFile(configPath, "Codex analysis config.toml");
    copyFileSync(configPath, join(home, "config.toml"));
    chmodSync(join(home, "config.toml"), 0o600);
  }
  return {
    authPath,
    configDir,
    home,
    originalAuth,
    originalIdentity: { uid: authInfo.uid, gid: authInfo.gid },
  };
}

function commitCodexCredentialRefresh(runtime) {
  const candidatePath = join(runtime.home, "auth.json");
  requireRegularFile(candidatePath, "refreshed Codex analysis auth.json");
  const candidateAuth = readFileSync(candidatePath);
  validateCodexAuthRefreshCandidate(runtime.originalAuth, candidateAuth);
  if (candidateAuth.equals(runtime.originalAuth)) return false;

  const atomicPath = join(runtime.configDir, `.auth.json.a2a-${randomUUID()}`);
  try {
    writeFileSync(atomicPath, candidateAuth, { flag: "wx", mode: 0o600 });
    const atomicInfo = lstatSync(atomicPath);
    if (
      Number(atomicInfo.uid) !== runtime.originalIdentity.uid ||
      Number(atomicInfo.gid) !== runtime.originalIdentity.gid
    ) {
      chownSync(atomicPath, runtime.originalIdentity.uid, runtime.originalIdentity.gid);
    }
    chmodSync(atomicPath, 0o600);
    renameSync(atomicPath, runtime.authPath);
  } catch (error) {
    rmSync(atomicPath, { force: true });
    throw error;
  }
  return true;
}

function runCodexAdapter() {
  const { prompt } = parseClaudeAdapterArgs(process.argv.slice(2));
  const codexBin = safeText(process.env.A2A_CODEX_BIN, "codex");
  const model = normalizedModel(process.env.A2A_CODEX_MODEL);
  const reasoning = normalizedReasoning(process.env.A2A_CODEX_REASONING_EFFORT);
  const configDir = safeText(process.env.A2A_CODEX_ANALYSIS_CONFIG_DIR, "/var/lib/a2a-runner/codex-dir");
  const timeoutSec = Math.max(1, Number(process.env.A2A_CODEX_ANALYSIS_TIMEOUT_SEC || 3600));
  let codexHome;
  try {
    codexHome = buildCodexHome(configDir);
    const child = spawnSync(codexBin, [
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--json",
      "--model", model,
      "--sandbox", "read-only",
      "-c", 'approval_policy="never"',
      "-c", `model_reasoning_effort="${reasoning}"`,
      "-C", tmpdir(),
      "-",
    ], {
      input: prompt,
      encoding: "utf8",
      env: {
        HOME: safeText(process.env.HOME, "/root"),
        PATH: safeText(process.env.PATH, "/usr/local/bin:/usr/bin:/bin"),
        LANG: safeText(process.env.LANG, "C.UTF-8"),
        ...termuxChildEnv(process.env),
        CODEX_HOME: codexHome.home,
        ...(process.env.CAPTURE_ARGS_PATH ? { CAPTURE_ARGS_PATH: process.env.CAPTURE_ARGS_PATH } : {}),
        ...(process.env.CAPTURE_ENV_PATH ? { CAPTURE_ENV_PATH: process.env.CAPTURE_ENV_PATH } : {}),
      },
      maxBuffer: 16 * 1024 * 1024,
      timeout: timeoutSec * 1000,
      killSignal: "SIGKILL",
    });
    if (child.error) throw new Error(`Codex spawn failed: ${child.error.message}`);
    if (child.status !== 0) {
      throw new Error(`Codex exited with ${child.status}: ${redactSecrets(child.stderr || child.stdout)}`);
    }
    const result = extractCodexMessage(child.stdout);
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result }));
  } finally {
    if (codexHome) {
      try {
        commitCodexCredentialRefresh(codexHome);
      } finally {
        rmSync(codexHome.home, { recursive: true, force: true });
      }
    }
  }
}

function transformEnvelope(stdout, flags) {
  const envelope = JSON.parse(stdout);
  if (!Array.isArray(envelope.payloads) || !envelope.payloads[0]?.text) {
    throw new Error("Codex analysis wrapper received an invalid bridge envelope");
  }
  const response = JSON.parse(envelope.payloads[0].text);
  response.bridgeAdapter = "codex";
  response.bridgeContractVersion = BRIDGE_CONTRACT_VERSION;
  response.requestedModel = safeText(flags.model, undefined);
  response.requestedThinking = safeText(flags.thinking, undefined);
  response.actualRuntimeModel = normalizedModel(flags.model);
  response.modelInheritanceMode = "explicit";
  delete response.claudeModelArgumentApplied;
  response.modelInheritanceNote = "Codex bridge applies the requested model and reasoning explicitly to codex exec.";
  envelope.payloads[0].text = JSON.stringify(response);
  return JSON.stringify(envelope);
}

function runBridge() {
  if (!existsSync(CLAUDE_BRIDGE_PATH)) throw new Error("shared analysis bridge core is missing");
  const flags = parseOpenClawArgs(process.argv);
  if (flags.subcommand !== "agent" || !flags.json || !safeText(flags.message, "")) {
    throw new Error("expected OpenClaw-shaped agent --message ... --json invocation");
  }
  const child = spawnSync(process.execPath, [CLAUDE_BRIDGE_PATH, ...process.argv.slice(2)], {
    encoding: "utf8",
    env: {
      ...process.env,
      A2A_CLAUDE_CODE_BIN: SELF_PATH,
      A2A_CODEX_ADAPTER_MODE: "1",
      A2A_CODEX_MODEL: safeText(flags.model, process.env.A2A_CODEX_MODEL || "gpt-5.6-sol"),
      A2A_CODEX_REASONING_EFFORT: safeText(flags.thinking, process.env.A2A_CODEX_REASONING_EFFORT || "high"),
    },
    maxBuffer: 20 * 1024 * 1024,
  });
  if (child.error) throw new Error(`shared analysis bridge spawn failed: ${child.error.message}`);
  if (child.status !== 0) throw new Error(redactSecrets(child.stderr || child.stdout));
  process.stdout.write(transformEnvelope(child.stdout, flags));
}

try {
  if (process.env.A2A_CODEX_ADAPTER_MODE === "1") runCodexAdapter();
  else runBridge();
} catch (error) {
  die(error instanceof Error ? error.message : String(error));
}
