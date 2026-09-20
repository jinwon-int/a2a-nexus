# Tasks: JEV Probe-Classification Corpus (spec-first packet)

Refs #2206. Baseline: main @ `b2d8a92df9d9d59491819a8d025b9d7c670eeefd`.

- [x] Verify no `docs/specs/jev-probe-classification-corpus/` exists on the baseline.
- [x] Author [spec.md](./spec.md) (problem, goals, non-goals, record contract,
      redaction protocol, labeling policy, evaluation posture, reuse contract).
- [x] Author [plan.md](./plan.md) (Phase 0 in-scope; Phases 1–4 separately gated).
- [x] Author `schemas/probe-corpus-record.schema.json` (closed v1 contract,
      `additionalProperties: false` at every level, no outcome-shaped field).
- [x] Author `fixtures/jev-probe-classification-corpus/corpus-sample.json`
      (10 synthetic records; all three classes, four group kinds, three splits,
      four label statuses; synthetic ids only).
- [x] Validate the fixture against the schema (`ajv`).
- [ ] Tracking issue #2206: record redaction-protocol ratification decision
      (owner gate — blocks Phase 1 only, not this packet).
- [ ] Phase 1–4 slices per [plan.md](./plan.md) (each separately approved).

## Definition of done (this packet)

- `npm run check:layout`, `node scripts/check-markdown-links.mjs`, and
  `node scripts/check-monorepo-docs-routing.mjs` pass on this tree.
- Schema and fixture committed and schema-validating.
- No runtime file touched: `git diff --stat` against the baseline lists only
  `docs/specs/jev-probe-classification-corpus/**` and
  `fixtures/jev-probe-classification-corpus/**`.
