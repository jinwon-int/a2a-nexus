# Implementation plan

1. Preserve issue #2130 evidence and pause the dependent content PR at its
   frozen head. Keep the required receipt gate intact.
2. Replace silent note slicing with a fixed UTF-8 byte check. Return a bounded
   structured failure through both handler paths; evaluate before handler-owned
   completion comments.
3. Add synthetic integration and boundary regressions in the existing handler
   test suite, using the actual Piri normalizer. Retain negative verdicts and
   the existing missing-evidence and non-review tests.
4. Run old-code red/new-code green tests, broker package tests and repository
   checks. Freeze the commit for independent adversarial review; fix findings
   with meaningful regressions and allow at most one re-review.
5. Open a normal source PR with exact-head CI. Keep deployment approval and
   runtime proof separate; only then resume genuine independent content lanes.

The implementation is isolated and reversible. No production side effect is
part of this plan. Rollback is a normal source revert; it restores the old
transport limitation and therefore must leave the content dispatch on hold.
