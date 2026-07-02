# A2A Analysis-Only / Read-Only Task Mode

## Overview

The analysis-only mode is a safe, read-only A2A task execution path that allows
tasks to complete with Start+Done/Block evidence **without requiring a patch or
pull request**. This mode is designed for analysis agents (e.g., `workergamma`
thesis agent) that produce findings, summaries, and risk assessments but never
modify code.

## Design

### Intent and Mode Detection

- **Intent:** `analyze`
- **Mode (payload.mode):** `analysis-only`, `read-only-analysis`, or `analyze-only`
- **A2A evidence aliases:** `analyze` tasks with `payload.noLive=true`,
  `payload.sourceOnly=true`, and an A2A/evidence/analysis-shaped mode, phase,
  or role are also treated as read-only analysis tasks.

The explicit mode name remains the normal gating factor. Unknown analyze modes
still fall through to the generic builtin handler unless the payload is clearly
marked as no-live/source-only A2A evidence. This prevents ordinary generic tasks
from pretending that analysis occurred.

### Evidence Contract

| Evidence Field       | Required? | Notes                                                      |
|----------------------|-----------|------------------------------------------------------------|
| `prUrl`              | **No**    | Analysis-only tasks never produce pull requests            |
| `doneCommentUrl`     | Optional  | URL pointing to a Done comment (e.g., GitHub issue)        |
| `blockCommentUrl`    | Optional  | URL pointing to a Block comment                            |
| `startCommentUrl`    | Optional  | URL pointing to a Start marker comment                     |

Analysis bridge model output is not trusted to invent comment URLs. When durable
GitHub evidence comments are required, the handler posts them itself only when
all of the following are true:

- `A2A_POST_ANALYSIS_EVIDENCE_COMMENTS=1` is set in the handler environment.
- The task payload explicitly sets `postGithubComment: true`.
- The task payload carries a GitHub issue target via `issueUrl`, `githubIssueUrl`,
  `parentIssueUrl`, an issue URL in `evidenceRefs`, or `repo` + `issue`.
- GitHub auth is available in the process environment.
- The task does not set `noGitHubComment: true`.

The handler adds an idempotency marker of the form
`<!-- a2a-analysis-evidence:<taskId>:done|blocked -->`; retries reuse an existing
matching comment instead of creating duplicates.
| `findings`           | Optional  | Array of analysis findings                                 |
| `risks`              | Optional  | Array of identified risks                                  |
| `recommendations`    | Optional  | Array of recommended next steps                            |
| `evidenceRefs`       | Optional  | Array of task, issue, run, log, or artifact references      |
| `artifacts`          | Optional  | Array of analysis artifact references                      |
| `analysisSummary`    | Recommended | Human-readable summary of the analysis                  |

When `blockCommentUrl` is present, the task outcome is reported as **Blocked**
rather than **Done**.

### Optional OpenClaw / Hermes Analysis Bridge

By default, analysis tasks use the builtin structured handler and only transform
task payload data into evidence output. That default path is intentionally
credential-free and deterministic, but it cannot inspect a repository or produce
new model-backed design judgment by itself.

Operators can explicitly opt in to a task-scoped model bridge by setting
`A2A_OPENCLAW_ANALYSIS_ENABLED=1` and configuring `A2A_OPENCLAW_ANALYSIS_BIN`, `OPENCLAW_BIN`, or the normal
OpenClaw bridge environment. On Hermes workers that do not have the OpenClaw CLI,
use the bundled OpenClaw-compatible Hermes bridge:

```bash
A2A_OPENCLAW_ANALYSIS_ENABLED=1
A2A_OPENCLAW_BRIDGE_ENABLED=1
A2A_OPENCLAW_ANALYSIS_BIN=/opt/a2a-broker-worker/current/scripts/hermes-a2a-analysis-bridge.mjs
# Keep OPENCLAW_BIN on its existing patch/A2AD runtime if already configured.
HERMES_BIN=hermes
A2A_HERMES_ANALYSIS_TOOLSETS=safe
A2A_ANALYSIS_REPO_MAP_JSON='{"jinwon-int/a2a-broker":"/opt/a2a-broker","jinwon-int/seo-web-bridge":"/root/work/github/seo-web-bridge"}'
# Keep the final `hermes chat -q` prompt below OS per-argv limits (Linux
# MAX_ARG_STRLEN is 128 KiB). The bridge defaults to 96 KiB and truncates with a
# prompt-budget warning rather than failing with E2BIG.
A2A_HERMES_ANALYSIS_MAX_PROMPT_BYTES=98304
```

The Hermes bridge accepts the existing `OPENCLAW_BIN agent --message ... --json`
contract, extracts `Payload JSON`, reads only allowlisted repo-relative paths from
`A2A_ANALYSIS_REPO_MAP_JSON`, calls `hermes chat -q`, validates that Hermes returns
JSON, and then wraps that JSON as an OpenClaw-style envelope:

```json
{"payloads":[{"text":"{\"status\":\"done\",\"summary\":\"...\",\"findings\":[\"...\"]}"}]}
```

Task payloads should include source hints when model-backed analysis is expected:

```json
{
  "mode": "analysis-only",
  "noLive": true,
  "sourceOnly": true,
  "repo": "jinwon-int/seo-web-bridge",
  "path": "runtime/app-src/app_chat.py"
}
```

Supported path hint fields include `path`, `paths`, `file`, `files`,
`sourcePath`, `sourcePaths`, `analysisPath`, `analysisPaths`, `targetPath`,
`targetPaths`, `targetFile`, `targetFiles`, `evidencePath`, and `evidencePaths`.
Paths must be repo-relative; absolute paths and `..` traversal are rejected.

The bridge is still read-only: it receives a JSON-only analysis prompt and is
told not to modify files, deploy, restart services, send live provider messages,
acknowledge terminals, mutate databases, move credentials, commit, or open PRs.
If the bridge times out, fails, or does not return parseable JSON, the task fails
closed instead of returning generic acceptance.

### Finalizer Evidence Classification

Before a broker finalizer counts A2A/A2AD child output as worker reasoning, run the
structural classifier:

```bash
npm run a2ad_evidence_classifier -- --input /path/to/round-results.json --require-substantive --min-substantive 1
```

The classifier marks `analysis bridge blocked`, missing repo-root/source-map
failures, and wrapper/dry-run outputs as reportable plumbing evidence, not
substantive worker opinions. Finalizers must either fix the source mapping or run
a supplemental no-live/sourceOnly evidence packet before treating the round as a
substantive A2AD judgment.

### Safety Properties

1. **Read-only by design:** No code changes, no workspace modifications, no file
   writes. The builtin handler produces structured output from payload data only;
   the optional OpenClaw bridge is explicitly gated and task-scoped.
2. **No PR bypass:** The analysis-only path is logically separate from
   `propose_patch`. Tasks with intent `propose_patch` continue to require
   executor evidence (docker runner or OpenClaw bridge).
3. **Fail-closed bootstrap guard:** The existing `.openclaw/`, `AGENTS.md`,
   `SOUL.md`, etc. path checks are not weakened — they remain enforced in
   docker runner and OpenClaw bridge paths.
4. **Explicit exemption in completion validation:**
   `requiresGithubCompletionEvidence()` returns `false` for analysis-only
   tasks regardless of `taskOrigin`.

## Usage

### Task Payload Shape

```json
{
  "intent": "analyze",
  "payload": {
    "mode": "analysis-only",
    "summary": "BTC/USDT regime analysis",
    "doneCommentUrl": "https://github.com/owner/repo/issues/1#issuecomment-123",
    "startCommentUrl": "https://github.com/owner/repo/issues/1#issuecomment-456",
    "findings": ["bullish divergence on 4H", "volume confirmation"],
    "risks": ["weekend liquidity thinning"],
    "recommendations": ["watch funding reset before entering"],
    "evidenceRefs": ["issue-1", "task-abc"],
    "artifacts": ["analysis-20260509.json"]
  }
}
```

### Handler Output (Done)

```json
{
  "result": {
    "summary": "analysis-only completed: BTC/USDT regime analysis",
    "note": "analysis-only task completed with Done evidence (no PR required)",
    "lifecycle": {
      "intent": "analyze",
      "mode": "analysis-only",
      "taskId": "task-abc"
    },
    "output": {
      "analysisSummary": "BTC/USDT regime analysis",
      "doneCommentUrl": "https://github.com/owner/repo/issues/1#issuecomment-123",
      "startCommentUrl": "https://github.com/owner/repo/issues/1#issuecomment-456",
      "findings": ["bullish divergence on 4H", "volume confirmation"],
      "risks": ["weekend liquidity thinning"],
      "recommendations": ["watch funding reset before entering"],
      "evidenceRefs": ["issue-1", "task-abc"],
      "artifacts": ["analysis-20260509.json"]
    }
  }
}
```

### Handler Output (Blocked)

```json
{
  "result": {
    "summary": "analysis-only blocked: cannot complete analysis",
    "note": "analysis-only task blocked with Block evidence",
    "output": {
      "analysisSummary": "cannot complete analysis",
      "blockCommentUrl": "https://github.com/owner/repo/issues/1#issuecomment-999",
      "risks": ["data feed unavailable"]
    }
  }
}
```

## Regression Tests

Tests cover:

| Test | Location |
|------|----------|
| Handler produces Done evidence without PR | `src/openclaw-handler-artifact.test.ts` |
| Handler carries `doneCommentUrl` | `src/openclaw-handler-artifact.test.ts` |
| Handler produces Block evidence | `src/openclaw-handler-artifact.test.ts` |
| Handler preserves Start marker URL | `src/openclaw-handler-artifact.test.ts` |
| Alias modes (`read-only-analysis`) work | `src/openclaw-handler-artifact.test.ts` |
| No-live/source-only A2A evidence tasks avoid generic acceptance-only output | `src/openclaw-handler-artifact.test.ts` |
| Optional OpenClaw analysis bridge returns structured analysis evidence | `src/openclaw-handler-artifact.test.ts` |
| Hermes-backed OpenClaw-compatible bridge reads source and returns envelope | `scripts/hermes-a2a-analysis-bridge.test.mjs`, `src/openclaw-handler-artifact.test.ts` |
| A2AD evidence classifier blocks source-map failures and wrapper-only outputs from being counted as worker opinions | `scripts/a2ad-evidence-classifier.test.mjs` |
| Unknown mode falls through to generic | `src/openclaw-handler-artifact.test.ts` |
| Propose_patch evidence is preserved | `src/openclaw-handler-artifact.test.ts` |
| `validateTaskCompletionEvidence` skips analysis-only | `src/openclaw-handler-artifact.test.ts` |
| Worker completes analysis-only (api origin) | `src/worker.test.ts` |
| Worker completes analysis-only (github origin) | `src/worker.test.ts` |
| Worker fails propose_patch without PR | `src/worker.test.ts` |

## Related

- `scripts/a2a-task-handler.mjs` — Canonical worker handler implementation
- `scripts/a2a-task-handler.mjs` — Legacy compatibility wrapper
- `scripts/hermes-a2a-analysis-bridge.mjs` — Hermes-backed OpenClaw-compatible analysis bridge
- `src/core/github-task-completion.ts` — Completion evidence validation
- `docs/a2a-protocol.md` — A2A protocol reference
