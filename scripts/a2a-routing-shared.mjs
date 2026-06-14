#!/usr/bin/env node
/**
 * Shared helpers for the A2A routing / fleet-readiness preflight scripts
 * (a2a-broker-id-routing, a2a-worker-readiness-preflight, a2a-fleet-routing-guard).
 * Consolidated to remove copy-pasted definitions (repo-cleanup survey).
 *
 * Pure and dependency-free — no SSH, network, or runtime side effects.
 */

// Canonical team ↔ home-broker invariant (#633 / #630): team1 → seoseo, team2 → gwakga.
export const TEAM_BROKER_INVARIANT = { team1: "seoseo", team2: "gwakga" };

export function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function normalizeUrl(value) {
  // Trailing slashes and surrounding whitespace are not meaningful for routing.
  return hasText(value) ? value.trim().replace(/\/+$/, "") : value;
}
