# A2A Dialectic Lite

Issue: [#1077](https://github.com/jinwon-int/a2a-broker/issues/1077)

`A2A Dialectic Lite` is the default operating pattern for ordinary A2A
team rounds. It brings a lightweight thesis / antithesis / ordinary
alternative / safety review layer into normal team work without turning
the round into a full `decision.dialectic` task.

Ordinary A2A rounds use this lite mode by default. Do not treat that as a
request to strongly drive toward a dialectic synthesis.

Use the stronger dialectic mode only when the operator explicitly says:

```text
a2ad 로 진행
```

The legacy phrase below is accepted as the same strong trigger:

```text
a2ad 라운드로 진행
```

The explicit strong `a2ad` trigger means: raise the dialectic weight,
separate thesis / antithesis / synthesis more visibly, and consider a full
`decision.dialectic` task if the decision itself needs durable tracking. It
still does not authorize a live deploy, Gateway restart, DB mutation,
provider send, Terminal ACK/replay, release, credential movement, or any
other approval-sensitive action.

## Role split

| Role | Dialectic lane | Responsibility |
| --- | --- | --- |
| Team1 | thesis | Propose the primary solution hypothesis, likely patch, or operating plan. |
| Team2 | antithesis | Challenge the thesis with counter-evidence, failure modes, alternate causes, and approval-boundary risks. |
| Libero / validator | synthesis-risk gate | Compare thesis and antithesis, then separate safe immediate action from approval-required or deferred action. |
| Broker finalizer | decision owner | Choose one final path. The finalizer may adopt, revise, or reject the synthesis candidate. |

The broker finalizer remains the only owner for external decisions such
as PR merge, issue close, deploy request, Wiki update, or approval
request.

## Team dispatch contract

An A2A round is not valid evidence unless it runs through the declared
team workers:

- `team1`: `workerbeta`, `workeralpha`, `workerdelta`.
- `team2`: `workerepsilon`, `workerzeta`, `workereta`, with `mobilebeta` limited to
  separately constrained mobile/no-live work.
- `cross-team`: parent broker dispatches its own team locally and opens
  the other team only through that team's broker of record.

Every A2A round task must set:

- `assignedWorkerId` matching `target.id`;
- `payload.teamScope` as `team1`, `team2`, or `cross-team`;
- `payload.parentRoundId`;
- `payload.originBrokerId`;
- `payload.parentRoundTotal`;
- `payload.parentRoundOrder`.

The broker rejects A2A round tasks that omit the parent round total/order
metadata, because otherwise Terminal Brief titles degrade into diagnostic
messages such as `parentRoundTotal, parentRoundOrder missing`.

Do not substitute local subagents for team workers when reporting a
formal A2A team round. Local subagents may be used only as auxiliary
scratch reviewers and must be labeled that way.

## Core rule

Dialectic synthesis is a candidate solution, not an authority.

The finalizer compares the synthesis candidate against ordinary
alternatives. The final decision still follows this precedence:

1. Safety and approval boundaries.
2. Evidence, tests, CI, and reproducible validation.
3. Rollback readiness, secret handling, and fail-closed behavior.
4. The synthesis candidate from the dialectic lanes.

The source guard for this rule is
`src/core/a2a-dialectic-lite-finalizer.ts`, exposed through:

```bash
npm run a2a_dialectic_lite_finalizer -- --input round.json
```

The guard does not mark a packet `ready_for_finalizer_decision` unless:

- every dialectic opinion and candidate identifies the worker that
  supplied it;
- a dialectic synthesis is recorded as a candidate;
- at least one ordinary alternative is available for comparison;
- the selected candidate exists; and
- the finalizer records why the selected path beats the alternatives on
  evidence, safety, simplicity, and current approval scope.

Selecting the synthesis candidate is allowed only after that comparison.
The synthesis is never a winner by default.

The guard records two round modes:

- `ordinary_a2a_lite`: the default for normal A2A work. Use short
  thesis/counter-check/ordinary-alternative comparison and keep the final
  decision close to ordinary engineering judgment.
- `explicit_strong_a2ad`: only when the operator explicitly says `a2ad 로
  진행` or `a2ad 라운드로 진행`. Use stronger thesis / antithesis /
  synthesis structure, while still comparing synthesis against ordinary
  alternatives before the finalizer chooses.

If the synthesis says a deploy, restart, DB action, provider send,
Terminal ACK/replay, release, or credential change is probably correct
but explicit approval is missing, the round stops at source-only work or
an approval request.

## Evidence packet

Each dialectic lane should return a compact packet. Avoid raw logs,
secrets, long transcripts, or full debate text.

```json
{
  "workerId": "workerbeta",
  "claim": "What this lane believes is true.",
  "evidence": ["Concise source, test, CI, or runtime facts."],
  "counterRisk": ["What could make this claim wrong or unsafe."],
  "verification": ["The smallest checks that would increase confidence."],
  "forbiddenBoundary": [
    "Actions that are not approved in this round, such as deploy or DB mutation."
  ],
  "synthesisCandidate": "Optional proposed combined path."
}
```

## Round size guidance

### Small rounds

Use only a short counter-check:

- Team1 proposes the direct fix or answer.
- Team2 or Libero performs one antithesis pass.
- If the dialectic step slows down a trivial task, fall back to ordinary
  handling.

### Medium and large rounds

Assign explicit thesis, antithesis, and synthesis-risk lanes:

- Team1, Team2, and Libero evidence packets should be bounded and
  comparable.
- The broker final report should summarize the adopted synthesis and any
  material rejected alternatives.
- GitHub comments and Wiki logs should record the decision and key
  evidence, not raw debate transcripts.

### Live or mutation-sensitive rounds

Approval boundaries override dialectic conclusions:

- Production deploys need fresh explicit approval.
- Gateway or worker restarts need fresh explicit approval.
- DB prune, migration, or manual mutation needs fresh explicit approval.
- Provider send, Terminal ACK/replay, release/tag publish, and credential
  movement need fresh explicit approval.

## Default A2A prompt template

Use this at the start of an ordinary A2A team round:

```text
Ordinary A2A round for <issue/topic> with Dialectic Lite built in.

Team1: propose the primary solution and smallest safe patch or operating
action. Identify the worker that supplied each claim or synthesis input.

Team2: perform a short antithesis pass with counter-evidence, alternate
causes, failure modes, and approval-boundary risks. Identify the worker
that supplied each claim or synthesis input.

Broker finalizer: compare the dialectic synthesis candidate, if any,
against ordinary alternatives. Choose the best evidenced, safest, simplest
viable path within the current approval scope.
```

## Strong a2ad prompt template

Use this only when the operator explicitly asks for `a2ad 로 진행` or
`a2ad 라운드로 진행`:

```text
Strong a2ad round for <issue/topic>.

Team1: thesis. Propose the primary solution and smallest safe patch or
operating action.

Team2: antithesis. Challenge Team1 with counter-evidence, alternate
causes, failure modes, and approval-boundary risks.

Libero/validator: synthesis-risk gate. Compare both lanes, identify the
smallest safe next action, and list actions that still need explicit
approval.

All lanes: return claim, evidence, counterRisk, verification, and
forbiddenBoundary, and identify the worker that supplied the opinion. Do
not perform deploys, restarts, DB mutations,
provider sends, Terminal ACK/replay, releases, credential movement, or
GitHub/Wiki writes unless explicitly assigned and approved.

Broker finalizer: choose one final path; the dialectic synthesis is a
candidate, not a binding decision.
```

## Final report template

```text
A2A Dialectic Lite result
- Topic / issue:
- Thesis:
- Antithesis:
- Synthesis candidate:
- Finalizer decision:
- Evidence used:
- Rejected alternatives:
- Validation:
- Approval-sensitive actions not performed:
- Remaining blockers:
```

## Distinction from `decision.dialectic`

`decision.dialectic` is a broker task contract with explicit phases,
worker role assignment, patch/advance endpoints, and read-model state.
Use it when the decision itself needs to be tracked as a durable broker
task.

`A2A Dialectic Lite` is a team-round operating convention. It is the
default light review layer for normal A2A rounds. Use explicit strong
`a2ad` wording only when the operator wants a heavier dialectic pass and
the decision still does not need a durable dialectic task.
