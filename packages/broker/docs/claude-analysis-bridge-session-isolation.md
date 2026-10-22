# Claude analysis bridge — host-context isolation (#2422)

`scripts/claude-a2a-analysis-bridge.mjs` runs each analysis lane as a
`claude -p` child of the worker account. Claude Code loads that account's
**user context** by default, and nothing in the lane asked for it:

| Loaded by default | Measured effect in a lane (2026-10-22, Claude Code 2.1.305) |
|---|---|
| `~/.claude/CLAUDE.md` | injected twice per session on every Claude worker (on the user-harness worker: a 12 KB unfilled per-node template) |
| `~/.claude/settings.json` hooks | on the two root-harness workers the ccc-node SessionStart hooks injected node session memory, Wiki prefetch and the tool cheatsheet (10 KB + 25 KB + 55 KB lines) and the SessionEnd `distill.sh` ran per lane session (skipped only by `distill.scope`) |
| `~/.claude/skills` | every host skill listed in the system prompt |
| user MCP servers | tool schemas the lane can never call (tool policy is `Read Glob Grep [Skill]`) |

Two lanes reviewing the same task on two nodes therefore received different
inputs, operator instructions ("Standing Orders", approval gates) sat next to
the lane prompt, and node configuration text could leak into findings.

## What the bridge does now

Every spawned `claude -p` gets two extra arguments:

```
--setting-sources project --strict-mcp-config
```

Measured with a local capture server (no provider call; `CLAUDE_CONFIG_DIR`
pointed at a fixture with a marker CLAUDE.md, a marker SessionStart hook and a
marker skill):

| Variant | user CLAUDE.md | user hook msg | hook ran | user skill | project skill (`<cwd>/.claude/skills`) |
|---|---|---|---|---|---|
| default (`user,project,local`) | 7/7 requests | 7/7 | yes | listed | listed |
| `--setting-sources project` | 0 | 0 | **no** | not listed | **listed** |
| `--setting-sources local` | 0 | 0 | no | not listed | not listed |
| `--bare` | 0 | 0 | no | — | — (but OAuth is never read → unusable for the fleet) |
| empty `CLAUDE_CONFIG_DIR` | 0 | 0 | no | — | — |

`project` is the one source that is both free of host context and still able
to see a skill the bridge places into the session workspace. The workspace is
a bridge-owned `mkdtemp` directory that nothing else writes to, so `project`
cannot pick up attacker-controlled settings.

### Lane review skill (#2390)

The lane review skill (`A2A_ANALYSIS_LANE_SKILL_HINTS=1`, lane →
`LANE_SKILL_HINTS`) is installed in the user skills root, which the isolated
sources no longer show. When the hint resolves and the effective sources do
not include `user`, the bridge copies `<skills root>/<skill>/` into
`<workspace>/.claude/skills/<skill>/` before spawning claude (regular files
only, symlinks refused, at most 200 files / 2 MiB). If the copy is refused the
bridge writes one bounded stderr line
(`lane skill "<name>" not materialized (<reason>); continuing without the Skill tool`)
and does not allow the Skill tool; the prompt's hint line already tells the
model to continue without it.

## Operator knobs

| Env | Default | Meaning |
|---|---|---|
| `A2A_CLAUDE_SETTING_SOURCES` | `project` | Comma list of `user`, `project`, `local` passed to `--setting-sources` (canonical order, de-duplicated). An invalid value is ignored with a stderr note and the default applies. |
| `A2A_CLAUDE_SETTING_SOURCES=user,project,local` | — | Pre-#2422 behaviour: host hooks, CLAUDE.md, skills visible again; the lane skill is then not copied (it is already visible). `CCC_DISTILL_RESUME_POLICY=skip:a2a-lane` (#2383) still protects the owner's resume.md in that mode. |

`--strict-mcp-config` is not configurable: the lane tool policy never allows
an MCP tool, so loading the servers only costs tokens.

## Verifying on a node (read-only)

Transcripts of lane sessions live under the worker account's
`~/.claude/projects/-tmp-a2a-analysis-*/*.jsonl` (handler-cwd sessions under
`-opt-a2a-broker-worker`). After the rollout every new transcript must count
zero for each marker:

```bash
f=<newest lane jsonl>
grep -c "Contents of $HOME/.claude/CLAUDE.md" "$f"      # user CLAUDE.md
grep -c "session memory (auto-injected" "$f"           # ccc-node SessionStart hook output
grep -c "load-memory" "$f"
```

The `distill.log` of a root-harness node must stop gaining
`a2a-analysis` entries. A single read-only lane canary after the rollout
confirms OAuth still works (`succeeded`, `completion.marked=true`).

## Rollback

Set `A2A_CLAUDE_SETTING_SOURCES=user,project,local` in the worker env file and
restart the worker (idle gate applies); no code change needed.
