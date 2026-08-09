# scripts/ lifecycle policy

The `scripts/` directory accumulates CLIs and `node:test` files faster than it
sheds them. Many test files are named for specific, now-closed review rounds
(`check-team2-worker-eta-r13-…`, `check-team1-worker-delta-r27-…`). Historically the
release gate enumerated ~50 of these by hand in a single `package.json` line —
a merge-conflict magnet with no retirement story.

This policy gives every script a lifecycle class and makes the release gate
**manifest-driven** so that adding or retiring a gate is a one-line change with
auditable evidence.

## Classes

Every file under `scripts/` belongs to exactly one class:

- **`gate`** — permanent, release-blocking. Runs in every release gate. These
  encode invariants we expect to hold indefinitely (conformance, ack
  boundaries, schema parity, closeout guidance). Removing a `gate` requires a
  PR that argues the invariant no longer applies.

- **`tool`** — operator CLI, **not** part of the release gate. Run on demand by
  a human or another script (dispatch helpers, scan/rehearsal aggregators,
  health checks). A `tool` is never listed in
  `scripts/release-gate-manifest.json`.

- **`round`** — tied to a **specific** review round, identified by a clear
  round marker in the filename (an `rNN` pattern, optionally with a person/team
  prefix, e.g. `team2-worker-eta-r13`). A `round` script is release-blocking
  **while its round is open**. Once the round closes it is archived (see below).

### Conservative classification (fail-closed)

When in doubt, classify as **`gate`** and change nothing. A team- or
person-named file that does **not** carry an explicit round marker (no `rNN`)
stays `gate` — even if it looks round-flavored. Issue numbers (`…-after-78261-close`,
`…-527-497-294`) are **not** round markers. This bias keeps the gate strictly a
superset of its historical behavior: we never silently drop a check.

## The manifest

`scripts/release-gate-manifest.json` is the single source of truth for
`npm run test:release-gate`. Each entry:

```json
{ "file": "scripts/check-…​.test.mjs", "class": "gate", "round": null, "note": "…" }
```

- `file` — path from repo root. Validated to exist; a missing file fails the
  gate loudly.
- `class` — `gate` | `tool` | `round` (a `tool` would not normally appear here;
  the manifest is the gate's run list).
- `round` — round id for `round` entries (e.g. `team2-worker-eta-r13`),
  otherwise `null`.
- `note` — short human rationale, including why a round-flavored file was kept
  as `gate` when applicable.
- `archived` *(optional, boolean)* — when `true`, the runner **skips** the entry
  with one loud warning line and excludes it from `--list`. Defaults to absent
  (i.e. the entry runs). This is the lever for retiring a `round` (see below).

The runner `scripts/run-release-gate.mjs`:

- reads the manifest, validates it (well-formed JSON, non-empty `entries`,
  valid `class`, no duplicate files, every non-archived file exists),
- runs `node --test <all active files>` as **one** process — identical to the
  historical hand-enumerated line — and exits with its status,
- supports `--list` to print the resolved file list (manifest order) for
  before/after verification (`npm run test:release-gate:list`).

Adding a gate = add one manifest entry. Retiring one = flip `archived` (then,
once its round is closed, move the file — see below). No more editing a giant
`package.json` line.

## Data-driven doc/fixture specs

For `check-*.mjs` files that only validate a fixture, a doc, package wiring, and
release-gate presence, prefer the data-driven path instead of adding another
bespoke script body:

1. Add an entry to `docs/ops/data-driven-validation-registry.json`.
2. Keep the historical npm script and `scripts/check-*.mjs` filename stable.
3. Make that script a thin wrapper around `runDocSpecCheck('<id>')` from
   `scripts/lib/doc-spec-check.mjs`.
4. Put repeated assertions in the registry (`equals`, `includes`, `includesAll`,
   `matches`, `min`, `arraySome`, `arrayEveryEquals`) rather than duplicating
   `readRel` / `parseJson` / `expect` boilerplate. Available primitives
   include `equals`, `notEquals`, `oneOf`, `includes`, `includesAll`,
   `matches`, `min`, `minLength`, `lengthEquals`, `arraySome`, and
   `arrayEveryEquals`. Use `when` for explicit conditional assertions and
   `extraDocs` for named cross-document roots.

This preserves source-backed release checks while moving the repeated validation
shape into data. It also keeps existing release-gate entries, docs, and issue
links stable during incremental migration.

## Retiring a `round` (follow-up flow)

This is intentionally a **two-step**, evidence-backed flow, and it happens in
**follow-up PRs**, not here:

1. **Archive in place.** Set `"archived": true` on the entry. The runner skips
   it loudly so the change is visible in gate output. The PR description must
   link the round's closeout evidence (the merged round / closeout issue or
   doc) justifying retirement. The file still lives in `scripts/`.

2. **Move to `scripts/archive/`.** Once the round is confirmed closed, a
   subsequent PR relocates the file under `scripts/archive/` and removes its
   manifest entry, again linking the closeout evidence.

> **The directory is not the boundary — the manifest entry is.**
> `run-release-gate.mjs` skips on `archived: true`, never on the path, so a file
> under `scripts/archive/` whose entry is still active runs on every release
> gate. 18 do today (`node scripts/run-release-gate.mjs --list | grep
> scripts/archive/`). Step 2 is only complete when the entry is gone; moving the
> file alone is cosmetic.

Each retiring PR carries **per-script justification**. We never bulk-delete
round files.

## Zero behavior change in the introducing PR

The PR that introduced this policy (issue #646) changed **zero** behavior:

- `scripts/release-gate-manifest.json` lists exactly the files the old
  `test:release-gate` line ran, in the same order.
- `npm run test:release-gate:list` output is byte-for-byte the historical file
  set (verified empty diff, set and order).
- All `round`-class entries still **run** (none archived).

Archiving and moving round files happens later, as the follow-up PRs described
above, each with its own evidence.
