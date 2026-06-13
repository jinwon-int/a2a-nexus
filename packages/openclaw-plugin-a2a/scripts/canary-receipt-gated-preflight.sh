#!/usr/bin/env bash
set -euo pipefail

# Canary preflight for the Gateway config bridge + receipt-gated
# terminal-outbox notifier.
#
# Issue:  jinwon-int/plugin-a2a#269
# Parent: jinwon-int/a2a-plane#241
# Run:    terminal-brief-activation-20260511T080211Z
#
# Safe by design: this script runs local build/tests only. It does not deploy,
# restart Gateway, send Telegram messages, or ACK terminal-outbox records.
#
# Config bridge safety:
#  - Plugin-level config only (no core Gateway config change)
#  - Always backup → apply → verify → rollback-on-fail
#  - No live provider send without explicit operator approval

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

CURRENT_COMMIT="$(git rev-parse HEAD 2>/dev/null || true)"

cat <<EOF
A2A plugin Gateway config bridge canary preflight (#269)
- run: terminal-brief-activation-20260511T080211Z
- current repository commit: ${CURRENT_COMMIT:-unknown}
- live operations: disabled (no deploy, no Gateway restart, no Telegram send, no terminal-outbox ACK)
- config bridge: backup → apply → verify → rollback-on-fail
EOF

# Phase 1: Build
echo "--- Phase 1: Build ---"
npm run build

# Phase 2: Config bridge tests (safe config backup/restore/diff/rollback)
echo "--- Phase 2: Gateway config bridge tests ---"
node --test src/gateway-config-bridge.test.ts

# Phase 3: Operator event bridge tests (receipt-gated runtime + deploy-preflight projection)
echo "--- Phase 3: Operator event bridge tests ---"
node --test test/operator-event-bridge.test.mjs

# Phase 4: Full test suite (notification preflight, no-live canary harness, etc.)
echo "--- Phase 4: Full test suite ---"
npm test

cat <<'EOF'
Receipt-gated no-live preflight passed.
Provider/Gateway send success alone is NOT terminal ACK evidence; only
current-session/user-visible or explicit manual operator receipt may unlock ACK.

Gateway config bridge safety invariants:
- Plugin-level config only (no core Gateway config change)
- Backup → apply → verify → rollback-on-fail enforced
- No live provider send without explicit operator approval
- Rollback always restores exact pre-snapshot state
EOF
