# Phase 0 findings — piri delegation capability investigation (read-only)

Spec: `docs/specs/piri-lane-fanout-reuse/spec.md` (#1798 alternative path).
Investigation date: 2026-08-15. All evidence is read-only: piri repository
documentation and source on the local checkout, plus one no-live container
probe (file listing + `--version`) against a deployed runner image. No
network calls from the probe, no task dispatch, no spawn.

## Verdict

**A delegation mechanism exists.** The spec proceeds to Phase 1; it does not
close. The concrete invocation shape:

```bash
piri -e <subagent-extension-path> -t subagent,read,grep,find,ls -p "<patch prompt>"
```

## Evidence

### 1. Core has no built-in sub-agents — by design

Piri's README states: "**No sub-agents.** There's many ways to do this. Spawn
pi instances via tmux, or build your own with extensions, or install a package
that does it your way." (`docs/usage.md` repeats that print mode "intentionally
does not include built-in MCP, sub-agents…"). So the mechanism is not a
built-in — it is an extension surface.

### 2. The official subagent example extension

The piri repository ships a complete reference implementation at
`packages/coding-agent/examples/extensions/subagent/` (1,015 lines +
`agents.ts` + prompts + README):

- registers a tool named **`subagent`** (`pi.registerTool({ name: "subagent", ... })`);
- supports three delegation modes — **single** `{agent, task}`, **parallel**
  `{tasks[]}`, and **chain** `{chain[]}` (chained with `{previous}` output
  substitution);
- spawns an isolated `pi` process per invocation with a fresh context window
  and captures structured output via JSON mode;
- carries built-in ceilings: `MAX_PARALLEL_TASKS = 8`, `MAX_CONCURRENCY = 4`,
  `PER_TASK_OUTPUT_CAP = 50 * 1024` bytes. Note the alignment with the fanout
  stack's ceilings: the broker's hard cap is 4 agents including the worker
  (this extension's concurrency cap is exactly 4), and its per-task output cap
  (50KB) sits inside the broker's 1KB–60KB output bounds. Extension ceilings
  are convenience bounds, not authorization — Phase 1 must clamp them to the
  broker-authorized budget.

### 3. Roster equivalent — agent md with `model:` frontmatter

`agents.ts` discovers agents from markdown files with frontmatter
(`getAgentDir` + `parseFrontmatter`) in **user and project scopes**, with an
`AgentConfig` that includes `name`, `description`, `tools?`, **`model?`**, and
`systemPrompt`. This is the direct piri equivalent of the Claude Code
`~/.claude/agents/*.md` roster with `model:` frontmatter — the exact mechanism
WS2 was blocked on for the claude lane exists here too.

### 4. Headless wiring hooks

- `--extension <path>` (`-e`) loads an extension for the current run without a
  permanent install — the natural hook for a patch-lane script.
- `--tools <list>` (`-t`) allowlists "built-in, extension, and custom tools"
  in print mode, so the `subagent` tool can be enabled per-invocation the same
  way the claude lane allowlists `Task`.
- Extensions are supported in print mode (`-p`); TUI-only APIs are documented
  as no-ops there.

### 5. Deployed runner image state (no-live probe, 2026-08-15)

Probed a deployed `a2a-docker-runner-piri` image (pinned distribution tag
`v0.83.0-piri.1`; `piri --version` → `0.83.0`):

- the subagent example **is present in the image** under
  `examples/extensions/subagent/`;
- it is **not an active extension**: the piri checkout's own extension dir
  contains only unrelated development extensions, and the runtime user's
  config dir does not exist in the image.

So the mechanism ships with the lane image but is unwired — consistent with
Phase 2 being a wiring task, not a capability gap.

### 6. Lane constraints Phase 1 must respect

From the runner's piri patch command script (`buildPiriPatchCommandScript` in
`packages/docker-runner/src/config.ts`):

- the mounted secret config dir is copied to a container-local
  `/work/piri-home` and `HOME` is pointed at it — extension and roster files
  can travel via the image or the config copy, not the read-only secret mount;
- the lane installs a git/gh **lifecycle guard** that rejects mutations
  (`git add|commit|push|checkout|…` and `gh pr create|pr merge|issue close|issue
  comment`) — the lane is evidence-only by contract, and any spawned
  sub-agents inherit that guard because they run under the same `PATH`;
- the lane already has a prompt + output-schema contract (`-p` +
  `--output-schema`) that a fanout mode must compose with, not replace.

## Named gaps for Phase 1 (no hand-waving list)

1. The example extension is example-grade: its budget/roles inputs must come
   from the injected `A2A_CONTAINED_SUBAGENTS_*` env or the mounted context
   brief, and its ceilings must clamp to the broker-authorized budget.
2. Roster md files do not exist on any host (same finding as the claude-lane
   field check) — they must be authored from the normative roster mapping
   (`docs/specs/cc-worker-subagent-roster/`).
3. The child-invocation turn bound (a `--max-turns` equivalent for the spawned
   `pi` children) must be identified and bounded.
4. Composability of the `subagent` tool's structured output with the lane's
   final-answer `--output-schema` contract must be specified.

## Conclusion

Phase 0's success criterion is met on the "named mechanism with a concrete
invocation example" branch. Phase 1 (decider-reuse mapping) may proceed;
Phases 2–3 remain gated as written (default-off wiring, per-step operator
approval for any live spawn).
