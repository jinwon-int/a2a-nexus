# A2A Work Mode Benchmark Analysis 2026-06-06

This is the first-pass analysis for the initial `a2a-work-mode-benchmark-v1`
records. It summarizes the replay fixtures collected on 2026-06-06 and turns
them into provisional routing guidance for Seoseo solo work versus Team1 A2A
orchestration.

This analysis is source-only. It did not dispatch live workers, deploy, restart
Gateway or broker services, mutate databases, ACK or replay Terminal Brief rows,
send provider or Telegram canaries, publish releases, move credentials, or
change repository visibility.

## Source Records

| Sample | Type | Mode | Validity | Decision wall | Closeout wall | Total worker | Rework | Notes |
|---|---|---|---|---:|---:|---:|---:|---|
| `a2a-broker#1256` / `#1257` | `small_patch` | `team1` | `replay` | 399s | 513s | 606s | 2 | Team1 no-change flag propagation baseline. |
| `a2a-docker-runner#354` / `#356` | `small_patch` | `team1` | `replay` | 850s | 938s | 2638s | 2 | Team1 runner no-change evidence baseline; includes late lane cost. |
| `a2a-broker#1280` / `#1281` | `bug_rca` | `solo` | `replay` | 825s | 826s | 621s | 1 | Solo same-broker lane-order progress RCA. |
| `a2a-broker#1255` / `#1273` | `bug_rca` | `team1` | `replay` | 955s | 996s | 4846s | 4 | Team1 hot-table memory warning RCA; includes superseded and late failed lane cost. |
| `a2a-broker#1253` / `#1276` | `candidate_review` | `team1` | `replay` | 654s | 675s | 4506s | 4 | Team1 selected among worker PRs and Block evidence. |
| `a2a-broker#1253` / `#1279` | `candidate_review` | `hybrid` | `replay` | 1748s | 1748s | 557s | 2 | Overlaps with the `#1253` Team1 sample; use for hybrid-process notes, not headline aggregate. |

## Headline Aggregate

The headline aggregate excludes the `#1279` hybrid sample because that late
supplemental PR is already counted as worker cost in the `#1253` Team1
candidate-review record.

| Slice | n | Median decision wall | Median closeout wall | Median total worker | Median active Seoseo | Avg rework | Merge yield |
|---|---:|---:|---:|---:|---:|---:|---:|
| `small_patch` / `team1` | 2 | 624.5s | 725.5s | 1622s | 210s | 2.0 | 0.33 |
| `bug_rca` / `solo` | 1 | 825s | 826s | 621s | 621s | 1.0 | 1.00 |
| `bug_rca` / `team1` | 1 | 955s | 996s | 4846s | 409s | 4.0 | 0.33 |
| `candidate_review` / `team1` | 1 | 654s | 675s | 4506s | 369s | 4.0 | 0.33 |

Mode-level view, same exclusion:

| Mode | n | Median decision wall | Median closeout wall | Median total worker | Median worker/wall | Avg rework |
|---|---:|---:|---:|---:|---:|---:|
| `solo` | 1 | 825s | 826s | 621s | 0.8x | 1.0 |
| `team1` | 4 | 752s | 806.5s | 3572s | 4.1x | 3.0 |

## Readout

The current data is useful for routing heuristics, but it is not yet a clean
speedup study. All samples are `replay`, most task/mode cells have `n=1`, and
there is no same-difficulty paired solo candidate-review sample.

Early signals:

- Team1 can lower Seoseo active effort even when it does not lower wall-clock.
  In the Team1 RCA and candidate-review records, finalizer active windows are
  under seven minutes.
- Team1 uses substantially more total worker time. The current Team1 median
  total worker cost is 3572 seconds, with a median worker/wall ratio of 4.1x.
- Team1 creates cleanup work. Current Team1 records average three rework events
  per sample, mostly superseded PRs, late lanes, body hygiene, branch updates,
  or CI reruns.
- Candidate-review is the best observed Team1 fit. The `#1253` Team1 sample
  reached a decision in 654 seconds while comparing multiple PRs and Block
  evidence, which is exactly the work profile Team1 is designed for.
- Small patch Team1 samples are not enough to justify orchestration by default.
  They produced useful evidence, but selected only one of three worker PRs and
  consumed more total worker time than the operator-visible wall-clock result
  suggests.
- The hybrid `#1279` sample shows a separate useful pattern: bounded Team1
  evidence plus Seoseo finalizer cleanup can reduce parallel worker spend, but
  it can still have high wall-clock if the finalizer waits on hygiene, branch
  updates, and CI.

## Provisional Routing Rules

| Work profile | Default | Why |
|---|---|---|
| Narrow, well-understood source fix | `solo` | Current Team1 small-patch samples show non-trivial orchestration cost and low merge yield. |
| Small or medium RCA with one likely code path | `solo` first | The solo RCA sample had lower wall-clock and far lower total worker time than the Team1 RCA sample. |
| Ambiguous RCA with several plausible causes | `team1` evidence, Seoseo finalizer | Team1 can collect broader evidence, but the finalizer must control the closeout and rework. |
| Multiple candidate PRs, conflicting recommendations, or Block evidence | `team1` | The candidate-review sample is the clearest Team1 win shape so far. |
| Late supplemental review or PR hygiene after a Team1 round | `hybrid` | Bounded helper evidence is useful, but headline aggregate accounting must avoid double-counting. |
| Live deploy, Gateway or broker restart, DB mutation, Terminal Brief ACK/replay, release, secret, or visibility boundary | Seoseo finalizer only; Team1 evidence if approved | These actions need a single approval-aware owner and must not be delegated as independent closeout decisions. |

## Evidence Gaps

The first-pass sample set had these gaps. The follow-up records below partially
fill them, but they still do not create same-difficulty paired fixtures.

1. `solo` `candidate_review`: partially filled by `#1005/#1006`, but that is a
   deterministic review-packet sample rather than a same-difficulty pair for
   the Team1 `#1253` candidate-review round.
2. `solo` `small_patch`: partially filled by `#1277/#1278`, but it is not a
   same-difficulty pair for the existing Team1 small-patch baselines.
3. More `bug_rca` pairs with similar risk and file count: needed because
   `#1280` and `#1255` are not same-difficulty paired fixtures.
4. `ops_closeout` and `runbook_policy`: partially filled by solo follow-ups
   `#700/#701` and `#722/#723`, plus Team1 follow-ups `#1261/#1269` and
   `#1254/#1263`. These compare broad work profiles, not matched difficulty.

## Follow-Up Sample

After this first-pass analysis, follow-up samples were added to fill missing
task-type slices. These records are useful routing signals, but they are not
same-difficulty paired fixtures against the earlier samples. Treat them as
additional evidence, not as final speedup conclusions.

Observed follow-up metrics:

| Sample | Type | Mode | Decision wall | Closeout wall | Total worker | Rework |
|---|---|---|---:|---:|---:|---:|
| `a2a-broker#1277` / `#1278` | `small_patch` | `solo` | 97s | 98s | 38s | 0 |
| `a2a-broker#1254` / `#1263` | `runbook_policy` | `team1` | 1204s | 1207s | 3034s | 4 |
| `a2a-broker#1261` / `#1269` | `ops_closeout` | `team1` | 1008s | 1039s | 2159s | 5 |
| `a2a-broker#1005` / `#1006` | `candidate_review` | `solo` | 421s | 422s | 252s | 0 |
| `a2a-broker#722` / `#723` | `runbook_policy` | `solo` | 229s | 230s | 168s | 0 |
| `a2a-broker#700` / `#701` | `ops_closeout` | `solo` | 725s | 727s | 669s | 0 |

## Second-Pass Aggregate

This aggregate uses all 12 replay records collected by 2026-06-07. The headline
view still excludes the overlapping hybrid `#1279` record because that late
supplemental PR is already counted as worker cost in the `#1253` Team1
candidate-review sample.

Headline mode-level view:

| Mode | n | Median decision wall | Median closeout wall | Median total worker | Median active Seoseo | Median worker/wall | Avg rework | Merge yield |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `solo` | 5 | 421s | 422s | 252s | 252s | 0.7x | 0.2 | 1.00 |
| `team1` | 6 | 902.5s | 967s | 2836s | 210s | 2.8x | 3.5 | 0.40 |

Task/mode view:

| Slice | n | Median decision wall | Median closeout wall | Median total worker | Median active Seoseo | Avg rework | Merge yield |
|---|---:|---:|---:|---:|---:|---:|---:|
| `small_patch` / `solo` | 1 | 97s | 98s | 38s | 38s | 0.0 | 1.00 |
| `small_patch` / `team1` | 2 | 624.5s | 725.5s | 1622s | 210s | 2.0 | 0.33 |
| `bug_rca` / `solo` | 1 | 825s | 826s | 621s | 621s | 1.0 | 1.00 |
| `bug_rca` / `team1` | 1 | 955s | 996s | 4846s | 409s | 4.0 | 0.33 |
| `candidate_review` / `solo` | 1 | 421s | 422s | 252s | 252s | 0.0 | 1.00 |
| `candidate_review` / `team1` | 1 | 654s | 675s | 4506s | 369s | 4.0 | 0.33 |
| `ops_closeout` / `solo` | 1 | 725s | 727s | 669s | 669s | 0.0 | 1.00 |
| `ops_closeout` / `team1` | 1 | 1008s | 1039s | 2159s | 117s | 5.0 | 1.00 |
| `runbook_policy` / `solo` | 1 | 229s | 230s | 168s | 168s | 0.0 | 1.00 |
| `runbook_policy` / `team1` | 1 | 1204s | 1207s | 3034s | 89s | 4.0 | 0.50 |

Pair-like, non-matched comparison:

| Type | Solo decision | Team1 decision | Team1/solo wall | Solo active | Team1 active | Solo/team active | Team1 worker amplification |
|---|---:|---:|---:|---:|---:|---:|---:|
| `small_patch` | 97s | 624.5s | 6.4x slower | 38s | 210s | 0.2x | 42.7x |
| `bug_rca` | 825s | 955s | 1.2x slower | 621s | 409s | 1.5x | 7.8x |
| `candidate_review` | 421s | 654s | 1.6x slower | 252s | 369s | 0.7x | 17.9x |
| `ops_closeout` | 725s | 1008s | 1.4x slower | 669s | 117s | 5.7x | 3.2x |
| `runbook_policy` | 229s | 1204s | 5.3x slower | 168s | 89s | 1.9x | 18.1x |

Second-pass readout:

- Solo is the default for narrow source fixes and deterministic source-only
  packet/docs work. Its current median decision wall is 421 seconds with almost
  no rework.
- Team1 remains expensive in total worker time. Its current median total worker
  cost is 2836 seconds, and average rework is 3.5 per sample.
- Team1's clearest value is reducing Seoseo active effort for operational
  closeout and some RCA/policy rounds. The `ops_closeout` comparison shows the
  strongest active-effort reduction, but Team1 still took longer wall-clock and
  created more cleanup.
- Candidate-review still needs better paired evidence. The Team1 `#1253` round
  is a true multi-candidate review; the solo `#1005` sample is a deterministic
  review-packet implementation. Do not claim Team1 loses candidate-review from
  this pair-like table.
- Route future work by risk and ambiguity: use solo for predictable source/docs
  changes, use Team1 for ambiguous multi-candidate or approval-boundary
  evidence gathering, and keep Seoseo as the single finalizer for all closeout
  decisions.
- The executable operator defaults derived from this analysis live in
  `docs/a2a-work-mode-routing-rules.md`.

## Related

- `docs/a2a-work-mode-benchmark-v1.md`
- `docs/a2a-work-mode-routing-rules.md`
- `fixtures/work-mode-benchmark/README.md`
- `fixtures/work-mode-benchmark/results-2026-06-06-initial.jsonl`
- `fixtures/work-mode-benchmark/results-2026-06-06-solo-small-patch.jsonl`
- `fixtures/work-mode-benchmark/results-2026-06-06-solo-bug-rca.jsonl`
- `fixtures/work-mode-benchmark/results-2026-06-06-team1-runbook-policy.jsonl`
- `fixtures/work-mode-benchmark/results-2026-06-06-team1-ops-closeout.jsonl`
- `fixtures/work-mode-benchmark/results-2026-06-06-solo-candidate-review.jsonl`
- `fixtures/work-mode-benchmark/results-2026-06-06-solo-runbook-policy.jsonl`
- `fixtures/work-mode-benchmark/results-2026-06-06-solo-ops-closeout.jsonl`
- `fixtures/work-mode-benchmark/results-2026-06-06-team1-bug-rca.jsonl`
- `fixtures/work-mode-benchmark/results-2026-06-06-team1-candidate-review.jsonl`
- `fixtures/work-mode-benchmark/results-2026-06-06-hybrid-candidate-review.jsonl`
- `https://github.com/jinwon-int/a2a-broker/issues/1294`
