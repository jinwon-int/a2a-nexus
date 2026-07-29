// Shared resolution of operator-configured Claude CLI runtime flags for the A2A
// Claude Code bridges (analysis + patch).
//
// Why this exists: an A2A task payload carries a *broker-namespace* model string
// (e.g. "claude-code/default") which is not a valid Claude CLI model id. Passing
// it straight through as `--model` breaks the child process, so the analysis
// bridge historically passed no `--model` at all and recorded the configured
// model as telemetry only. The cost was that an operator who pinned a model in
// the node env got no enforcement: submitted evidence could name a model the run
// never actually used, and the effective model silently followed whatever the
// node's global Claude Code default happened to be.
//
// The resolution below keeps the original guard - namespaced values are rejected
// - and only accepts values that look like real Claude model ids or aliases, so
// the broker-supplied string still cannot choose the model. What changes is that
// an operator-supplied value is now applied instead of merely reported.

export const CLAUDE_MODEL_ALIASES = new Set(["sonnet", "opus", "haiku", "fable"]);
export const CLAUDE_EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

function safeText(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

// Precedence: task-supplied model first (kept for parity with the patch bridge),
// then the operator-controlled node env. Namespaced values ("vendor/model") are
// skipped rather than rejected outright so a broker-namespace string falls
// through to the env value instead of disabling model pinning entirely.
export function resolveExplicitClaudeModel(flags, env = process.env) {
  const candidates = [safeText(flags?.model, ""), safeText(env.A2A_CLAUDE_MODEL, "")];
  for (const candidate of candidates) {
    const value = candidate.trim();
    if (!value || value.includes("/")) continue;
    const normalized = value.toLowerCase();
    if (normalized.startsWith("claude-") || CLAUDE_MODEL_ALIASES.has(normalized)) return value;
  }
  return "";
}

// Opt-in only, via a dedicated A2A variable.
//
// `CLAUDE_CODE_EFFORT_LEVEL` is deliberately NOT consulted here: it is a Claude
// Code env var a node may already set for unrelated reasons, and older Claude
// CLI builds reject an unknown `--effort` flag outright. Emitting the flag has
// to stay an explicit per-node decision so upgrading this bridge cannot break a
// worker whose CLI predates the flag.
export function resolveExplicitClaudeEffort(env = process.env) {
  const value = safeText(env.A2A_CLAUDE_EFFORT, "").trim().toLowerCase();
  return CLAUDE_EFFORT_LEVELS.has(value) ? value : "";
}

// Argument fragment shared by both bridges. Empty when nothing is configured, so
// a node that pins neither keeps today's exact command line.
export function buildClaudeRuntimeArgs(flags, env = process.env) {
  const model = resolveExplicitClaudeModel(flags, env);
  const effort = resolveExplicitClaudeEffort(env);
  return [
    ...(model ? ["--model", model] : []),
    ...(effort ? ["--effort", effort] : []),
  ];
}
