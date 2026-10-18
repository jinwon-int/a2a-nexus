export const CLAUDE_FINALIZER_ALLOWED_TOOLS = "Read Glob Grep";
export const CLAUDE_FINALIZER_DISALLOWED_TOOLS = "Bash Edit Write NotebookEdit WebFetch WebSearch";
export const HERMES_FINALIZER_TOOLSETS = "safe";

// Read-only tools a caller may add on top of the finalizer set (#2390). Skill
// only loads procedure text; it cannot write, run commands or reach the web.
// Anything else (and anything in the disallowed set) is ignored, never added.
export const CLAUDE_FINALIZER_OPTIONAL_TOOLS = Object.freeze(["Skill"]);

export function buildClaudeFinalizerToolArgs({ extraAllowedTools = [] } = {}) {
  const disallowed = new Set(CLAUDE_FINALIZER_DISALLOWED_TOOLS.split(" "));
  const extras = [...new Set(extraAllowedTools)].filter(
    (tool) => CLAUDE_FINALIZER_OPTIONAL_TOOLS.includes(tool) && !disallowed.has(tool),
  );
  return [
    "--allowedTools", [CLAUDE_FINALIZER_ALLOWED_TOOLS, ...extras].join(" "),
    "--disallowedTools", CLAUDE_FINALIZER_DISALLOWED_TOOLS,
  ];
}
