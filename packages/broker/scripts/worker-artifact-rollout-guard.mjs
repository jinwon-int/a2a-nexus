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
//   A2A_*_ANALYSIS_BIN / A2A_PIRI_BIN / A2A_PIRI_PATCH_BIN — analysis and host patch
//                               bridge slots; the guard reports which slot the handler
//                               actually selects for each lane (#2461)
//   A2A_ROLLOUT_GUARD_STRICT_BRIDGE_ROOT — 1 to FAIL (not warn) when a configured
//                               analysis or patch bridge script resolves outside the
//                               worker root (#2429, #2461)
//   HANDLERS_ROOT             — override handlers/ directory (default: ./handlers)
//   SCRIPTS_ROOT              — override scripts/ directory (default: ./scripts)
//   DIST_ROOT                 — override dist/ directory scanned for workspace-package
//                               imports (default: <worker root>/dist, --deployed only)
//   A2A_WORKER_TARGET_REVISION — optional; when set, --deployed requires
//                               dist/build-info.json.revision to match (#2423)

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, dirname } from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
  'lib/analysis-execution-telemetry.mjs',
  'finalizer-tool-policy.mjs',
  'lib/utf8-byte-budget.mjs',
  'lib/jev-classifier.mjs',
  'lib/jev-review-shadow.mjs',
  'lib/jev-probe-observation.mjs',
  'lib/analysis-source-bundle.mjs',
  'lib/analysis-harness-fingerprint.mjs',
];
// #2461: these mirror the handler's bridge selection (a2a-task-handler.mjs
// analysisBridgeCandidates / analysisBridgeCommand / hostPatchBridgeCommand).
// Order is precedence. The parity test in worker-artifact-rollout-guard.test.mjs
// compares the guard's choice with the handler's own functions, so a drift in
// either file fails CI instead of silently mis-reporting the effective bridge.
const ANALYSIS_BRIDGE_BIN_VARS = ['A2A_DANSO_ANALYSIS_BIN', 'A2A_PIRI_ANALYSIS_BIN', 'A2A_HERMES_ANALYSIS_BIN', 'A2A_OPENCLAW_ANALYSIS_BIN', 'OPENCLAW_BIN'];
const PATCH_BRIDGE_BIN_VARS = ['A2A_PIRI_BIN', 'A2A_PIRI_PATCH_BIN', 'OPENCLAW_BIN'];
const BRIDGE_BIN_VARS = [...new Set([...ANALYSIS_BRIDGE_BIN_VARS, ...PATCH_BRIDGE_BIN_VARS])];
const BRIDGE_ADAPTER_VARS = ['A2A_ANALYSIS_BRIDGE_ADAPTER', 'A2A_WORKER_BRIDGE_ADAPTER'];
// Runtime of the handler's DEFAULT_ANALYSIS_BRIDGE (piri-a2a-analysis-bridge.mjs).
const DEFAULT_ANALYSIS_BRIDGE_RUNTIME = 'piri';
const PATCH_BRIDGE_DISABLED_VARS = ['A2A_OPENCLAW_BRIDGE_DISABLED', 'A2A_PIRI_PATCH_BRIDGE_DISABLED'];
// Same keyword order as the handler's ANALYSIS_BRIDGE_RUNTIME_KEYWORDS (#2370).
const BRIDGE_RUNTIME_KEYWORDS = [
  ['codex', 'codex'],
  ['claude', 'claude_code'],
  ['hermes', 'hermes'],
  ['piri', 'piri'],
  ['danso', 'danso'],
  ['openclaw', 'openclaw'],
];
const UNSET_ENV_TOKENS = new Set(['', 'none', 'null', 'undefined']);
const workerRoot = process.env.A2A_WORKER_ROOT || process.env.WORKER_ROOT;

const handlersRoot = resolve(
  process.env.HANDLERS_ROOT || (workerRoot ? join(workerRoot, 'handlers') : join(brokerRoot, 'handlers')),
);
const scriptsRoot = resolve(
  process.env.SCRIPTS_ROOT || (workerRoot ? join(workerRoot, 'scripts') : join(brokerRoot, 'scripts')),
);
const distRoot = resolve(
  process.env.DIST_ROOT || (workerRoot ? join(workerRoot, 'dist') : join(brokerRoot, 'dist')),
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

function configuredEnvValue(name) {
  const processValue = normalizeConfiguredEnvValue(process.env[name]);
  const envFileValue = normalizeConfiguredEnvValue(deployedEnv[name]);
  return {
    value: processValue || envFileValue,
    source: processValue ? 'process.env' : (envFileValue ? 'env-file' : 'unset'),
  };
}

function bridgeRoles(name) {
  return [
    ...(ANALYSIS_BRIDGE_BIN_VARS.includes(name) ? ['analysis'] : []),
    ...(PATCH_BRIDGE_BIN_VARS.includes(name) ? ['patch'] : []),
  ];
}

function configuredBridgeBins() {
  return BRIDGE_BIN_VARS.map((name) => {
    const { value, source } = configuredEnvValue(name);
    return { name, roles: bridgeRoles(name), configured: !!value, source, value };
  }).filter((item) => item.configured);
}

// #2370 mirror: the runtime a bridge belongs to, from its FILE NAME only.
function bridgeRuntimeFromName(command) {
  const name = basename(String(command ?? '').trim()).toLowerCase();
  if (!name) return '';
  for (const [keyword, adapter] of BRIDGE_RUNTIME_KEYWORDS) {
    if (name.includes(keyword)) return adapter;
  }
  return '';
}

// Mirror of the handler's normalizeAnalysisBridgeAdapter.
function normalizeBridgeAdapter(value) {
  const adapter = String(value ?? '').trim().toLowerCase().replace(/_/g, '-');
  if (['codex', 'codex-cli', 'codex-analysis'].includes(adapter)) return 'codex';
  if (['claude', 'claude-code', 'claude_code'].includes(adapter)) return 'claude_code';
  if (['piri', 'pi'].includes(adapter)) return 'piri';
  if (['danso', 'danso-cli'].includes(adapter)) return 'danso';
  if (['hermes', 'hermes-agent', 'hermes-agent-source-only', 'termux-hermes'].includes(adapter)) return 'hermes';
  if (['openclaw', 'openclaw-analysis'].includes(adapter)) return 'openclaw';
  return '';
}

function isTruthyFlag(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
}

// #2461: which slot the handler actually runs for each lane. `values` maps a
// slot name to its configured value (blank = unset). Analysis: the first slot
// whose file-name runtime matches the declared adapter, else precedence order;
// no slot = the handler's in-repo default bridge (name null). Patch: first set
// slot unless the host patch bridge is disabled.
// Values are RAW (handler semantics: only blank/whitespace is unset, so a
// literal `none` is a candidate the handler would try to run).
function selectEffectiveBridges(values = {}) {
  const pick = (name) => String(values[name] ?? '').trim();
  // Handler: `A2A_ANALYSIS_BRIDGE_ADAPTER || A2A_WORKER_BRIDGE_ADAPTER` on the
  // raw strings — a whitespace-only first var wins and normalizes to none.
  const declaredRaw = BRIDGE_ADAPTER_VARS.map((name) => values[name]).find((value) => typeof value === 'string' && value !== '') || '';
  const declaredAdapter = normalizeBridgeAdapter(declaredRaw);
  const analysisCandidates = ANALYSIS_BRIDGE_BIN_VARS.filter((name) => pick(name));
  let analysisName = null;
  let selectedBy = 'default';
  const declaredMatch = declaredAdapter
    ? analysisCandidates.find((name) => bridgeRuntimeFromName(pick(name)) === declaredAdapter)
    : undefined;
  if (declaredMatch) {
    analysisName = declaredMatch;
    selectedBy = 'declared-adapter';
  } else if (declaredAdapter && declaredAdapter === DEFAULT_ANALYSIS_BRIDGE_RUNTIME) {
    // The handler appends its in-repo default bridge to the candidate list, so
    // a declared piri adapter with no piri-named slot runs the default.
    selectedBy = 'declared-adapter-default';
  } else if (analysisCandidates.length > 0) {
    analysisName = analysisCandidates[0];
    selectedBy = 'precedence';
  }
  const analysisRuntime = analysisName ? bridgeRuntimeFromName(pick(analysisName)) : DEFAULT_ANALYSIS_BRIDGE_RUNTIME;
  const adapterMismatch = Boolean(declaredAdapter && analysisRuntime && analysisRuntime !== declaredAdapter);

  const patchDisabled = PATCH_BRIDGE_DISABLED_VARS.some((name) => isTruthyFlag(values[name]));
  const patchName = patchDisabled ? null : (PATCH_BRIDGE_BIN_VARS.find((name) => pick(name)) || null);
  const unsetToken = (name) => (name && UNSET_ENV_TOKENS.has(pick(name).toLowerCase()) ? pick(name) : undefined);
  return {
    analysis: {
      name: analysisName,
      literalUnsetToken: unsetToken(analysisName),
      selectedBy,
      runtime: analysisRuntime || undefined,
      declaredAdapter: declaredAdapter || undefined,
      adapterMismatch,
    },
    patch: {
      name: patchName,
      literalUnsetToken: unsetToken(patchName),
      disabled: patchDisabled,
    },
  };
}

// Raw per-variable merge (process env wins over the deployed env file), with
// no unset-token normalization — the handler sees the raw strings.
function effectiveBridgeEnvValues() {
  const values = {};
  for (const name of [...BRIDGE_BIN_VARS, ...BRIDGE_ADAPTER_VARS, ...PATCH_BRIDGE_DISABLED_VARS]) {
    const processValue = process.env[name];
    values[name] = typeof processValue === 'string' && processValue !== '' ? processValue : (deployedEnv[name] ?? '');
  }
  return values;
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

// #2429: `--deployed` only verifies that a configured bridge exists and is
// executable; it also passes when the path leaves the worker root entirely.
const STRICT_BRIDGE_ROOT = /^(1|true|yes)$/i.test((process.env.A2A_ROLLOUT_GUARD_STRICT_BRIDGE_ROOT ?? '').trim());

function realpathOrSelf(filePath) {
  try {
    return realpathSync(filePath);
  } catch {
    return resolve(filePath);
  }
}

// undefined when there is no worker root to compare against (repo mode).
function isOutsideWorkerRoot(filePath) {
  if (!workerRoot) return undefined;
  const root = realpathOrSelf(workerRoot);
  const target = realpathOrSelf(filePath);
  const rel = relative(root, target);
  return rel === '' ? false : (rel.startsWith('..') || isAbsolute(rel));
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
// workspace dependency export helpers (#2311)
// ---------------------------------------------------------------------------

// Static `import … from "a2a-*"` / `export … from "a2a-*"` declarations. The
// clause is matched structurally (default, `{ … }` across lines, `* as ns`) so a
// match can never span two statements.
const WORKSPACE_IMPORT_RE =
  /(?<![\w$.])(import|export)\s+(type\s+)?(?:([\w$]+)\s*,\s*)?(?:\{([^{}]*)\}|(\*)(?:\s+as\s+[\w$]+)?|([\w$]+))\s*from\s*(['"])(a2a-[\w.-]+(?:\/[^'"\s]+)?)\7/g;

function listDistJsFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      // *.test.js never link at worker runtime; skipping them keeps the scan
      // small and avoids test-only import drift producing a rollout failure.
      else if (entry.isFile() && entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) out.push(full);
    }
  };
  walk(root);
  return out;
}

function parseWorkspaceImports(source) {
  const found = [];
  if (!source.includes('a2a-')) return found;
  for (const match of source.matchAll(WORKSPACE_IMPORT_RE)) {
    const [, keyword, typeOnly, leadingDefault, braced, star, soleDefault, , specifier] = match;
    if (typeOnly) continue;
    const names = [];
    if (keyword === 'import' && (leadingDefault || soleDefault)) names.push('default');
    if (braced !== undefined) {
      for (const raw of braced.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '').split(',')) {
        const item = raw.trim();
        if (!item || /^type\s/.test(item)) continue;
        const name = item.split(/\s+as\s+/)[0].trim();
        if (/^[\w$]+$/.test(name)) names.push(name);
      }
    }
    void star; // namespace import / `export *` requires no specific name
    found.push({ specifier, names });
  }
  return found;
}

function splitPackageSpecifier(specifier) {
  const slash = specifier.indexOf('/');
  return slash === -1
    ? { packageName: specifier, subpath: '.' }
    : { packageName: specifier.slice(0, slash), subpath: `./${specifier.slice(slash + 1)}` };
}

function findPackageDir(startDir, packageName) {
  // Mirror Node's bare-specifier lookup: nearest node_modules/<pkg> walking up
  // from the importing dist tree.
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, 'node_modules', packageName);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function resolveExportTarget(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const target = resolveExportTarget(item);
      if (target) return target;
    }
    return undefined;
  }
  if (value && typeof value === 'object') {
    for (const condition of ['import', 'node', 'default']) {
      if (condition in value) {
        const target = resolveExportTarget(value[condition]);
        if (target) return target;
      }
    }
  }
  return undefined;
}

function resolvePackageEntry(packageDir, subpath) {
  let pkg = {};
  const pkgText = readFileSafe(join(packageDir, 'package.json'));
  if (pkgText !== undefined) {
    try {
      pkg = JSON.parse(pkgText) ?? {};
    } catch {
      return { error: 'package.json is not valid JSON' };
    }
  }
  const { exports } = pkg;
  let target;
  if (exports !== undefined && exports !== null) {
    const isSubpathMap = typeof exports === 'object' && !Array.isArray(exports)
      && Object.keys(exports).some((key) => key.startsWith('.'));
    if (isSubpathMap) target = resolveExportTarget(exports[subpath]);
    else if (subpath === '.') target = resolveExportTarget(exports);
    if (!target) return { error: `package.json exports has no import target for "${subpath}"` };
  } else if (subpath !== '.') {
    target = subpath;
  } else {
    const candidates = [pkg.main, 'dist/index.js', 'index.js'].filter((item) => typeof item === 'string' && item);
    target = candidates.find((item) => existsSync(join(packageDir, item))) ?? candidates[0];
  }
  const entryPath = resolve(packageDir, target);
  if (!existsSync(entryPath)) return { error: `entry file missing: ${target}` };
  return { entryPath, version: typeof pkg.version === 'string' ? pkg.version : null };
}

function probeModuleExports(entries) {
  // Import every resolved entry in ONE child node so a broken package cannot
  // take the guard down and a hung top-level await is bounded by the timeout.
  // Only export NAMES leave the child — never values.
  const probe = [
    `const entries = ${JSON.stringify(entries.map(({ key, entryPath }) => ({ key, href: pathToFileURL(entryPath).href })))};`,
    'const out = {};',
    'for (const { key, href } of entries) {',
    '  try { out[key] = { ok: true, names: Object.keys(await import(href)).sort() }; }',
    '  catch (error) { out[key] = { ok: false, error: `${error?.code ? `${error.code}: ` : ""}${String(error?.message ?? error).split("\\n")[0].slice(0, 300)}` }; }',
    '}',
    'process.stdout.write(JSON.stringify(out));',
  ].join('\n');
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', probe], {
    cwd: distRoot,
    encoding: 'utf8',
    timeout: 30000,
  });
  if (child.error) return { error: `export probe could not run: ${child.error.message}` };
  if (child.status !== 0) {
    const ended = child.status === null ? `signal ${child.signal}` : `exit ${child.status}`;
    return { error: `export probe failed (${ended})`, stderrTail: (child.stderr ?? '').trim().slice(-1000) };
  }
  try {
    return { results: JSON.parse(child.stdout) };
  } catch {
    return { error: 'export probe produced unparseable output' };
  }
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

// Guard 1b: the handler entry and its transitive imports must actually RESOLVE
// from the artifact layout. #2227: handler 0.2.20 introduced the workspace
// dependency a2a-attestation, but a file-copy artifact never contains it, so
// the handler died with ERR_MODULE_NOT_FOUND on startup while every
// path/marker/policy guard below still passed (exit=0). Importing the entry in
// a child node validates the whole module graph. Skipped (checked:false) only
// when no node_modules exists above the handler — bare fixture/unpackaged
// trees have nothing to resolve against.
guard('handler-module-resolution', () => {
  const deployed = findReadableHandler(handlersRoot);
  const source = findReadableHandler(scriptsRoot);
  const handler = deployed ?? source;
  if (!handler) {
    return ok('handler-module-resolution', { checked: false, reason: 'handler file missing (reported by source-handler)' });
  }

  let dir = dirname(handler.path);
  let hasNodeModules = false;
  for (;;) {
    if (existsSync(join(dir, 'node_modules'))) {
      hasNodeModules = true;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!hasNodeModules) {
    return ok('handler-module-resolution', {
      checked: false,
      reason: 'no node_modules above handler — nothing to resolve against (fixture or unpackaged tree)',
      handlerPath: handler.path,
    });
  }

  // The worker executes the handlers/ compat copy; validate that one when it
  // exists, and fall back to the scripts copy otherwise.
  const probe = [
    'const mod = await import(',
    JSON.stringify(pathToFileURL(handler.path).href),
    ');\n',
    'process.stdout.write(JSON.stringify({ name: mod.BUILD_INFO?.name ?? null, version: mod.BUILD_INFO?.version ?? null }));',
  ].join('');

  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', probe], {
    cwd: dirname(handler.path),
    encoding: 'utf8',
    timeout: 30000,
  });

  if (child.error) {
    return fail('handler-module-resolution', `module resolution probe could not run: ${child.error.message}`, {
      handlerPath: handler.path,
    });
  }

  const stderrTail = (child.stderr ?? '').trim().slice(-2000);
  if (child.status !== 0) {
    const ended = child.status === null ? `signal ${child.signal}` : `exit ${child.status}`;
    return fail('handler-module-resolution', `handler entry failed to import (${ended})`, {
      handlerPath: handler.path,
      stderrTail,
      hint: 'a transitive import does not resolve — the artifact is missing a workspace package (e.g. a2a-attestation, #2227). Pack the workspace build output + node_modules link with the artifact, then re-run this guard.',
    });
  }

  let imported = null;
  try {
    imported = JSON.parse((child.stdout ?? '').trim() || 'null');
  } catch {
    imported = null;
  }

  const fileVersion = parseBuildInfo(handler.content)?.version ?? null;
  // 기대 버전 대비 드리프트 리포트(#2227): guard를 저장소에서 실행해 대상 artifact를
  // 검사할 때 저장소 쪽 핸들러 버전을 함께 보여준다. 정보 제공용이며 실패로 세지
  // 않는다 — 배포 진행 중인 노드는 정상적으로 구버전일 수 있다.
  const repoScriptsHandler = findReadableHandler(join(brokerRoot, 'scripts'));
  const expectedVersion = repoScriptsHandler && resolve(repoScriptsHandler.path) !== resolve(handler.path)
    ? (parseBuildInfo(repoScriptsHandler.content)?.version ?? null)
    : undefined;

  return ok('handler-module-resolution', {
    checked: true,
    handlerPath: handler.path,
    importedFrom: deployed ? 'handlers (runtime copy)' : 'scripts (source)',
    importedBuildInfo: imported,
    fileVersion,
    ...(expectedVersion !== undefined ? { expectedVersion } : {}),
  });
});

// Guard 1c: workspace packages in the deployed node_modules must provide every
// name the deployed dist imports from them. #2311: a worker deploy refreshed
// dist/ but left a months-old node_modules/a2a-attestation in place; dist now
// imported `redactSecrets`, so dist/worker.js died at ESM link time
// ("does not provide an export named …") right after every other guard passed.
// handler-module-resolution only follows the handler graph, not dist/worker.js.
guard('workspace-dependency-exports', () => {
  const name = 'workspace-dependency-exports';
  if (!DEPLOYED_CHECK) {
    return ok(name, {
      checked: false,
      reason: 'deployed node_modules is only meaningful for a deployed worker root; use --deployed to require it',
    });
  }
  if (!existsSync(distRoot)) {
    return ok(name, {
      checked: false,
      reason: 'no dist/ under the worker root — nothing imports workspace packages (fixture or scripts-only tree)',
      distRoot,
    });
  }

  // package -> { subpaths: Map<subpath, Map<exportName, Set<importer>>> }
  const required = new Map();
  const files = listDistJsFiles(distRoot);
  for (const file of files) {
    const content = readFileSafe(file);
    if (content === undefined) continue;
    for (const { specifier, names } of parseWorkspaceImports(content)) {
      const { packageName, subpath } = splitPackageSpecifier(specifier);
      if (!required.has(packageName)) required.set(packageName, new Map());
      const bySubpath = required.get(packageName);
      if (!bySubpath.has(subpath)) bySubpath.set(subpath, new Map());
      const byName = bySubpath.get(subpath);
      for (const exportName of names) {
        if (!byName.has(exportName)) byName.set(exportName, new Set());
        byName.get(exportName).add(relative(distRoot, file));
      }
    }
  }

  if (required.size === 0) {
    return ok(name, { checked: true, distRoot, scannedFiles: files.length, packages: [] });
  }

  // Node resolves bare specifiers from the importer's REAL path, so walk up
  // from the realpath of dist/ (matters when dist/ is a symlinked release dir).
  let lookupRoot = distRoot;
  try {
    lookupRoot = realpathSync(distRoot);
  } catch {
    lookupRoot = distRoot;
  }
  const packages = [];
  const probeEntries = [];
  for (const packageName of [...required.keys()].sort()) {
    const packageDir = findPackageDir(lookupRoot, packageName);
    for (const [subpath, byName] of [...required.get(packageName)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const record = {
        package: packageName,
        ...(subpath !== '.' ? { subpath } : {}),
        requiredNames: byName.size,
      };
      packages.push(record);
      if (!packageDir) {
        record.ok = false;
        record.error = `package not installed: node_modules/${packageName} not found from ${lookupRoot}`;
        continue;
      }
      record.packageDir = packageDir;
      const entry = resolvePackageEntry(packageDir, subpath);
      if (entry.error) {
        record.ok = false;
        record.error = entry.error;
        continue;
      }
      record.entry = entry.entryPath;
      record.version = entry.version;
      record.key = `${packageName}\u0000${subpath}`;
      record.byName = byName;
      probeEntries.push({ key: record.key, entryPath: entry.entryPath });
    }
  }

  if (probeEntries.length > 0) {
    const probe = probeModuleExports(probeEntries);
    for (const record of packages) {
      if (!record.key) continue;
      const result = probe.results?.[record.key];
      if (!result) {
        record.ok = false;
        record.error = probe.error ?? 'export probe returned no result';
        if (probe.stderrTail) record.stderrTail = probe.stderrTail;
      } else if (!result.ok) {
        record.ok = false;
        record.error = `package entry failed to import: ${result.error}`;
      } else {
        const available = new Set(result.names);
        const missing = [...record.byName.keys()].filter((exportName) => !available.has(exportName)).sort();
        record.ok = missing.length === 0;
        if (missing.length > 0) {
          record.missingExports = missing;
          record.importers = Object.fromEntries(missing.map((exportName) => [
            exportName,
            [...record.byName.get(exportName)].sort().slice(0, 3),
          ]));
        }
      }
    }
  }
  for (const record of packages) {
    delete record.key;
    delete record.byName;
  }

  const failed = packages.filter((record) => !record.ok);
  if (failed.length > 0) {
    const summary = failed.map((record) => (record.missingExports
      ? `${record.package}: missing ${record.missingExports.join(', ')}`
      : `${record.package}: ${record.error}`)).join('; ');
    return fail(name, `deployed workspace packages do not satisfy dist imports — ${summary}`, {
      distRoot,
      scannedFiles: files.length,
      packages,
      hint: 'node_modules workspace packages are stale or missing. Rebuild each from the same commit as dist (npm run build -w packages/<pkg>) and sync its dist/, src/, scripts/ and package.json (plus anything else its package.json "files" lists) into <worker root>/node_modules/<package name> before restarting the worker.',
    });
  }
  return ok(name, { checked: true, distRoot, scannedFiles: files.length, packages });
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
// #2461: host patch bridge slots (A2A_PIRI_BIN, A2A_PIRI_PATCH_BIN) are checked too,
// and the guard reports which slot the handler effectively selects per lane, so a
// drift that only affects the slot actually being run cannot hide behind a
// harmless one (a Termux worker kept running a live checkout through
// A2A_PIRI_ANALYSIS_BIN / A2A_PIRI_PATCH_BIN after OPENCLAW_BIN was realigned).
function effectiveSummary(selection, checks) {
  const outsideFor = (name) => checks.find((check) => check.name === name)?.outsideWorkerRoot;
  const analysisOutside = selection.analysis.name ? outsideFor(selection.analysis.name) : undefined;
  const patchOutside = selection.patch.name ? outsideFor(selection.patch.name) : undefined;
  return {
    analysis: {
      slot: selection.analysis.name,
      selectedBy: selection.analysis.selectedBy,
      ...(selection.analysis.literalUnsetToken ? { literalUnsetToken: true } : {}),
      ...(selection.analysis.runtime ? { runtime: selection.analysis.runtime } : {}),
      ...(selection.analysis.declaredAdapter ? { declaredAdapter: selection.analysis.declaredAdapter } : {}),
      adapterMismatch: selection.analysis.adapterMismatch,
      ...(analysisOutside !== undefined ? { outsideWorkerRoot: analysisOutside } : {}),
    },
    patch: {
      slot: selection.patch.name,
      ...(selection.patch.literalUnsetToken ? { literalUnsetToken: true } : {}),
      disabled: selection.patch.disabled,
      ...(patchOutside !== undefined ? { outsideWorkerRoot: patchOutside } : {}),
    },
  };
}

function shadowedBridgeNote(check, selection) {
  const notes = [];
  if (check.roles.includes('analysis')) {
    notes.push(`analysis lane uses ${selection.analysis.name ?? 'the in-repo default bridge'}`);
  }
  if (check.roles.includes('patch')) {
    notes.push(selection.patch.disabled ? 'host patch bridge is disabled' : `patch lane uses ${selection.patch.name}`);
  }
  return notes.join('; ');
}

function outsideRootWarning(check, selection) {
  const prefix = `${check.name} points outside the worker root (${check.resolvedPath})`;
  if (check.effectiveFor?.length) {
    return `${prefix} and is the effective ${check.effectiveFor.join('+')} bridge the handler runs; artifact rollouts will not update it (#2429, #2461)`;
  }
  return `${prefix}; not selected now (${shadowedBridgeNote(check, selection)}), but artifact rollouts will not update it if it becomes effective (#2429)`;
}

// Warnings about the selection itself, independent of which slots exist.
function selectionWarnings(selection) {
  const warnings = [];
  for (const lane of ['analysis', 'patch']) {
    const { name, literalUnsetToken } = selection[lane];
    if (literalUnsetToken) {
      warnings.push(`${name} is set to the literal "${literalUnsetToken}"; the handler does not treat it as unset and selects it as the ${lane} bridge command, which fails at spawn — remove the line instead (#2461)`);
    }
  }
  // #2370 mirror: the handler refuses analysis tasks when the declared adapter
  // and the selected bridge's runtime contradict each other.
  if (selection.analysis.adapterMismatch) {
    warnings.push(`declared bridge adapter ${selection.analysis.declaredAdapter} has no matching *_ANALYSIS_BIN slot; the handler resolves ${selection.analysis.name ?? 'the in-repo default bridge'} (${selection.analysis.runtime}) and refuses analysis tasks with analysis_bridge_adapter_mismatch (#2370)`);
  }
  return warnings;
}

guard('configured-analysis-bridge-artifacts', () => {
  const configured = configuredBridgeBins();
  const selection = selectEffectiveBridges(effectiveBridgeEnvValues());
  if (configured.length === 0) {
    const warnings = selectionWarnings(selection);
    return ok('configured-analysis-bridge-artifacts', {
      checked: false,
      reason: 'no A2A_*_ANALYSIS_BIN/A2A_PIRI_BIN/A2A_PIRI_PATCH_BIN/OPENCLAW_BIN bridge command configured in process env or deployed env file',
      effective: effectiveSummary(selection, []),
      ...(warnings.length ? { warnings } : {}),
      envPathChecked: deployedEnvPath ? '<configured>' : undefined,
    });
  }

  const checks = configured.map((item) => {
    const effectiveFor = [
      ...(selection.analysis.name === item.name ? ['analysis'] : []),
      ...(selection.patch.name === item.name ? ['patch'] : []),
    ];
    const base = {
      name: item.name,
      roles: item.roles,
      ...(effectiveFor.length ? { effectiveFor } : {}),
      source: item.source,
    };
    if (!isScriptBridgeCommand(item.value)) {
      return {
        ...base,
        commandKind: 'external-command',
        commandName: basename(item.value),
        ok: true,
      };
    }
    const resolvedPath = resolveConfiguredBridgeCommand(item.value);
    const mode = executableBits(resolvedPath);
    const outsideWorkerRoot = isOutsideWorkerRoot(resolvedPath);
    return {
      ...base,
      commandKind: 'script-bridge',
      commandName: basename(item.value),
      resolvedPath,
      mode: executableHint(mode),
      ...(outsideWorkerRoot !== undefined ? { outsideWorkerRoot } : {}),
      ok: mode !== undefined && mode !== 0,
    };
  });
  const effective = effectiveSummary(selection, checks);

  // Analysis slots fail closed (unchanged). Patch-only slots were never checked
  // before #2461, so a broken one only warns: the host patch lane may be
  // unused on a node, and the guard must not newly block existing rollouts.
  const failed = checks.filter((check) => !check.ok && check.roles.includes('analysis'));
  if (failed.length > 0) {
    return fail('configured-analysis-bridge-artifacts', 'one or more configured analysis bridge script artifacts are missing or not executable', {
      failed,
      effective,
      ...(selectionWarnings(selection).length ? { warnings: selectionWarnings(selection) } : {}),
      hint: 'point node env at a deployed standard bridge such as scripts/source-only-local-analysis-bridge.mjs or scripts/hermes-a2a-analysis-bridge.mjs, or ship the custom bridge with the artifact',
      envPathChecked: deployedEnvPath ? '<configured>' : undefined,
    });
  }

  const warnings = checks
    .filter((check) => !check.ok)
    .map((check) => `${check.name} (host patch bridge${check.effectiveFor?.includes('patch') ? ', effective' : ''}) is missing or not executable (${check.resolvedPath}); patch tasks that select it fail at spawn (#2461)`);

  // #2429: a bridge that lives outside the worker root is not refreshed by an
  // artifact rollout (worker-artifact-pack + rsync), so the node silently runs
  // whatever revision that other checkout happens to be at. One Termux worker ran a
  // live git checkout 229 commits behind main this way. Warn by default; the
  // strict knob fails the guard so a rollout gate can refuse the drift.
  const drifted = checks.filter((check) => check.outsideWorkerRoot === true);
  warnings.push(...drifted.map((check) => outsideRootWarning(check, selection)));

  warnings.push(...selectionWarnings(selection));

  if (drifted.length > 0 && STRICT_BRIDGE_ROOT) {
    return fail('configured-analysis-bridge-artifacts', 'one or more configured analysis or patch bridge scripts live outside the worker root (A2A_ROLLOUT_GUARD_STRICT_BRIDGE_ROOT=1)', {
      failed: drifted,
      effective,
      warnings,
      hint: 'point the bridge env vars at <worker root>/scripts/<bridge>.mjs so fleet artifact rollouts reach the analysis and patch code (#2429, #2461)',
      envPathChecked: deployedEnvPath ? '<configured>' : undefined,
    });
  }

  return ok('configured-analysis-bridge-artifacts', {
    checks,
    effective,
    ...(warnings.length ? { warnings } : {}),
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
    A2A_PIRI_PATCH_BIN: envPresence('A2A_PIRI_PATCH_BIN'),
    OPENCLAW_BIN: envPresence('OPENCLAW_BIN'),
    A2A_DANSO_ANALYSIS_BIN: envPresence('A2A_DANSO_ANALYSIS_BIN'),
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

// Guard: deployed build-info provenance (#2423). Overwrite deploys leave a
// stale dist/build-info.json when the packer omits it; RB-416 treats
// build-info.revision as the deploy-version authority, so --deployed must
// require a clean 40-hex revision (never missing, never `-dirty`).
const CLEAN_REVISION_RE = /^[0-9a-f]{40}$/i;

guard('deployed-build-info', () => {
  if (!DEPLOYED_CHECK) {
    return ok('deployed-build-info', {
      checked: false,
      reason: 'deployed build-info is only required for a deployed worker root; use --deployed to require it',
    });
  }

  const buildInfoPath = join(distRoot, 'build-info.json');
  if (!existsSync(buildInfoPath)) {
    return fail('deployed-build-info', `dist/build-info.json missing: ${buildInfoPath}`, {
      hint: 're-pack with worker-artifact-pack.mjs so dist/build-info.json is always in the closure (#2423)',
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(buildInfoPath, 'utf8'));
  } catch (error) {
    return fail('deployed-build-info', `dist/build-info.json unreadable: ${buildInfoPath}`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const revision = typeof parsed?.revision === 'string' ? parsed.revision.trim() : '';
  if (!revision) {
    return fail('deployed-build-info', 'dist/build-info.json has no revision field', {
      path: buildInfoPath,
    });
  }
  if (revision.includes('-dirty') || !CLEAN_REVISION_RE.test(revision)) {
    return fail(
      'deployed-build-info',
      `dist/build-info.json revision must be a clean 40-hex SHA (not -dirty), got "${revision}"`,
      { path: buildInfoPath, revision },
    );
  }

  const targetRevision = normalizeConfiguredEnvValue(process.env.A2A_WORKER_TARGET_REVISION ?? '');
  if (targetRevision && targetRevision.toLowerCase() !== revision.toLowerCase()) {
    return fail(
      'deployed-build-info',
      `dist/build-info.json revision=${revision} does not match A2A_WORKER_TARGET_REVISION=${targetRevision}`,
      { path: buildInfoPath, revision, targetRevision },
    );
  }

  return ok('deployed-build-info', {
    path: buildInfoPath,
    revision,
    targetRevision: targetRevision || undefined,
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
