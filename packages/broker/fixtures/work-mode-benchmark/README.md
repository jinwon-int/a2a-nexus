# Work Mode Benchmark Results

This directory stores source-only A2A work-mode benchmark fixtures and result
records.

`results-template.csv` is the blank spreadsheet-style template. Dated
`results-*.csv` and `results-*.jsonl` files are actual benchmark samples.

The initial `2026-06-06` records are post-hoc Team1 replay baselines from
GitHub issue and PR timestamps. They prove the recording path and expose
orchestration cost, but they do not yet provide headline Team1-vs-solo speedup
because the paired solo samples have not been collected.

The first-pass analysis for the six initial records is
`docs/a2a-work-mode-benchmark-analysis-2026-06-06.md`. Its headline aggregate
excludes the overlapping `#1279` hybrid candidate-review sample because that
late supplemental PR is already counted in the `#1253` Team1 candidate-review
record. The same analysis file now also includes the second-pass aggregate for
the 12 replay records collected through 2026-06-07.

`results-2026-06-06-solo-small-patch.*` adds the first follow-up solo
small-patch replay sample after the first-pass analysis. It is useful as a
routing signal, but it is not a same-difficulty paired fixture for the existing
Team1 small-patch baselines.

`results-2026-06-06-team1-runbook-policy.*` adds the first follow-up Team1
runbook-policy replay sample. It records a policy/runbook closeout with
unselected worker PRs and a late Block lane, so use it to study orchestration
cost and finalizer cleanup rather than direct speedup.

`results-2026-06-06-team1-ops-closeout.*` adds the first Team1
ops-closeout replay sample. It records finalizer selection, superseded worker
PR cleanup, residue PR closure, and late Block evidence for #1261/#1269.

`results-2026-06-06-solo-candidate-review.*` adds the first solo
candidate-review replay sample. It records a deterministic broker-finalizer
review packet for OI validation score results from #1005/#1006. Use it as a
solo review-packet signal, not as a same-difficulty pair for the Team1 #1253
candidate-review round.

`results-2026-06-06-solo-runbook-policy.*` adds the first solo runbook-policy
replay sample. It records the Terminal Brief sidecar operator runbook and
rollback checklist from #722/#723. Use it as a solo docs/runbook signal, not as
a same-difficulty pair for the Team1 #1254 stale terminal outbox policy round.

`results-2026-06-06-solo-ops-closeout.*` adds the first solo ops-closeout
replay sample. It records the source-only Terminal Brief closeout gate from
#700/#701. Use it as a solo closeout-gate signal, not as a same-difficulty pair
for the Team1 #1261 superseded running-task closeout round.
