# Stage-to-task binding contract (WavePlanDagV2)

Status: **adopted by operator ruling, 2026-09-14 (§11.1; a2a-nexus#1800)**.
Refs a2a-nexus#1800 remaining item 3 (duplicate-follow-up / stale-frontier
validation) and decision B-2 (stage↔task binding, held NOT-DECIDED since
2026-08-27, hold released by the same ruling). This document defines the
contract; it changes no code, no schema, no fixture, no flag, and authorizes
no activation. Acceptance of this draft, any implementation slice, and any
activation/rollout timing remain separate operator decisions (§11).

## 0. Landed anchors — cite, do not re-implement

Every mechanism below builds on slices already merged to `main`. They are
anchors, not work items:

| Anchor | PR / merge | What it pins |
| --- | --- | --- |
| Frozen V2 proposal/dry-run contract | #1710, review fix #1711 | `docs/specs/wave-plan-dag-v2/spec.md` §1–§7 (closed schema, digests, fail-closed boundary). **Unchanged by this document.** |
| Slice 1 — admission + deterministic dry-run | #1992 / `67629c44` | `packages/broker/src/wave-plan-dag-v2/` (`manifest.ts`, `dry-run.ts`, `digest.ts`, `errors.ts`): closed admission, §5 reason vocabulary, §6 framed digests, pure read-only rehearsal. |
| Slice 2 — record-only observation | #1993 / `199a6132` | `observe.ts`: mode union closed at `off` + `record_only`, `off` default, bounded public/operator diagnostics (clamped counts + closed enums), no acting variant. |
| Slice 3 — versioned dispatch boundary | #1994 / `4d354191` | `dispatch-boundary.ts`: `classifyWavePlanIntake` action-free closed record (`v1_wave_plan_spec` identity pass-through, `v2_rehearsal_candidate`, `v2_rejected`); v1 non-interference pin. |
| Slice 4 — rehearsal-evidence store | #1995 / `58c4564f` | `record-store.ts`: closed `WavePlanDagV2StoreEntryV1` union, semantic idempotency keys, all-or-nothing batches (cap 64), timestamp-free determinism, fail-closed `restore()`. |
| Slice 5 — broker wiring (default off) | #1996 / `608fdb7a` | `core/wave-plan-dag-v2-mode.ts` (`A2A_WAVE_PLAN_DAG_V2_MODE` = `off` or `record`, default `off`), single explicit write entry `broker.recordWavePlanDagV2Intake()` (never auto-invoked), read-only `GET /wave-plan-dag-v2/admissions` and `GET /wave-plan-dag-v2/rehearsals`. |
| Task-lineage read model | #1638 / #1690 / #1693 | `docs/specs/task-lineage-read-model/spec.md`, `packages/broker/src/core/task-lineage-read.ts`: read-only `tasks/children`, `tasks/lineage`, `tasks/leaves`; `parentTaskId`-only canonical ancestry, structural cycle guard, semantic duplicate detection explicitly out of scope. |

## 1. Problem

Issue #1800 item 3 requires validating **duplicate follow-ups** and a **stale
frontier** using the task-lineage read model. Both validations need an answer to
a question no landed contract defines: *which broker task, if any, carries a
given DAG stage's work?*

The frozen V2 manifest (§3 of the base contract) has no task-reference field,
and the task-lineage read model is read-only with no write path. Implementing
item 3 today would require inventing a binding schema outside any contract —
the exact reason item 3 was deferred (slice-2 Start comment, #1800) and later
held NOT-DECIDED (B-2, 2026-08-27). This document supplies that missing
contract so the deferral can be resolved by operator acceptance rather than by
silent schema invention at integration time.

## 2. Design decisions

- **D1 — Binding lives on the task side, never in the manifest.** The frozen
  manifest schema gains no fields. A binding is separate broker-side evidence
  that says "task T was created for stage S of admitted manifest M".
- **D2 — Ledger, not task-record mutation.** Binding records extend the
  slice-4 evidence store pattern instead of adding a write path to task
  records or to the lineage projection (both stay read-only, per the
  task-lineage spec).
- **D3 — Binding is evidence, not authority.** No record below has an action
  field. Binding ≠ admission ≠ readiness ≠ dispatch. Creating, advancing, or
  dispatching tasks remains an explicit operator or hub action (base contract
  §1; slice-3 records stay action-free; slice-5 write entry is never
  auto-invoked).
- **D4 — Structural duplicates only.** Duplicate detection means structural
  reuse of `(manifestDigest, stageId)` — never semantic similarity of intent
  or content. The task-lineage exclusion of semantic duplicate detection is
  preserved verbatim.
- **D5 — Fail-closed ledger, bounded views.** Ledger persistence inherits the
  record-store posture (idempotent, all-or-nothing, fail-closed restore)
  because bindings are preservation-of-evidence. Validation outputs are
  bounded projections in the slice-2 posture (closed enums, clamped counts,
  fail-open per-row views, never authority).
- **D6 — No new digest scheme.** Snapshot integrity comes from structural
  validation and fail-closed restore, as in slice 4; bindings introduce no
  new framed digest. The only digests in play are the landed manifest and
  receipt digests.

## 3. Closed data rules

The base contract §2 rules apply to every new record: closed objects (an
unlisted field is malformed), no worker/person/requester/model/provider/account
identities, no prompts, payloads, paths, URLs, timestamps, free-form labels,
maps, or extensions. Values are printable ASCII strings, booleans, safe
integers, arrays, and objects only.

- `manifestDigest`: `sha256:` + exactly 64 lowercase hex — MUST equal the
  digest of an admitted `WavePlanDagManifestV2` (slice-1 admission).
- `stageId`: `stg_` + exactly 8 lowercase hex — MUST be a stage of that
  admitted manifest, verified against a freshly admitted manifest at write
  time (§4.2), not persisted as a list.
- `taskId`: broker-assigned task identifier, copied verbatim from the broker's
  task read source after resolution; 1–128 printable ASCII characters with no
  whitespace or control characters. The binding caller never supplies the id
  as a free-form string; it names a task that the write path resolves.
- `bindingSource`: closed enum `operator` | `hub` — the acting class of the
  explicit caller (base contract §1 wording). It is a class, not an identity.

## 4. Binding record and ledger entry

### 4.1 Entry shape

Bindings are a fourth entry type in the slice-4 store union. Extending the
closed union is the reviewable boundary (same discipline as slice 2's mode
union); the `kind` and `version` stay `WavePlanDagV2StoreEntryV1` / `1`:

```json
{
  "kind": "WavePlanDagV2StoreEntryV1",
  "version": 1,
  "entryType": "stage_task_binding_recorded",
  "manifestDigest": "sha256:…",
  "stageId": "stg_…",
  "taskId": "…",
  "bindingSource": "operator"
}
```

Exact field set: `entryType`, `kind`, `manifestDigest`, `stageId`, `taskId`,
`bindingSource`, `version`. Any extra or missing field is `entry_malformed`.

### 4.2 Write-path preconditions

The future binding write path (§7) is an explicit operator/hub action and MUST,
in order:

1. Re-run slice-1 admission on the presented manifest payload and refuse unless
   the resulting digest equals the requested `manifestDigest` and a
   `manifest_admitted` entry exists (otherwise `manifest_not_known`, the
   existing flow-order reason).
2. Verify `stageId` membership in the freshly admitted manifest (otherwise
   `unknown_stage`) without persisting the stage list.
3. Resolve `taskId` against the broker's task read source: unresolvable or
   inaccessible → `task_unknown` (same bounded result shape as task-lineage
   missing/inaccessible anchors); already terminal (`succeeded`, `failed`,
   `canceled`) → `task_not_open`. Only open tasks (`blocked`, `queued`,
   `claimed`, `running`) may be bound.
4. Run the §5 follow-up check first and refuse while it returns
   `prior_binding_open` (`duplicate_open_binding`). A binding over
   `prior_binding_terminal` is admissible only as an explicit re-work act and
   is always counted and operator-visible.

### 4.3 Ledger semantics (inherited + delta)

Inherited from slice 4 unchanged: idempotent redelivery by semantic key,
all-or-nothing batches with the 64-entry cap, timestamp-free determinism,
insertion-ordinal ordering, snapshot via the `registerSnapshotExtension`
value-array convention, and fail-closed `restore()` (`snapshot_corrupt`) —
deliberately the opposite of slice-2 views, because silent loss of a binding
row is the actual harm. The honest boundary carries over too: local
corruption is detected; deletion of a complete self-consistent entry is not
locally detectable and remains an operator snapshot-policy concern.

Delta for bindings only:

- Identity key: `manifestDigest`, `stageId`, `taskId`. Identical redelivery is
  a counted no-op; the same triple with a different `bindingSource` is a
  `duplicate_conflict` rejecting the whole batch.
- Multiple tasks MAY be bound to one stage over time; §4.2 step 4 is the gate,
  and every re-binding stays visible. There is no silent cap beyond the batch
  limit.
- New store-local rejection reasons (the store vocabulary is separate from §5
  reasons, per slice 4): `unknown_stage`, `task_unknown`, `task_not_open`,
  `duplicate_open_binding`.

## 5. Follow-up check (duplicate guard)

`WavePlanDagStageFollowUpCheckV1` is a pure function over the ledger, the
admitted manifest, one `stageId`, and the live lineage status of the tasks
bound to that stage (status is always read from the task-lineage read model,
never cached in the ledger). It returns a closed record:

- `state`:
  - `no_prior_binding` — no task is bound to this stage;
  - `prior_binding_open` — at least one bound task is non-terminal: a new
    binding would duplicate in-flight work and is blocked (§4.2 step 4);
  - `prior_binding_terminal` — every bound task is terminal: re-binding is
    the operator's re-work decision, never a default;
  - `unknown_binding_target` — manifest not admitted or stage not a member;
  - `lineage_unavailable` — a bound task's status cannot be resolved: the
    check refuses rather than guessing (no optimistic interpretation).
- bounded counts of open/terminal bound tasks, clamped like slice-2 counts
  (fixed cap plus a reached flag).

**Mandatory refusal rule (the only hard gate in this contract):** any future
privileged task-creation path that stamps a stage binding MUST run this check
and MUST refuse while the state is `prior_binding_open`. Everything else the
check produces is operator-visible counting. Task creation authority remains
wherever it lives today; this contract grants none.

## 6. Frontier projection (stale guard)

`WavePlanDagStageFrontierProjectionV1` is a pure, read-only projection over
the ledger, the admitted manifest, the manifest's latest recorded dry-run
receipt, and the task-lineage read model. It compares the plan's view of
progress (receipt stage states) with task-graph reality (bound tasks and
their subtree leaves) and reports divergences for operator attention only —
no mutation, no effect on dispatch.

Per-bound-task `frontierState`, closed enum:

- `aligned_open` — task open; receipt stage not terminal: plan and reality
  agree work is in flight.
- `aligned_terminal` — task terminal and receipt marks the stage terminal
  with the expected outcome class: `succeeded` expects `gate_passed`;
  `failed` expects `gate_failed`; `canceled` accepts any terminal receipt
  state (an operator stop is terminal without a gate expectation).
- `divergence_task_terminal_receipt_open` — the task finished but the receipt
  never admitted a matching terminal outcome: rehearsal evidence is stale or
  incomplete.
- `divergence_receipt_terminal_task_open` — the receipt shows the stage
  terminal but the bound task is still open: stuck or never-dispatched work.
- `bound_task_missing` — the bound task no longer resolves in the read model.

Subtree/manifest-level codes:

- `leaf_unbound` — a visible leaf within a bound task's subtree carries no
  stage binding: the real frontier extends beyond the plan's coverage
  (counted; identifiers only on the operator surface).
- `receipt_stale` — the projection was requested against a receipt that is
  not the manifest's latest recorded rehearsal: refuse and re-run against the
  latest; partial outcome snapshots remain valid input per base contract §5,
  but evidence selection is not optional.
- `receipt_missing` — the manifest is admitted-unrehearsed: no frontier
  claims are made.

Surface split (slice-2 pattern): the public projection carries closed enums
and clamped counts only — no task ids, no digests, no free text. The operator
projection adds the bound task ids already present in the ledger, stage ids,
and the receipt digest. Both are bounded (fixed clamps with reached flags) so
a malformed or oversized input cannot inflate the surface.

## 7. Wiring contract (future implementation slice — not authorized by this document)

Any implementation slice MUST follow the slice-5 posture exactly:

- Mode: recording is governed by `A2A_WAVE_PLAN_DAG_V2_MODE` (`off` default).
  In `off`, the binding surface is absent. Rollback remains a single value
  flip; no code change on rollback.
- Exactly one explicit write entry point (e.g.,
  `recordWavePlanDagV2StageBinding(...)`), never auto-invoked anywhere in the
  broker; binding recording is an explicit operator/hub act (D3).
- Read-only GETs under the independent `/wave-plan-dag-v2/` prefix (e.g.,
  `bindings?manifestDigest=`, `stage-frontier?manifestDigest=`), same
  authentication posture as the slice-5 GETs, structurally separated from the
  v1 `/wave-plans*` surface, non-GET refused. Route exposure itself is an
  operator decision (§11).
- Snapshot participation via the value-array convention; fail-closed restore.
- Pruning/cap stays deferred to the #1504 lineage/storage contract (trace
  note already recorded there); this contract claims nothing.

## 8. Relation to the versioned dispatch boundary

A bound, ready stage does NOT become a new acting bucket. The slice-3 intake
record union stays action-free; binding evidence informs operator/hub
decisions and is never a routing input. If a future dispatch-connection slice
needs the notion of "stage with a bound open task", it MUST extend the closed
union explicitly at that time, under its own review — this contract
deliberately does not.

## 9. Verification plan for the implementation slice

Spec-first today; these are the pins the future slice must land (no-network,
deterministic, deep-equal vectors):

1. Ledger: idempotent redelivery (`skippedDuplicates`), `duplicate_conflict`
   on `bindingSource` mismatch, `manifest_not_known` before admission,
   `unknown_stage`, `task_unknown`, `task_not_open`,
   `duplicate_open_binding`, batch all-or-nothing, restore corruption →
   `snapshot_corrupt`, timestamp-free restart determinism.
2. Follow-up check: all five states plus count clamping; the mandatory
   refusal exercised end-to-end at the write path.
3. Frontier projection: `aligned_open`/`aligned_terminal` (including the
   canceled outcome-class rule), both divergence codes, `bound_task_missing`,
   `leaf_unbound` counting on a hand-built branch/rejoin/orphan DAG
   consistent with the task-lineage golden-fixture criteria,
   `receipt_stale` refusal, `receipt_missing`.
4. Non-interference: v1 `validateWavePlanSpec` verdicts byte-identical with
   and without the binding surface (slice-3 pin style); classifier union and
   frozen manifest schema unchanged; public projection encoding checks
   proving no task ids leak to the public surface (slice-2 style).
5. RED evidence per repo convention: each new pin demonstrated failing on the
   base tree before the fix lands.

## 10. Non-goals

- No change to the frozen manifest/receipt contracts, fixtures, or conformance
  checker vectors.
- No write path into task records or the lineage projection; no re-parenting;
  no semantic duplicate detection (D4).
- No task creation, dispatch, advance, claim, retry, finalization, verdict
  input, or live action from any record here (D3; lineage stays a
  dispatch/audit aid, never finalizer evidence).
- No v1 wave-plan changes; no activation, canary, rollout, or fleet env
  change of any kind.

## 11. Open operator decisions (not decided here)

Drafting stops where these begin; each needs an explicit operator ruling:

1. **Adoption** — accept this contract as the resolution of item 3 / B-2
   NOT-DECIDED, amend it, or keep the hold.
2. **Implementation timing** — whether the §4–§6 slice starts before, with,
   or after the dispatch-connection slice (the 2026-08-27 hold forbids
   preemptive code until dispatch connection work starts).
3. **Read-route exposure** — which §7 GET surfaces, if any, ship with the
   implementation slice.
4. **Re-work posture** — whether `prior_binding_terminal` re-binding needs a
   distinct approval artifact or ordinary operator/hub action suffices.
5. **Activation/rollout** — any resulting record-mode enablement stays under
   the existing activation checklist and fresh approval; this document
   changes no fleet state and decides no timing.


### 11.1 Decision record (operator ruling, 2026-09-14 — a2a-nexus#1800)

1. **Adoption** — accepted as-is. Item 3 / B-2 NOT-DECIDED is resolved in favor
   of this contract.
2. **Implementation timing** — the 2026-08-27 hold is released. The §4–§6
   implementation slice is authorized to start immediately, keeping the §7
   posture: default-off, single explicit write entry, no dispatcher wiring.
3. **Read-route exposure** — both §7 GET surfaces (`bindings`,
   `stage-frontier`) ship with the implementation slice, slice-5
   authentication posture, non-GET refused.
4. **Re-work posture** — `prior_binding_terminal` re-binding stays an ordinary
   operator/hub action; ledger visibility and counting are the controls. No
   separate approval artifact (contract text unchanged).
5. **Activation/rollout** — deferred. No broker deployment of the binding
   surface until the dispatch-connection work needs it; the existing
   activation checklist plus a fresh approval apply at that time.
