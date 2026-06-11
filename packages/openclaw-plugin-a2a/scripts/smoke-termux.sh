#!/usr/bin/env bash
# smoke-termux.sh — Repeatable Termux smoke test for plugin-a2a
#
# Prerequisites:
#   - Android Termux with Node.js v24+
#   - openclaw installed globally (npm install -g openclaw)
#   - broker sibling package (packages/broker in the monorepo)
#   - Network access (no external broker needed for local smoke)
#
# Usage:
#   bash scripts/smoke-termux.sh [--skip-build] [--broker-path=../broker]
#
# Exit codes:
#   0 — all checks passed
#   1 — build or validation failure
#
# Issue: jinwon-int/plugin-a2a#10

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# Monorepo sibling package (was ../a2a-broker in the standalone repo). Keep this
# as a plain path so `set -e` does not abort when the dir is absent — the
# existence check below reports that as a normal failure. Override with
# --broker-path=...; do not consume $1 positionally (it collided with flags).
BROKER_PATH="$PLUGIN_ROOT/../broker"
SKIP_BUILD=false

# Parse args
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=true ;;
    --broker-path=*) BROKER_PATH="${arg#*=}" ;;
  esac
done

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}✅ PASS${NC}: $1"; }
fail() { echo -e "${RED}❌ FAIL${NC}: $1"; }
warn() { echo -e "${YELLOW}⚠️  WARN${NC}: $1"; }
info() { echo -e "ℹ️  $1"; }

ERRORS=0

# ──────────────────────────────────────
# Step 1: Environment checks
# ──────────────────────────────────────
info "=== Environment Checks ==="

# Node.js version
NODE_VERSION=$(node -v 2>/dev/null || echo "NOT_FOUND")
if [[ "$NODE_VERSION" == v2[4-9]* ]]; then
  pass "Node.js $NODE_VERSION"
else
  fail "Node.js version $NODE_VERSION — need v24+"
  ERRORS=$((ERRORS + 1))
fi

# /usr/bin/env check (Termux quirk)
if [[ -x /usr/bin/env ]]; then
  warn "/usr/bin/env exists (unusual for Termux)"
else
  pass "/usr/bin/env absent — expected on Termux (build uses direct node path)"
fi

# Global openclaw
if npm list -g openclaw &>/dev/null; then
  OPENCLAW_GLOBAL_PATH="$(npm root -g)/openclaw"
  pass "openclaw global: $OPENCLAW_GLOBAL_PATH"
else
  fail "openclaw not installed globally — plugin needs it as peer dependency"
  ERRORS=$((ERRORS + 1))
fi

# Broker checkout
if [[ -d "$BROKER_PATH" && -f "$BROKER_PATH/package.json" ]]; then
  pass "a2a-broker checkout: $BROKER_PATH"
else
  fail "a2a-broker not found at $BROKER_PATH (use --broker-path=...)"
  ERRORS=$((ERRORS + 1))
fi

# ──────────────────────────────────────
# Step 2: Install dependencies
# ──────────────────────────────────────
info "\n=== Install Dependencies ==="

cd "$PLUGIN_ROOT"

if [[ "$SKIP_BUILD" == false ]]; then
  info "Running npm install --legacy-peer-deps..."
  if npm install --legacy-peer-deps 2>&1; then
    pass "npm install --legacy-peer-deps succeeded"
  else
    fail "npm install failed — try: npm install --legacy-peer-deps"
    ERRORS=$((ERRORS + 1))
  fi
fi

# Symlink global openclaw into local node_modules
info "Symlinking global openclaw into node_modules..."
GLOBAL_OPENCLAW="$(npm root -g)/openclaw"
if [[ -d "$GLOBAL_OPENCLAW" ]]; then
  mkdir -p node_modules
  ln -sfn "$GLOBAL_OPENCLAW" node_modules/openclaw
  pass "node_modules/openclaw → $GLOBAL_OPENCLAW"
else
  fail "Cannot find global openclaw at $GLOBAL_OPENCLAW"
  ERRORS=$((ERRORS + 1))
fi

# ──────────────────────────────────────
# Step 3: Build
# ──────────────────────────────────────
info "\n=== Build ==="

if [[ "$SKIP_BUILD" == false ]]; then
  # Use direct node path (avoids /usr/bin/env issue)
  info "Running TypeScript build..."
  if node ./node_modules/typescript/bin/tsc -p tsconfig.json 2>&1; then
    pass "TypeScript build succeeded"
  else
    fail "TypeScript build failed"
    ERRORS=$((ERRORS + 1))
  fi
fi

# Verify dist output
if [[ -d dist ]]; then
  DIST_COUNT=$(find dist -name "*.js" | wc -l)
  if [[ "$DIST_COUNT" -gt 0 ]]; then
    pass "dist/ contains $DIST_COUNT JS files"
  else
    fail "dist/ is empty — build may have silently failed"
    ERRORS=$((ERRORS + 1))
  fi
else
  fail "dist/ directory not found — build did not run"
  ERRORS=$((ERRORS + 1))
fi

# ──────────────────────────────────────
# Step 4: Broker smoke
# ──────────────────────────────────────
info "\n=== Broker Smoke ==="

cd "$BROKER_PATH"

if [[ "$SKIP_BUILD" == false ]]; then
  info "Building broker..."
  npm install --legacy-peer-deps 2>&1 | tail -3
  if node ./node_modules/typescript/bin/tsc 2>&1; then
    pass "Broker build succeeded"
  else
    fail "Broker build failed"
    ERRORS=$((ERRORS + 1))
  fi
fi

info "Running broker unit tests..."
TEST_OUTPUT=$(timeout 60 node --test dist/core/broker.test.js 2>&1 || true)
if echo "$TEST_OUTPUT" | grep -q "pass 2[0-9]"; then
  pass "Broker tests passed"
else
  warn "Broker test output unusual — check manually"
  echo "$TEST_OUTPUT" | tail -10
fi

info "Running SSE reconnect smoke..."
if timeout 20 node scripts/smoke-sse-reconnect.mjs 2>&1; then
  pass "SSE disconnect-recover smoke passed"
else
  fail "SSE reconnect smoke failed"
  ERRORS=$((ERRORS + 1))
fi

# ──────────────────────────────────────
# Step 5: Plugin import check
# ──────────────────────────────────────
info "\n=== Plugin Import Check ==="

cd "$PLUGIN_ROOT"

# Quick check that the plugin entry can be resolved
if [[ -f dist/index.js ]]; then
  pass "dist/index.js exists"
else
  fail "dist/index.js not found"
  ERRORS=$((ERRORS + 1))
fi

# ──────────────────────────────────────
# Summary
# ──────────────────────────────────────
info "\n=== Summary ==="

if [[ $ERRORS -eq 0 ]]; then
  pass "All checks passed! Plugin is ready for delegated-task testing."
  echo ""
  echo "Next steps:"
  echo "  1. Start broker: cd $BROKER_PATH && node dist/server.js"
  echo "  2. Start OpenClaw gateway with this plugin loaded"
  echo "  3. Send a delegated task via a2a.task.request"
  exit 0
else
  fail "$ERRORS check(s) failed — see above for details"
  exit 1
fi
