#!/usr/bin/env bash
# teardown.sh — Stop A2A Plane demo processes and clean up state.
# Usage: ./teardown.sh
#
# Safe to run multiple times. Stops both Docker Compose stacks and local
# broker processes. Does not touch production services.

set -euo pipefail

echo "=== A2A Plane Teardown ==="

# Docker Compose: trading-partners (two-broker)
COMPOSE_FILE="packages/broker/examples/docker-compose.trading-partners.yml"
if [ -f "$COMPOSE_FILE" ]; then
  echo "[1/4] Stopping two-broker Docker stack..."
  docker compose -f "$COMPOSE_FILE" down -v --remove-orphans 2>/dev/null && echo "  done" || echo "  (not running or unavailable)"
else
  echo "[1/4] Skipping Docker Compose (file not found: $COMPOSE_FILE)"
fi

# Docker Compose: single-broker
COMPOSE_FILE_SINGLE="packages/broker/docker-compose.yml"
if [ -f "$COMPOSE_FILE_SINGLE" ]; then
  echo "[2/4] Stopping single-broker Docker stack..."
  docker compose -f "$COMPOSE_FILE_SINGLE" down -v --remove-orphans 2>/dev/null && echo "  done" || echo "  (not running or unavailable)"
else
  echo "[2/4] Skipping single-broker Docker Compose (file not found: $COMPOSE_FILE_SINGLE)"
fi

# Local broker processes (started directly via npm run start:local)
echo "[3/4] Checking for local node broker processes on port 8787..."
BROKER_PID="$(lsof -ti tcp:8787 2>/dev/null || true)"
if [ -n "$BROKER_PID" ]; then
  echo "  Found broker PID(s): $BROKER_PID — sending SIGTERM..."
  kill "$BROKER_PID" 2>/dev/null || true
  sleep 1
  # Force kill if still alive
  REMAINING="$(lsof -ti tcp:8787 2>/dev/null || true)"
  if [ -n "$REMAINING" ]; then
    echo "  Force-killing remaining process(es)..."
    kill -9 "$REMAINING" 2>/dev/null || true
  fi
  echo "  done"
else
  echo "  no local broker process found"
fi

# Clean up persisted state
echo "[4/4] Cleaning up local state files..."
rm -f /tmp/a2a-broker-state.json 2>/dev/null || true
rm -rf /tmp/a2a-broker-sqlite/ 2>/dev/null || true

echo ""
echo "Verification:"
lsof -i :8787 2>/dev/null && echo "  WARNING: Port 8787 still in use!" || echo "  Port 8787: free"
lsof -i :8788 2>/dev/null && echo "  WARNING: Port 8788 still in use!" || echo "  Port 8788: free"
echo ""
echo "Teardown complete."
