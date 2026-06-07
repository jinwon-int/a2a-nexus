# Contributing to openclaw-plugin-a2a

This repository is the extracted plugin home for the A2A broker adapter. Contributions must respect the plugin's safety boundaries and public-readiness requirements.

## Safety gates (mandatory)

All changes must pass these gates:

1. **No live send** — do not enable `operatorEvents.notification.enabled` or add live notification delivery in tests, examples, or config defaults.
2. **No terminal ACK** — do not treat provider/gateway send success as broker terminal-outbox acknowledgement.
3. **No production deploy** — do not add Gateway restart, broker restart, or production config mutation paths without explicit operator approval.
4. **No secret leakage** — run `npm run scan:public-readiness` and ensure it passes; never commit real broker URLs, edge secrets, Telegram chat IDs, or tokens.
5. **Context-file hygiene** — keep OpenClaw runtime/bootstrap files out of commits (`.openclaw/`, `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`). They are already in `.gitignore`.

## Development setup

```bash
git clone <this-repo>
cd openclaw-plugin-a2a
npm ci
npm run build
```

### Running tests

```bash
npm test
```

This runs the full test suite including conformance smoke gates, receipt-runtime boundary checks, and the public-readiness scan.

### No-live canary

```bash
npm run build
node --test tests/no-live-canary.test.ts
```

Exercises all four notification boundary conditions without sending any live message or mutating external state.

## What belongs here

- OpenClaw gateway/plugin methods for A2A task request, status, cancel, and monitoring projection
- Broker client configuration and task/error mapping at the plugin boundary
- Plugin-owned protocol compatibility docs and regression coverage

## What does NOT belong here

- Broker control plane code
- Docker runner internals
- OpenClaw core extensions
- Live operator notification targets or secrets
- Production deployment scripts

## Pull request checklist

Before opening a PR:

- [ ] `npm test` passes
- [ ] `npm run scan:public-readiness` passes
- [ ] No runtime/bootstrap context files staged (`.openclaw/`, `AGENTS.md`, etc.)
- [ ] No real secrets, broker URLs, or Telegram chat IDs in code or docs
- [ ] Notification defaults remain `false` (fail-closed)
- [ ] Relevant docs in `docs/` are updated
- [ ] If changing the compatibility surface, update `docs/compatibility-matrix.md`

## Alpha boundaries

This plugin is **alpha** (unpublished, `"private": true`). Contributions should:
- Keep version ranges narrow in compatibility claims
- Mark experimental features clearly
- Treat seam availability as a first-class compatibility rule
- Not claim broad stable compatibility until the delegated-task runtime extraction is complete

## Code style

- TypeScript with strict mode
- Exports from `index.ts` and subpath entry points (`api.ts`, `config.ts`, etc.)
- Plugin ID: `a2a-broker-adapter`
