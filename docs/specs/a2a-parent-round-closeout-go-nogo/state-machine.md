# Parent-Round Closeout State Machine

> **Contract:** `contracts/a2a/parent-round-closeout-go-nogo-matrix.md`

## States and transitions

```
                         ┌──────────────────────────────────────────────────────┐
                         │                                                      │
                         ▼                                                      │
                   ┌──────────┐                                                │
                   │  ACTIVE  │                                                │
                   └───┬──┬───┘                                                │
                       │  │                                                    │
                       │  │ Child lane blocked / unsafe                        │
                       │  ▼                                                    │
                       │  ┌──────────┐                                         │
                       │  │ BLOCKED  │ (irrecoverable lane issue)              │
                       │  └──────────┘                                         │
                       │                                                       │
                       │ All N lanes terminal                                  │
                       ▼                                                       │
                   ┌────────────┐                                              │
                   │ CANDIDATE  │                                              │
                   └───┬────┬───┘                                              │
                       │    │                                                  │
                       │    │ Go/No-Go evaluation                              │
                       │    │  ├── GO all gates pass                           │
                       │    │  ├── NO_GO some gates fail                      │
                       │    │  └── BLOCKED unsafe condition                   │
                       │    ▼                                                  │
                       │    ┌──────────┐                                       │
                       │    │ BLOCKED  │ (matrix returned BLOCKED)             │
                       │    └──────────┘                                       │
                       │                                                       │
                       │ GO ─────────────────────────────┐                     │
                       │                                 │                     │
                       ▼                                 ▼                     │
                   ┌──────────┐                    ┌──────────┐                │
                   │ WAITING  │                    │ CLOSEOUT │ (terminal)     │
                   └─────┬────┘                    └──────────┘                │
                         │                                                      │
                         │ New lane arrives or retry re-dispatched              │
                         └──────────────────────────────┘──────────────────────┘

```

## State descriptions

### ACTIVE

The parent round is open. Child lanes are being dispatched and worked. `parentRoundProgress`
is less than `parentRoundTotal`.

**Entry conditions**:
- Parent round metadata has been minted (`parentRoundId`, `originBrokerId`, `parentBrokerId`,
  `parentRoundTotal`, `parentRoundOrder`).
- At least one child lane has been dispatched.

**Exit conditions**:
- All N lanes terminal → transition to `CANDIDATE`.
- A child lane produces an unsafe/blocked state → transition to `BLOCKED` (irrecoverable).

### CANDIDATE

All N child lanes have terminal results (PR/Done/Block/Cancelled). The parent round is
eligible for closeout evaluation via the go/no-go matrix.

**Entry conditions**:
- `parentRoundProgress >= parentRoundTotal`.
- Every lane has a terminal projection recorded in the parent aggregation ledger.

**Exit conditions**:
- Matrix returns GO → transition to `CLOSEOUT` (via Seoseo finalizer action).
- Matrix returns NO_GO → transition to `WAITING`.
- Matrix returns BLOCKED → transition to `BLOCKED`.

### CLOSEOUT (terminal)

Seoseo has executed the closeout: a Go decision comment was posted and the parent issue was
closed. This state is terminal — no further transitions occur for this parent round.

**Entry conditions**:
- Matrix returned GO.
- Seoseo posted the Go decision comment on the parent issue (GitHub 200).
- Seoseo closed the parent issue (GitHub 200).
- Closeout ledger entry was recorded with idempotency key.

**Evidence produced**:
- `closeoutDecision`: `GO`
- `closeoutCommentUrl`: URL of the Go decision comment
- `idempotencyKey`: the closeout idempotency key
- `closedAt`: ISO-8601 timestamp

### WAITING

The matrix returned NO_GO: some gates did not pass, but there is no unsafe condition. The round
waits for resolution (missing lanes, retries, evidence completion, or operator intervention).

**Entry conditions**:
- Matrix returned NO_GO (one or more gates FAIL, no gates BLOCKED).

**Exit conditions**:
- Missing lane is dispatched → transit to `ACTIVE`.
- Retry of a terminal lane is dispatched → transit to `ACTIVE`.
- Operator explicitly overrides No-Go → transit to `CANDIDATE` (for re-evaluation).

### BLOCKED (terminal)

An unsafe condition was detected: unredacted evidence, runtime/bootstrap hygiene violation,
GitHub 403, idempotency conflict, or a blocked child projection. Operator review is required.
This state is terminal unless the operator explicitly unblocks the round.

**Entry conditions**:
- Gates G4, G5, G7, G8, or G10 returned BLOCKED.
- A child lane produced an irrecoverable block state during ACTIVE.

**Exit conditions**:
- Operator reviews and unblocks → transit to `CANDIDATE` (for re-evaluation).
- Operator declares the round permanently blocked → remains `BLOCKED`.

## Bell-Core extended state labels

For operator-facing notifications, the parent broker may use these Korean status labels:

| State | Korean label |
|---|---|
| ACTIVE | 진행 중 |
| CANDIDATE | 후보 |
| CLOSEOUT | 완료 |
| WAITING | 대기 중 |
| BLOCKED | 차단 |

## Title format for operator notifications in each state

| State | Title format | Example |
|---|---|---|
| ACTIVE | `A2A Parent Round 진행 중: <parentRoundId>` | `A2A Parent Round 진행 중: round-team1-001` |
| CANDIDATE | `A2A Parent Round 후보: <parentRoundId>(<progress>/<total>)` | `A2A Parent Round 후보: round-team1-001(4/4)` |
| CLOSEOUT | `A2A Parent Round 완료: <parentRoundId>` | `A2A Parent Round 완료: round-team1-001` |
| WAITING | `A2A Parent Round 대기 중: <parentRoundId>(<progress>/<total>)` | `A2A Parent Round 대기 중: round-team1-001(3/4)` |
| BLOCKED | `A2A Parent Round 차단: <parentRoundId>` | `A2A Parent Round 차단: round-team1-001` |

All titles must satisfy the same 80-char max, forbidden-content, and separation gates defined
in the parent Terminal Brief aggregation contract's concise title semantics.
