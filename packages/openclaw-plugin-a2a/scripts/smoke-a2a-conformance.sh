#!/usr/bin/env bash
set -euo pipefail

# ── A2A Inspector / a2a-python conformance smoke gate (#267) ──────────
# Repeatable local/CI smoke command that runs the complete no-live
# conformance gate against test fixtures.
#
# Safety: no live broker, no provider send, no Gateway restart, no
# terminal-outbox ACK, no production deploy.
#
# Parent: a2a-plane#232
# Ref:    jinwon-int/openclaw-plugin-a2a#234

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "=== A2A Inspector / a2a-python conformance smoke gate (#267) ==="
echo ""

# ── Step 1: Public-readiness scan ────────────────────────────────────
echo "[1/4] Running public-readiness scan …"
npm run scan:public-readiness
echo ""

# ── Step 2: Build the plugin ─────────────────────────────────────────
echo "[2/4] Building plugin …"
npm run build
echo ""

# ── Step 3: Run conformance smoke gate tests ──────────────────────────
echo "[3/4] Running A2A conformance smoke gate tests …"
node --test test/conformance-smoke-gate.test.mjs
echo ""

# ── Step 4: Run agent card discovery tests ───────────────────────────
echo "[4/4] Running agent card discovery tests …"
node --test test/agent-card-discovery.test.mjs
echo ""

# ── Summary ───────────────────────────────────────────────────────────
echo "=== A2A Inspector conformance smoke gate PASSED ==="
echo ""
echo "Verified:"
echo "  - A2A public gateway schema conformance (9 schemas)"
echo "  - Handler fail-closed (broker unavailable)"
echo "  - Receipt-runtime boundary (fail-closed)"
echo "  - Agent card shape conformance (a2a-inspector profile)"
echo "  - Safe operations: all false (no live send, no deploy)"
echo "  - Public-readiness: no secret/token leakage"
echo ""
echo "No live broker, provider send, Gateway restart, or terminal-outbox ACK occurred."
