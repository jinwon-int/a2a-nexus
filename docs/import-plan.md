# Import Plan

1. Keep `a2a-plane (internal tracker, private)` private.
2. Import each source repo by sanitized/squash copy into its package directory.
3. Preserve provenance in package README files: source repo, source commit, import date, and known blockers.
4. Do not preserve private history by default.
5. Run package-local checks first, then root integrated checks.
6. Leave original repos private until the monorepo candidate passes readiness gates and rollback criteria are documented.
