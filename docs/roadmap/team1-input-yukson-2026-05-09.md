# Team1 Roadmap Input: workerDelta

Parent roadmap: #105 (a2a-plane#105, internal tracker private)
Child issue: #109 (a2a-plane#109, internal tracker private)
Angle: libero/independent review of sequencing, risk prioritization, governance, and what to deliberately not build yet.

## North-star

`a2a-plane` should be the public, boring, auditable control plane for agent-to-agent task handoff: task lifecycle contracts, broker/worker APIs, worker capability registration, isolated runner semantics, and redacted terminal evidence. Its job is to make task dispatch understandable, reproducible, and safe across integrations without depending on OpenClaw-specific runtime behavior or private operator infrastructure.

The project should optimize for three outcomes:

1. **Clear task truth:** every task has one lifecycle, one terminal evidence model, and explicit ownership at each transition.
2. **Composable integrations:** OpenClaw remains the reference integration, but the contracts and broker semantics should be usable by other requesters and workers.
3. **Fail-closed operations:** public examples, CI, and docs should prove local/offline behavior first; production activation remains an operator-controlled layer outside the public repo.

## Non-goals

Keep these out of `a2a-plane` for now:

- Private source-repo history, unsanitized implementation notes, raw transcripts, provider payloads, host paths, credentials, or topology details.
- Operator-only activation flows: repository visibility changes, production deploy/restart runbooks, terminal ACK execution, provider/Telegram sends, and database mutation tooling.
- A general-purpose agent marketplace, scheduler, chat UI, or workflow automation product. The plane should route and evidence tasks, not become the whole operator stack.
- Policy decisions that require human authority, such as public-readiness approval, secret disposition, worker trust admission, or override of fail-closed gates.
- Multi-tenant untrusted execution until capability boundaries, artifact hygiene, runner isolation, and abuse controls are documented and tested.

## 30/90/180-day roadmap

### Next 30 days: make the private candidate reviewable and governable

- Close the public-readiness blockers without changing visibility: external secret/history scan evidence, upstream Terminal Brief receipt proof, and explicit operator approval separation.
- Freeze a small contract surface for task lifecycle, terminal evidence, worker registration, and capability vocabulary.
- Add a roadmap/governance page defining decision owners, GO/NO-GO labels, and what evidence is acceptable in public issues and PRs.
- Improve local-only quickstart confidence: one broker, one dummy worker, one Docker runner patch task, and one terminal `Done`/`Block` evidence example using sanitized fixtures.
- Document the import boundary from private source repos into `a2a-plane`: sanitized/squash imports only, with private repos retained as rollback/source references.

### Next 90 days: harden the public API and reference implementation

- Version the HTTP/JSON-RPC contract and compatibility matrix with explicit broker, runner, plugin, and fixture baselines.
- Add conformance tests for worker registration, task state transitions, cancellation, terminal evidence, and idempotent result reporting.
- Build a redacted artifact schema for PR/Done/Block evidence so workers can attach useful proof without leaking runtime context.
- Define a worker trust model: local trusted workers first, then named internal workers, then a future design for external workers. Do not jump straight to open federation.
- Split reference integration docs from core plane docs so OpenClaw is clearly an adapter, not a prerequisite or hidden dependency.

### Next 180 days: prepare cautious extensibility, not broad federation

- Publish a stable v0 compatibility profile with deprecation rules and migration notes.
- Add a minimal capability registry that helps requesters choose workers by declared skills, constraints, and evidence expectations, not by private identity assumptions.
- Introduce signed or attestable terminal evidence only after the plain evidence model is stable and understood.
- Prototype cross-broker handoff in a private/offline fixture lane before any live public or cross-operator use.
- Create an operator readiness checklist for production adoption that remains separate from the public repo quickstart.

## Top 5 risks/blockers and gates

1. **Secret/history leakage.** Gate: external scanner evidence is clean or explicitly dispositioned, and public-readiness scan passes on the exact candidate commit.
2. **Terminal evidence ambiguity.** Gate: provider acceptance, requester-visible receipt, `Done`, `Block`, and PR evidence are contractually distinct and tested.
3. **Governance bypass.** Gate: visibility approval, deployment, terminal ACK activation, and production mutation require explicit operator approval outside normal PR merge flow.
4. **OpenClaw coupling.** Gate: docs and tests prove the broker/worker contracts work with generic fixtures; OpenClaw remains a reference adapter.
5. **Runner trust expansion too early.** Gate: no untrusted/multi-tenant runner claims until isolation, artifact redaction, network policy, and abuse handling have tests and documented limits.

## Suggested next GitHub epics/issues

- **Epic: Public-readiness closeout evidence.** Track external scanner installation/results, upstream receipt proof, and separated operator visibility approval.
- **Epic: Contract v0 freeze.** Lock task lifecycle, terminal evidence, worker registration, cancellation, and compatibility-baseline semantics.
- **Issue: Governance and evidence policy page.** Define Start/PR/Done/Block markers, redaction rules, approval boundaries, and fail-closed behavior.
- **Issue: Local conformance fixture suite.** Add offline tests covering broker task creation, worker claim/report, cancellation, and terminal evidence idempotency.
- **Issue: Capability registry v0 design.** Specify fields for worker capabilities, constraints, trust level, and evidence requirements without implementing broad federation.
- **Issue: Reference integration separation.** Reorganize docs so core `a2a-plane` concepts are independent from the OpenClaw adapter path.
- **Issue: Runner artifact hygiene.** Define what files may enter PR branches and evidence, including explicit guards for runtime/bootstrap context files.

## If we can only do one thing next

Freeze and test the terminal task/evidence contract before building more features. A small, boring contract that reliably distinguishes assignment, worker claim, cancellation, `Done`, `Block`, PR evidence, provider acceptance, and requester-visible receipt will make every later roadmap item safer. Without that, capability registries, cross-broker handoff, public demos, and production activation will all inherit ambiguous semantics and force governance decisions into ad hoc comments.
