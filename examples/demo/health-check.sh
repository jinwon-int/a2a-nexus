#!/usr/bin/env bash
# health-check.sh — Verify A2A Nexus broker health endpoints.
# Usage: ./health-check.sh [base-url]
#   base-url defaults to http://127.0.0.1:8787
#
# No-live, no-deploy, read-only health probe. Designed for the single-node
# quickstart and two-broker demo.

set -euo pipefail

BASE="${1:-http://127.0.0.1:8787}"
FAILED=0

check() {
  local label="$1" url="$2" expected="$3"
  local response
  response="$(curl -sf "$url" 2>/dev/null)" || {
    echo "FAIL  $label — endpoint unreachable at $url"
    FAILED=1
    return
  }
  if echo "$response" | grep -q "$expected"; then
    echo "OK    $label"
  else
    echo "FAIL  $label — expected pattern '$expected' not found in response"
    echo "      Response: $(echo "$response" | head -c 200)"
    FAILED=1
  fi
}

echo "=== A2A Nexus Health Check ==="
echo "Broker URL: ${BASE}"
echo ""

check "/health returns ok"      "${BASE}/health"           '"ok":true'
check "/health has service"     "${BASE}/health"           '"service"'
check "/health has version"     "${BASE}/health"           '"version"'
check "/health has uptime"      "${BASE}/health"           '"uptimeSec"'
check "/health has persistence" "${BASE}/health"           '"persistence"'
check "/health has staleReaper" "${BASE}/health"           '"staleReaper"'
check "/well-known/agent-card"  "${BASE}/.well-known/agent-card.json" '"agentCard"'
check "/workers/capacity"       "${BASE}/workers/capacity" '"totalWorkers"'

echo ""
if [ "$FAILED" -eq 0 ]; then
  echo "All health checks passed."
else
  echo "Some health checks FAILED."
  exit 1
fi
