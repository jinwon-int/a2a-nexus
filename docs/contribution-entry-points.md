# Public contribution entry points

This page identifies public-safe first contribution surfaces for A2A Nexus. It satisfies the planning criteria for [#1179](https://github.com/jinwon-int/a2a-nexus/issues/1179) without assigning external contributors or opening additional child issues automatically.

## Selection rules

A good first contribution candidate must:

- be possible from a public checkout with no private credentials or production access;
- have a small file surface and clear validation command;
- avoid private topology, live broker URLs, provider identifiers, Telegram identifiers, production data, raw session dumps, and secrets;
- avoid release, package publication, deployment, homepage metadata, branch protection, database/outbox/ACK/replay, or notification/provider-send authority;
- leave final maintainer review and issue creation to normal PR/issue workflow.

## Candidate 1 — A2A compatibility example fixture

| Field | Value |
|---|---|
| Suggested label set | `good first issue`, `help wanted`, `a2a-public`, `promotion-readiness` |
| Expected files | `fixtures/compatibility/*`, `contracts/compatibility/*`, or docs explaining the fixture |
| Goal | Add a small, public-safe Agent Card / JSON-RPC compatibility example or clarify an existing example. |
| Validation | `npm run check:compatibility-baselines` and `npm run scan:public-readiness` |
| Non-goals | No production broker connection, no live worker enrollment, no provider send, no package publication. |

Acceptance criteria:

- the example uses placeholders or checked-in fixtures only;
- the change documents expected request/response shape without private endpoints;
- compatibility and public-readiness checks pass.

## Candidate 2 — Markdown/link/public-readiness fixture hardening

| Field | Value |
|---|---|
| Suggested label set | `good first issue`, `help wanted`, `documentation`, `validation` |
| Expected files | `scripts/check-markdown-links.mjs`, `scripts/public-readiness-scan.mjs`, test fixtures, or docs that describe them |
| Goal | Add a narrow fixture or documentation case for public docs safety, such as relative links, code-block links, or placeholder-only examples. |
| Validation | `npm run check:markdown-links`, `npm run scan:public-readiness`, and the focused node test if touched |
| Non-goals | No allowlist weakening, no private URL examples, no secret-pattern exception for real credentials. |

Acceptance criteria:

- the fixture is synthetic and clearly marked as such;
- any scanner exception is constrained to the test fixture;
- markdown links and public-readiness checks pass.

## Candidate 3 — Local quickstart example polish

| Field | Value |
|---|---|
| Suggested label set | `good first issue`, `help wanted`, `documentation`, `a2a-public` |
| Expected files | `docs/quickstart.md`, `examples/local/*`, `examples/demo/*`, or quickstart conformance fixtures |
| Goal | Improve the loopback-only quickstart with a clearer placeholder config, expected output, or teardown note. |
| Validation | `npm run check:quickstart-conformance`, `npm run smoke:quickstart` when feasible, and `npm run check:markdown-links` |
| Non-goals | No production broker, no Gateway restart, no Telegram/provider notification, no production data. |

Acceptance criteria:

- the example works with loopback/local placeholders only;
- expected output is redacted and reproducible;
- quickstart conformance and markdown-link checks pass.

## Parent tracker linkage

These candidates are related to [#1160](https://github.com/jinwon-int/a2a-nexus/issues/1160) because smoother public contribution intake supports external discoverability. #1160 itself remains the external directory listing tracker and should stay open until the remaining external directory PRs have final outcomes.

If maintainers choose to open child issues later, copy one candidate table into each child issue and keep the non-goals intact.
