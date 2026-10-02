# V2 warn-log aggregation — 2026-07-04

Issue: [#1265](https://github.com/jinwon-int/a2a-nexus/issues/1265) under umbrella [#1261](https://github.com/jinwon-int/a2a-nexus/issues/1261).

Purpose: aggregate readiness/projection warning signals while fixing the V2 source-carrier contract. The aggregation is count-first and sample-bounded; it must not record raw secrets or provider payloads.

## Aggregator

Use `scripts/a2a-warn-log-aggregate.mjs` on already-collected broker logs:

```bash
node scripts/a2a-warn-log-aggregate.mjs \
  /tmp/a2a-nexus-v2-*/warn-logs/broker-a.log \
  /tmp/a2a-nexus-v2-*/warn-logs/broker-b.log
```

It counts these fixed signals:

- `task readiness spec_underspecified`
- `task readiness source_projection_empty`
- `source_projection_blocked`
- `openclaw_analysis_failed`
- `acceptance_malformed`

Samples are limited and redacted for `*SECRET*=...` and `token=...` forms.

## V2 local collection snapshot

Collection window: `2026-07-04T07:00:00Z` onward.

| Broker log source | Lines available | `spec_underspecified` | `source_projection_empty` | `source_projection_blocked` | `openclaw_analysis_failed` | `acceptance_malformed` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| local primary broker journal | 1 | 0 | 0 | 0 | 0 | 0 |
| remote secondary broker journal/fallback | 1 | 0 | 0 | 0 | 0 | 0 |

Interpretation: the local `journalctl --user` windows available to this session did not retain the V1 warning lines. V2 therefore keeps the aggregation script and records the missing-log condition explicitly instead of inventing counts. Task-level readbacks remain the source for V1 `source_projection_blocked` lane counts; broker warn-log counts must be re-run on hosts with retained service logs before V3 enforce approval.
