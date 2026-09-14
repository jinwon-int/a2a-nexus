# Integrating the agent manual into an agent workflow

The canonical usage entry point is [agent-manual.md](agent-manual.md).
The root README, documentation index and dispatch CLI `--help` route agents
there. An external agent that does not read those surfaces will not
necessarily discover the manual automatically.

In the host's existing agent instructions, Nexus skill or dispatch runbook,
use this short instruction instead of copying the full manual:

> Before using A2A Nexus, read `docs/agent-manual.md` from the same Nexus
> checkout revision as the tools you will execute. If you do not yet have a
> checkout, start at
> https://github.com/jinwon-int/a2a-nexus/blob/main/docs/agent-manual.md,
> then select the installed revision before applying commands. Follow the
> relevant lane reference. Re-read after an update or a version mismatch;
> do not substitute remembered flags. When changing Nexus usage, update the
> manual and the detailed reference in the same PR.

Use the environment's normal instruction/skill deployment process. Keep
private broker inventory and credential handling local; do not publish those
instructions or runtime memory in this repository.

## Bootstrap compatibility

Do not install a tracked root `AGENTS.md` as a shortcut in this repository.
Current Docker runner pre-command and pre-PR guards reject bootstrap files in
ordinary patch lanes. A public-content exception in a documentation scanner
alone would not change those guards or older installed runners.

Automatic host-instruction loading requires an integration that actually reads
that host's instructions. Repository links provide discovery; they do not
prove every Codex, Claude, Hermes, piri or other agent has loaded the manual.
Changing that runtime contract needs source tests and installed-runner
compatibility verification before enabling it. Keep this document as the
stable integration pointer meanwhile.
