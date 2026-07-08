export const CLAUDE_FINALIZER_ALLOWED_TOOLS = "Read Glob Grep";
export const CLAUDE_FINALIZER_DISALLOWED_TOOLS = "Bash Edit Write NotebookEdit WebFetch WebSearch";
export const HERMES_FINALIZER_TOOLSETS = "safe";

export function buildClaudeFinalizerToolArgs() {
  return [
    "--allowedTools", CLAUDE_FINALIZER_ALLOWED_TOOLS,
    "--disallowedTools", CLAUDE_FINALIZER_DISALLOWED_TOOLS,
  ];
}
