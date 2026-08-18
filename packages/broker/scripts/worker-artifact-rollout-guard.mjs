#!/usr/bin/env node
// a2a-broker worker artifact rollout guard
//
// Validates handler compatibility path, upstream bridge marker, executor
// policy, and dry-run readiness before deploying worker artifacts.
//
// Usage:
//   node scripts/worker-artifact-rollout-guard.mjs [--dry-run] [--smoke] [--verbose]
//   node scripts/worker-artifact-rollout-guard.mjs --docker-check
//   node scripts/worker-artifact-rollout-guard.mjs --deployed
//   A2A_WORKER_ROOT=/opt/openclaw-a2a-worker node scripts/worker-artifact-rollout-guard.mjs --deployed
//
// Exit codes:
//   0  — all guards passed / dry-run completed
//   1  — one or more guards failed
//   2  — setup error (missing source, unreadable file, etc.)
//
// Environment (honoured, never logged):
//   A2A_EXECUTOR_MODE         — executor mode (auto|docker|builtin)
//   A2A_DOCKER_RUNNER_SCOPE   — runner scope (plugin-only|all-github)
//   OPENCLAW_BIN              — host OpenClaw bridge binary path
//   A2A_WORKER_HANDLER_COMMAND / WORKER_HANDLER_COMMAND
//   A2A_WORKER_ROOT / WORKER_ROOT — deployed worker root containing scripts/ and handlers/
//   HANDLERS_ROOT             — override handlers/ directory (default: ./handlers)
//   SCRIPTS_ROOT              — override scripts/ directory (default: ./scripts)

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve, dirname } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = dirname(scriptPath);
const brokerRoot = resolve(scriptDir, '..');

const DRY_RUN = process.argv.includes('--dry-run');
const SMOKE = process.argv.includes('--smoke') || DRY_RUN;
const VERBOSE = process.argv.includes('--verbose');
const DOCKER_CHECK = process.argv.includes('--docker-check');
const DEPLOYED_CHECK = process.argv.includes('--deployed') || process.argv.includes('--runtime');

const CANONICAL_HANDLER_FILENAME = 'a2a-task-handler.mjs';
const LEGACY_HANDLER_FILENAME = '';
const HANDLER_SUPPORT_FILENAMES = [
  'worker-model-policy.mjs',
  'lib/source-carriers.mjs',
  'lib/retrieval-snapshot-carriers.mjs',
  'lib/live-operation-adapter.mjs',
];
const ANALYSIS_BRIDGE_BIN_VARS = ['A2A_PIRI_ANALYSIS_BIN', 'A2A_HERMES_ANALYSIS_BIN', 'A2A_OPENCLAW_ANALYSIS_BIN', 'OPENCLAW_BIN'];
const UNSET_ENV_TOKENS = new Set(['', 'none', 'null', 'undefined']);
const workerRoot = process.env.A2A_WORKER_ROOT || process.env.WORKER_ROOT;

const handlersRoot = resolve(
  process.env.HANDLERS_ROOT || (workerRoot ? join(workerRoot, 'handlers') : join(brokerRoot, 'handlers')),
);
const scriptsRoot = resolve(
  process.env.SCRIPTS_ROOT || (workerRoot ? join(workerRoot, 'scripts') : join(brokerRoot, 'scripts')),
);

function safeBasename(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const cleaned = value.replace(/^\.\.?[/\\]+/, '').replace(/[/\\]/g, '_');
  return cleaned || null;
}

class GuardError extends Error {
  constructor(message, guard) {
    super(message);
    this.name = 'GuardError';
    this.guard = guard;
  }
}

class SetupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SetupError';
    this.setupError = true;
  }
}

const guards = [];

function guard(name, fn) {
  guards.push({ name, fn });
}

function ok(name, detail) {
  return { guard: name, ok: true, ...(detail ? { detail } : {}) };
}

function fail(name, message, detail) {
  return {
    guard: name,
    ok: false,
    error: message instanceof Error ? message.message : String(message),
    ...(detail ? { detail } : {}),
  };
}

function envPresence(name) {
  const value = process.env[name]?.trim();
  return {
    configured: !!value,
    present: value !== undefined,
    valueHint: value
      ? value.length <= 20
        ? '<redacted-short>'
        : `${value.slice(0, 8)}...<redacted>`
      : undefined,
  };
}

function normalizeConfiguredEnvValue(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (UNSET_ENV_TOKENS.has(text.toLowerCase())) return '';
  return text;
}

function unquoteEnvValue(value) {
  const text = value.trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return text.slice(1, -1);
    }
  }
  return text;
}

function parseEnvAssignments(filePath) {
  if (!filePath || !existsSync(filePath)) return {};
  const content = readFileSafe(filePath);
  if (content === undefined) return {};
  const assignments = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const withoutExport = trimmed.replace(/^export\s+/, '');
    const match = withoutExport.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    assignments[match[1]] = unquoteEnvValue(match[2]);
  }
  return assignments;
}

function defaultDeployedEnvPath() {
  if (process.env.A2A_WORKER_ENV_PATH || process.env.WORKER_ENV_PATH) {
    return process.env.A2A_WORKER_ENV_PATH || process.env.WORKER_ENV_PATH;
  }
  if (!DEPLOYED_CHECK || !workerRoot) return '';
  return resolve(workerRoot) === '/opt/a2a-broker-worker' ? '/etc/default/a2a-hermes-worker' : '';
}

const deployedEnvPath = defaultDeployedEnvPath();
const deployedEnv = parseEnvAssignments(deployedEnvPath);

function configuredAnalysisBridgeBins() {
  return ANALYSIS_BRIDGE_BIN_VARS.map((name) => {
    const processValue = normalizeConfiguredEnvValue(process.env[name]);
    const envFileValue = normalizeConfiguredEnvValue(deployedEnv[name]);
    const value = processValue || envFileValue;
    return {
      name,
      configured: !!value,
      source: processValue ? 'process.env' : (envFileValue ? 'env-file' : 'unset'),
      value,
    };
  }).filter((item) => item.configured);
}

function isScriptBridgeCommand(value) {
  return /\.(?:mjs|cjs|js)$/i.test(value) && (
    value.includes('/') || value.includes('\\') || value.startsWith('.')
  );
}

function resolveConfiguredBridgeCommand(value) {
  if (isAbsolute(value)) return value;
  return resolve(process.env.A2A_HANDLER_CWD || process.env.WORKER_HANDLER_CWD || workerRoot || brokerRoot, value);
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function readFileSafe(filePath) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

function executableBits(filePath) {
  try {
    return statSync(filePath).mode & 0o111;
  } catch {
    return undefined;
  }
}

function executableHint(bits) {
  if (bits === undefined) return 'missing';
  return bits === 0 ? 'not-executable' : 'executable';
}

function compareCompatFile({ guardName, filename, sourceLabel, compatLabel }) {
  const sourcePath = join(scriptsRoot, filename);
  const compatPath = join(handlersRoot, filename);
  const sourceContent = readFileSafe(sourcePath);
  if (sourceContent === undefined) {
    return fail(guardName, `${sourceLabel} not found: ${sourcePath}`);
  }

  const sourceHash = sha256(sourceContent);
  if (!existsSync(compatPath)) {
    if (!DEPLOYED_CHECK) {
      return ok(guardName, {
        checked: false,
        reason: `${compatLabel} is generated during worker artifact deploy; use --deployed to require it`,
        sourcePath,
        compatPath,
        sourceHash,
      });
    }
    return fail(guardName, `${compatLabel} missing: ${compatPath}`, {
      sourcePath,
      compatPath,
      sourceHash,
      hint: `copy scripts/${filename} → handlers/${filename} before restarting the worker`,
      runtimeCheck:
        'A2A_WORKER_ROOT=/opt/openclaw-a2a-worker node scripts/worker-artifact-rollout-guard.mjs --deployed',
    });
  }

  const compatContent = readFileSafe(compatPath);
  if (compatContent === undefined) {
    return fail(guardName, `${compatLabel} unreadable: ${compatPath}`);
  }

  const compatHash = sha256(compatContent);
  if (compatHash !== sourceHash) {
    return fail(guardName, `${compatLabel} content differs from source`, {
      sourcePath,
      compatPath,
      sourceHash,
      compatHash,
      hint: `update handlers/${filename} to match scripts/${filename} before restarting the worker`,
      runtimeCheck:
        'A2A_WORKER_ROOT=/opt/openclaw-a2a-worker node scripts/worker-artifact-rollout-guard.mjs --deployed',
    });
  }

  return ok(guardName, {
    sourcePath,
    compatPath,
    matched: true,
    sourceHash,
  });
}

function compareExecutableParity(filename) {
  const sourcePath = join(scriptsRoot, filename);
  const compatPath = join(handlersRoot, filename);
  const sourceExecutable = executableBits(sourcePath);
  const compatExecutable = executableBits(compatPath);
  const sourceIsExecutable = sourceExecutable !== undefined && sourceExecutable !== 0;
  const compatIsExecutable = compatExecutable !== undefined && compatExecutable !== 0;

  return {
    filename,
    sourcePath,
    compatPath,
    sourceMode: executableHint(sourceExecutable),
    compatMode: executableHint(compatExecutable),
    ok: sourceIsExecutable === compatIsExecutable,
  };
}

function findReadableHandler(root) {
  for (const filename of [CANONICAL_HANDLER_FILENAME, LEGACY_HANDLER_FILENAME].filter(Boolean)) {
    const path = join(root, filename);
    const content = readFileSafe(path);
    if (content !== undefined) return { filename, path, content };
  }
  return undefined;
}

function tryRequire(path) {
  // Dynamic import for ESM modules
  return undefined; // we use regex-based parsing instead
}

function parseBuildInfo(source) {
  // Extract BUILD_INFO from handler source without executing it.
  // Handles both literal strings and constant references (e.g., version: HANDLER_VERSION).
  const nameMatch = source.match(/name:\s*["']([^"']+)["']/);

  // version may be a constant reference like `version: HANDLER_VERSION`
  let version = null;
  const versionLiteralMatch = source.match(/version:\s*["']([^"']+)["']/);
  if (versionLiteralMatch) {
    version = versionLiteralMatch[1];
  } else {
    // Try to resolve from constant: `const HANDLER_VERSION = "..."`
    const versionRefMatch = source.match(/version:\s*(\w+)/);
    if (versionRefMatch) {
      const refName = versionRefMatch[1];
      const constMatch = source.match(
        new RegExp(`const\\s+${refName}\\s*=\\s*["']([^"']+)["']`),
      );
      if (constMatch) version = constMatch[1];
    }
  }

  const sourceMatch = source.match(
    /source:\s*["'](repo:scripts\/(?:a2a-task-handler|openclaw-a2a-task-handler)\.mjs)["']/,
  );

  // sourceSha256 may be a local variable reference too
  let declaredSha = null;
  let shaRefMatch = null;
  const shaLiteralMatch = source.match(/sourceSha256:\s*["']([a-f0-9]{64})["']/);
  if (shaLiteralMatch) {
    declaredSha = shaLiteralMatch[1];
  } else {
    // Handle `sourceSha256` (variable reference)
    shaRefMatch = source.match(/sourceSha256/);
    if (shaRefMatch) {
      // The actual sha is computed at module load; we can't recover it from static
      // analysis. Accept presence of the marker field as sufficient.
      declaredSha = '<computed-at-runtime>';
    }
  }

  const contractMatch = source.match(
    /contract:\s*["'](stdin A2A task JSON -> stdout WorkerHandlerOutcome JSON)["']/,
  );
  const credentialMatch = source.match(/credentialFree:\s*(true|false)/);
  const hostNeutralMatch = source.match(/hostNeutral:\s*(true|false)/);

  const computedSha = sha256(source);

  // If declaredSha is a runtime value, we can't verify exact match
  const shaMatches = declaredSha && declaredSha !== '<computed-at-runtime>'
    ? declaredSha === computedSha
    : null;

  return {
    name: nameMatch?.[1] ?? null,
    version,
    source: sourceMatch?.[1] ?? null,
    declaredSha,
    computedSha,
    shaMatches,
    contract: contractMatch?.[1] ?? null,
    credentialFree: credentialMatch?.[1] === 'true',
    hostNeutral: hostNeutralMatch?.[1] === 'true',
    markerFound: !!(
      nameMatch &&
      version &&
      sourceMatch &&
      (shaLiteralMatch || shaRefMatch) &&
      contractMatch
    ),
  };
}

// ---------------------------------------------------------------------------
// guards
// ---------------------------------------------------------------------------

// Guard 1: Source handler exists and is readable
guard('source-handler', () => {
  const handler = findReadableHandler(scriptsRoot);
  if (!handler) {
    return fail('source-handler', `source handler not found in ${scriptsRoot}`);
  }
  const size = Buffer.byteLength(handler.content, 'utf8');
  if (VERBOSE) {
    console.error(`[guard:source] ${handler.path} — ${size} bytes`);
  }
  return ok('source-handler', { path: handler.path, filename: handler.filename, size });
});

// Guard 2: Handlers compat path exists and matches source
guard('handlers-compat-path', () => compareCompatFile({
  guardName: 'handlers-compat-path',
  filename: CANONICAL_HANDLER_FILENAME,
  sourceLabel: 'source handler',
  compatLabel: 'handlers compat path',
}));

// Guard 2b: Handler transitive support modules must also be deployed to handlers/.
// The deployed handler is executed from handlers/a2a-task-handler.mjs, so relative
// ESM imports such as ./worker-model-policy.mjs resolve against handlers/, not scripts/.
// Missing support modules caused runtime ERR_MODULE_NOT_FOUND after a handler update.
guard('handler-support-compat-path', () => {
  const checks = HANDLER_SUPPORT_FILENAMES.map((filename) => compareCompatFile({
    guardName: 'handler-support-compat-path',
    filename,
    sourceLabel: 'source handler support module',
    compatLabel: 'handlers support compat path',
  }));
  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    return fail('handler-support-compat-path', 'one or more handler support modules are missing or drifted in handlers/', {
      failed,
      requiredFiles: HANDLER_SUPPORT_FILENAMES,
      hint: 'copy scripts support modules to handlers/ with the handler artifact before restarting the worker',
      runtimeCheck:
        'A2A_WORKER_ROOT=/opt/openclaw-a2a-worker node scripts/worker-artifact-rollout-guard.mjs --deployed',
    });
  }
  return ok('handler-support-compat-path', { files: checks });
});

// Guard 3: Bridge compat path exists and matches source
guard('bridge-compat-path', () => compareCompatFile({
  guardName: 'bridge-compat-path',
  filename: 'hermes-a2a-analysis-bridge.mjs',
  sourceLabel: 'source bridge',
  compatLabel: 'bridge compat path',
}));

// Guard 3b: Any runtime-configured analysis bridge must exist in the deployed artifact.
// This catches stale node-specific bridge env such as /opt/.../custom-source-analysis-bridge.mjs
// before the worker claims a task and fails at handler runtime.
guard('configured-analysis-bridge-artifacts', () => {
  const configured = configuredAnalysisBridgeBins();
  if (configured.length === 0) {
    return ok('configured-analysis-bridge-artifacts', {
      checked: false,
      reason: 'no A2A_*_ANALYSIS_BIN/OPENCLAW_BIN bridge command configured in process env or deployed env file',
      envPathChecked: deployedEnvPath ? '<configured>' : undefined,
    });
  }

  const checks = configured.map((item) => {
    if (!isScriptBridgeCommand(item.value)) {
      return {
        name: item.name,
        source: item.source,
        commandKind: 'external-command',
        commandName: basename(item.value),
        ok: true,
      };
    }
    const resolvedPath = resolveConfiguredBridgeCommand(item.value);
    const mode = executableBits(resolvedPath);
    return {
      name: item.name,
      source: item.source,
      commandKind: 'script-bridge',
      commandName: basename(item.value),
      resolvedPath,
      mode: executableHint(mode),
      ok: mode !== undefined && mode !== 0,
    };
  });

  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    return fail('configured-analysis-bridge-artifacts', 'one or more configured analysis bridge script artifacts are missing or not executable', {
      failed,
      hint: 'point node env at a deployed standard bridge such as scripts/source-only-local-analysis-bridge.mjs or scripts/hermes-a2a-analysis-bridge.mjs, or ship the custom bridge with the artifact',
      envPathChecked: deployedEnvPath ? '<configured>' : undefined,
    });
  }

  return ok('configured-analysis-bridge-artifacts', {
    checks,
    envPathChecked: deployedEnvPath ? '<configured>' : undefined,
  });
});

// Guard 4: Executable bits stay in parity across scripts/ and handlers/
guard('artifact-executable-parity', () => {
  if (!DEPLOYED_CHECK) {
    return ok('artifact-executable-parity', {
      checked: false,
      reason: 'handlers compat executable bits are generated during worker artifact deploy; use --deployed to require parity',
    });
  }

  const artifacts = [
    compareExecutableParity(CANONICAL_HANDLER_FILENAME),
    compareExecutableParity('hermes-a2a-analysis-bridge.mjs'),
    ...HANDLER_SUPPORT_FILENAMES.map((filename) => compareExecutableParity(filename)),
  ];
  const drift = artifacts.filter((artifact) => !artifact.ok);
  if (drift.length > 0) {
    return fail('artifact-executable-parity', 'scripts/ and handlers/ executable bits differ', {
      drift,
      hint: 'copy scripts artifacts to handlers with executable bits preserved before restarting the worker',
      runtimeCheck:
        'A2A_WORKER_ROOT=/opt/openclaw-a2a-worker node scripts/worker-artifact-rollout-guard.mjs --deployed',
    });
  }

  return ok('artifact-executable-parity', { artifacts });
});

// Guard 5: Upstream bridge marker present in handler
guard('bridge-marker', () => {
  const source = findReadableHandler(scriptsRoot);
  if (!source) {
    return fail('bridge-marker', `cannot read source handler in ${scriptsRoot}`);
  }

  const info = parseBuildInfo(source.content);

  if (!info.markerFound) {
    return fail(
      'bridge-marker',
      'BUILD_INFO marker incomplete or missing',
      {
        found: {
          name: info.name,
          version: info.version,
          source: info.source,
          declaredSha: info.declaredSha,
          contract: info.contract,
        },
        required: [
          'name',
          'version',
          'source',
          'sourceSha256',
          'contract',
        ],
      },
    );
  }

  if (info.shaMatches === false) {
    return fail(
      'bridge-marker',
      `sourceSha256 mismatch: declared=${info.declaredSha} computed=${info.computedSha}`,
      {
        declaredSha: info.declaredSha,
        computedSha: info.computedSha,
        hint: 'handler source was modified; update BUILD_INFO.sourceSha256',
      },
    );
  }

  // null shaMatches means runtime-computed sha — verified by field presence

  if (!info.credentialFree) {
    return fail('bridge-marker', 'credentialFree must be true');
  }

  if (!info.hostNeutral) {
    return fail('bridge-marker', 'hostNeutral must be true');
  }

  if (info.contract !== 'stdin A2A task JSON -> stdout WorkerHandlerOutcome JSON') {
    return fail(
      'bridge-marker',
      `unexpected contract: ${info.contract}`,
      { expected: 'stdin A2A task JSON -> stdout WorkerHandlerOutcome JSON' },
    );
  }

  return ok('bridge-marker', {
    name: info.name,
    version: info.version,
    sourceMarker: info.source,
    shaMatches: true,
    credentialFree: true,
    hostNeutral: true,
  });
});

// Guard 4: Executor policy environment — report without leaking values
guard('executor-policy', () => {
  const policies = {
    A2A_EXECUTOR_MODE: envPresence('A2A_EXECUTOR_MODE'),
    A2A_DOCKER_RUNNER_SCOPE: envPresence('A2A_DOCKER_RUNNER_SCOPE'),
    A2A_DOCKER_RUNNER_ENABLED: envPresence('A2A_DOCKER_RUNNER_ENABLED'),
    A2A_DOCKER_RUNNER_ALL_GITHUB: envPresence('A2A_DOCKER_RUNNER_ALL_GITHUB'),
    A2A_WORKER_PROFILE: envPresence('A2A_WORKER_PROFILE'),
    A2A_WORKER_RUNTIME_FLAVOR: envPresence('A2A_WORKER_RUNTIME_FLAVOR'),
    A2A_WORKER_GATEWAY_REQUIRED: envPresence('A2A_WORKER_GATEWAY_REQUIRED'),
  };

  const bridgePolicies = {
    A2A_PIRI_BIN: envPresence('A2A_PIRI_BIN'),
    OPENCLAW_BIN: envPresence('OPENCLAW_BIN'),
    A2A_PIRI_ANALYSIS_BIN: envPresence('A2A_PIRI_ANALYSIS_BIN'),
    A2A_HERMES_ANALYSIS_BIN: envPresence('A2A_HERMES_ANALYSIS_BIN'),
    A2A_OPENCLAW_ANALYSIS_BIN: envPresence('A2A_OPENCLAW_ANALYSIS_BIN'),
    A2A_OPENCLAW_BRIDGE_ENABLED: envPresence('A2A_OPENCLAW_BRIDGE_ENABLED'),
    A2A_OPENCLAW_BRIDGE_DISABLED: envPresence('A2A_OPENCLAW_BRIDGE_DISABLED'),
    A2A_OPENCLAW_SESSION_ID: envPresence('A2A_OPENCLAW_SESSION_ID'),
    A2A_OPENCLAW_THINKING: envPresence('A2A_OPENCLAW_THINKING'),
    A2A_OPENCLAW_TIMEOUT_SEC: envPresence('A2A_OPENCLAW_TIMEOUT_SEC'),
  };

  const runtimePolicies = {
    A2A_EXECUTOR_FALLBACK: envPresence('A2A_EXECUTOR_FALLBACK'),
    A2A_DOCKER_RUNNER_TASK_TIMEOUT_MS: envPresence('A2A_DOCKER_RUNNER_TASK_TIMEOUT_MS'),
    A2A_DOCKER_RUNNER_ROOT: envPresence('A2A_DOCKER_RUNNER_ROOT'),
    A2A_DOCKER_RUNNER_GITHUB_TOKEN_FILE: envPresence('A2A_DOCKER_RUNNER_GITHUB_TOKEN_FILE'),
    A2A_DOCKER_RUNNER_BIN: envPresence('A2A_DOCKER_RUNNER_BIN'),
    A2A_DOCKER_RUNNER_ARGS_JSON: envPresence('A2A_DOCKER_RUNNER_ARGS_JSON'),
    A2A_DOCKER_RUNNER_MEMORY: envPresence('A2A_DOCKER_RUNNER_MEMORY'),
    A2A_DOCKER_RUNNER_CPUS: envPresence('A2A_DOCKER_RUNNER_CPUS'),
  };

  const handlerRefs = {
    WORKER_HANDLER_COMMAND: envPresence('WORKER_HANDLER_COMMAND'),
    A2A_WORKER_HANDLER_COMMAND: envPresence('A2A_WORKER_HANDLER_COMMAND'),
    WORKER_HANDLER_ARGS_JSON: envPresence('WORKER_HANDLER_ARGS_JSON'),
    WORKER_HANDLER_CWD: envPresence('WORKER_HANDLER_CWD'),
    WORKER_HANDLER_BUILTIN: envPresence('WORKER_HANDLER_BUILTIN'),
  };

  // Sanitize: presence-only, no values
  const report = {
    executor: policies,
    bridge: bridgePolicies,
    runtime: runtimePolicies,
    handlerRefs,
  };

  // Check for clear misconfiguration
  const warnings = [];
  const executorMode = process.env.A2A_EXECUTOR_MODE?.trim().toLowerCase();
  const workerProfile = process.env.A2A_WORKER_PROFILE?.trim().toLowerCase().replace(/_/g, '-');
  const workerRuntimeFlavor = process.env.A2A_WORKER_RUNTIME_FLAVOR?.trim().toLowerCase().replace(/_/g, '-');

  if (executorMode && !['auto', 'docker', 'builtin'].includes(executorMode)) {
    warnings.push(`A2A_EXECUTOR_MODE="${process.env.A2A_EXECUTOR_MODE}" is invalid (expected: auto|docker|builtin)`);
  }

  if (workerProfile && workerProfile !== 'openclaw-poll-only') {
    warnings.push(`A2A_WORKER_PROFILE="${process.env.A2A_WORKER_PROFILE}" is invalid (expected: openclaw-poll-only)`);
  }

  if (workerProfile === 'openclaw-poll-only' && !bridgePolicies.A2A_OPENCLAW_BRIDGE_DISABLED.configured) {
    warnings.push('A2A_WORKER_PROFILE=openclaw-poll-only should set A2A_OPENCLAW_BRIDGE_DISABLED=1 in deployed env; start:worker injects it for external handlers');
  }

  if (workerProfile === 'openclaw-poll-only' && (workerRuntimeFlavor === 'termux-hermes' || workerRuntimeFlavor === 'hermes')) {
    warnings.push('Hermes workers must not use A2A_WORKER_PROFILE=openclaw-poll-only; use A2A_WORKER_RUNTIME_FLAVOR=termux-hermes with a Hermes harness');
  }

  if (policies.A2A_DOCKER_RUNNER_ENABLED.configured && !runtimePolicies.A2A_DOCKER_RUNNER_BIN.configured) {
    warnings.push('A2A_DOCKER_RUNNER_ENABLED is set but A2A_DOCKER_RUNNER_BIN is not configured');
  }

  if (bridgePolicies.OPENCLAW_BIN.configured && bridgePolicies.A2A_OPENCLAW_BRIDGE_DISABLED.configured) {
    warnings.push('OPENCLAW_BIN is set but A2A_OPENCLAW_BRIDGE_DISABLED is also set; bridge is disabled');
  }

  return ok('executor-policy', {
    policies: report,
    warnings: warnings.length ? warnings : undefined,
    safe: true, // no secrets leaked
  });
});

// Guard 5: Dockerfile includes handler scripts
guard('docker-handler-inclusion', () => {
  if (!DOCKER_CHECK) {
    return ok('docker-handler-inclusion', { checked: false, reason: '--docker-check not specified' });
  }

  const dockerfilePath = join(brokerRoot, 'Dockerfile');
  const dockerfileContent = readFileSafe(dockerfilePath);
  if (dockerfileContent === undefined) {
    return fail('docker-handler-inclusion', `Dockerfile not found: ${dockerfilePath}`);
  }

  const hasHandlerCopy = /COPY\s+scripts\/(?:a2a-task-handler|openclaw-a2a-task-handler)\.mjs/.test(dockerfileContent);
  const missingSupportCopies = HANDLER_SUPPORT_FILENAMES.filter((filename) => {
    const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return !new RegExp(`COPY\\s+scripts/${escaped}`).test(dockerfileContent)
      && !new RegExp(`cp\\s+scripts/${escaped}\\s+\\./handlers/`).test(dockerfileContent);
  });
  const hasHandlersDir = /handlers\//.test(dockerfileContent) || /mkdir.*handlers/i.test(dockerfileContent);

  if ((!hasHandlerCopy && !hasHandlersDir) || missingSupportCopies.length > 0) {
    return fail(
      'docker-handler-inclusion',
      missingSupportCopies.length > 0
        ? 'Dockerfile does not copy handler support modules into the image/handlers compat path'
        : 'Dockerfile does not copy handler scripts into the image; ' +
          'deployed container will lack scripts/a2a-task-handler.mjs and handlers/ compat path',
      {
        missingSupportCopies,
        fix: 'copy scripts/a2a-task-handler.mjs and handler support modules into ./scripts/ and ./handlers/ in Dockerfile',
        dryRun: DRY_RUN,
      },
    );
  }

  return ok('docker-handler-inclusion', {
    hasHandlerCopy,
    supportFiles: HANDLER_SUPPORT_FILENAMES,
    hasHandlersDir,
  });
});

// Guard 6: Dockerfile compat path — handlers/ directory is created in image
guard('docker-compat-path', () => {
  if (!DOCKER_CHECK) {
    return ok('docker-compat-path', { checked: false, reason: '--docker-check not specified' });
  }

  const dockerfilePath = join(brokerRoot, 'Dockerfile');
  const dockerfileContent = readFileSafe(dockerfilePath);
  if (dockerfileContent === undefined) {
    return fail('docker-compat-path', `Dockerfile not found: ${dockerfilePath}`);
  }

  // Count handler copies via COPY or RUN cp to both scripts/ and handlers/ paths
  const copyMatches = dockerfileContent.match(
    /COPY\s+scripts\/(?:a2a-task-handler|openclaw-a2a-task-handler)\.mjs/g,
  ) || [];
  const hasRunCopy = /RUN[\s\S]*cp\s+scripts\/(?:a2a-task-handler|openclaw-a2a-task-handler)\.mjs\s+\.\/handlers\//.test(dockerfileContent);
  const hasHandlersMkdir = /mkdir.*handlers/i.test(dockerfileContent);

  const scriptsCopyCount = copyMatches.length;
  const handlersCopyCount = hasRunCopy ? 1 : 0;

  if (scriptsCopyCount < 1) {
    return fail(
      'docker-compat-path',
      'Dockerfile does not copy handler to scripts/ path',
      { hint: 'add COPY scripts/a2a-task-handler.mjs ./scripts/', dryRun: DRY_RUN },
    );
  }

  if (handlersCopyCount < 1) {
    return fail(
      'docker-compat-path',
      'Dockerfile does not populate handlers/ compat path',
      {
        hint: 'add RUN mkdir -p ./handlers && cp scripts/a2a-task-handler.mjs ./handlers/',
        dryRun: DRY_RUN,
      },
    );
  }

  return ok('docker-compat-path', {
    scriptsCopyCount,
    handlersPopulated: hasRunCopy,
    hasHandlersMkdir,
  });
});

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function runGuards() {
  if (DRY_RUN) {
    console.error('[guard] DRY-RUN mode — no changes will be made');
  }
  if (SMOKE && !DRY_RUN) {
    console.error('[guard] SMOKE mode — validation only, no changes');
  }
  if (DOCKER_CHECK) {
    console.error('[guard] DOCKER-CHECK mode — validating Dockerfile inclusion');
  }

  const results = [];
  let allOk = true;

  for (const { name, fn } of guards) {
    try {
      const result = fn();
      results.push(result);
      if (!result.ok) {
        allOk = false;
      }
    } catch (error) {
      const errResult = fail(name, error);
      results.push(errResult);
      allOk = false;
    }
  }

  // Collect summary
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  const total = results.length;

  const output = {
    ok: allOk,
    dryRun: DRY_RUN,
    smoke: SMOKE,
    dockerCheck: DOCKER_CHECK,
    timestamp: new Date().toISOString(),
    brokerRoot,
    handlersRoot,
    scriptsRoot,
    handlerFilename: CANONICAL_HANDLER_FILENAME,
    legacyHandlerFilename: LEGACY_HANDLER_FILENAME,
    summary: {
      passed,
      failed,
      total,
      message: allOk
        ? `all ${total} guards passed`
        : `${passed}/${total} passed, ${failed} failed`,
    },
    results,
    rollback:
      failed > 0
        ? {
            action: 'fix_issues_and_re_run',
            hint: 'address failures above, re-run guard until all pass',
            emergencyFallback:
              'if handler path is broken: cp scripts/a2a-task-handler.mjs handlers/a2a-task-handler.mjs from the merged release artifact during rollback',
          }
        : undefined,
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);

  if (VERBOSE) {
    for (const r of results) {
      if (r.ok) {
        console.error(`[guard] ✅ ${r.guard}`);
      } else {
        console.error(`[guard] ❌ ${r.guard}: ${r.error}`);
      }
    }
  }

  return allOk;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const allPassed = await runGuards();
process.exit(allPassed ? 0 : 1);
