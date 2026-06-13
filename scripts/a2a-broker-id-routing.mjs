#!/usr/bin/env node
/**
 * A2A broker-id routing — make A2A_HOME_BROKER_ID the primary routing key and
 * derive/validate BROKER_URL from it (#633, ref #630).
 *
 * The fleet incident in #633 was a worker whose BROKER_URL was overwritten to
 * the wrong broker while its A2A_HOME_BROKER_ID still named the correct one.
 * `fleet:routing-guard` validates an observed brokerUrl against a per-team
 * expectation; this module is the complementary piece: it treats homeBrokerId
 * as the source of truth, resolves the canonical URL from a broker registry,
 * and fails closed when a declared URL disagrees with the id-derived one or the
 * team↔broker invariant is broken.
 *
 * Pure offline resolution/validation. No SSH, network, restart, DB/outbox
 * mutation, secret movement, or runtime execution. Broker URLs come from an
 * operator-supplied registry file — none are hardcoded here.
 */
import fs from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

// Canonical team ↔ home-broker invariant (the mapping recorded in #633/#630).
export const TEAM_BROKER_INVARIANT = { team1: "seoseo", team2: "gwakga" };

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeUrl(value) {
  return hasText(value) ? value.trim().replace(/\/+$/, "") : value;
}

/**
 * Resolve a single node's broker routing from its declared keys + a registry.
 *
 * @param {{ node?: string, teamId?: string, homeBrokerId?: string, brokerUrl?: string }} node
 * @param {{ brokers: Record<string, { teamId: string, url?: string }> }} registry
 * @returns {{ node: string, ok: boolean, brokerId: string|null, teamId: string|null,
 *            resolvedUrl: string|null, source: "declared"|"derived"|null, violations: object[] }}
 */
export function resolveNodeRouting(node, registry) {
  const name = hasText(node?.node) ? node.node.trim() : "(unnamed)";
  const violations = [];
  const brokers = registry && typeof registry.brokers === "object" && registry.brokers ? registry.brokers : {};

  const homeBrokerId = hasText(node?.homeBrokerId) ? node.homeBrokerId.trim() : null;
  const declaredTeam = hasText(node?.teamId) ? node.teamId.trim() : null;
  const declaredUrl = hasText(node?.brokerUrl) ? normalizeUrl(node.brokerUrl) : null;

  // Primary key: homeBrokerId. Without it there is no id-based routing.
  if (!homeBrokerId) {
    violations.push({ node: name, code: "missing_routing_keys", reason: "A2A_HOME_BROKER_ID is required as the primary routing key" });
    return { node: name, ok: false, brokerId: null, teamId: declaredTeam, resolvedUrl: null, source: null, violations };
  }

  const registered = brokers[homeBrokerId];
  if (!registered) {
    violations.push({ node: name, code: "broker_id_unknown", reason: `home broker id '${homeBrokerId}' is not in the registry` });
    return { node: name, ok: false, brokerId: homeBrokerId, teamId: declaredTeam, resolvedUrl: null, source: null, violations };
  }

  const registryTeam = hasText(registered.teamId) ? registered.teamId.trim() : null;

  // team ↔ broker-id invariant: the declared team (if any) and the registry's
  // team for this broker must agree, and both must match the canonical mapping.
  const expectedBrokerForTeam = declaredTeam ? TEAM_BROKER_INVARIANT[declaredTeam] : undefined;
  if (declaredTeam && registryTeam && declaredTeam !== registryTeam) {
    violations.push({ node: name, code: "team_broker_mismatch", reason: `node team '${declaredTeam}' != registry team '${registryTeam}' for broker '${homeBrokerId}'` });
  }
  if (declaredTeam && expectedBrokerForTeam && expectedBrokerForTeam !== homeBrokerId) {
    violations.push({ node: name, code: "team_broker_mismatch", reason: `team '${declaredTeam}' must route to '${expectedBrokerForTeam}', not '${homeBrokerId}'` });
  }

  // Derive the canonical URL from the id; a declared URL must agree with it.
  const registryUrl = hasText(registered.url) ? normalizeUrl(registered.url) : null;
  let resolvedUrl = null;
  let source = null;
  if (declaredUrl) {
    if (registryUrl && declaredUrl !== registryUrl) {
      violations.push({ node: name, code: "url_id_disagreement", reason: `declared BROKER_URL '${declaredUrl}' != url for home broker '${homeBrokerId}' ('${registryUrl}')` });
    }
    resolvedUrl = declaredUrl;
    source = "declared";
  } else if (registryUrl) {
    resolvedUrl = registryUrl; // derive from id when BROKER_URL is absent
    source = "derived";
  } else {
    violations.push({ node: name, code: "missing_routing_keys", reason: `no BROKER_URL declared and registry has no url for '${homeBrokerId}'` });
  }

  return {
    node: name,
    ok: violations.length === 0,
    brokerId: homeBrokerId,
    teamId: declaredTeam ?? registryTeam,
    resolvedUrl,
    source,
    violations,
  };
}

/** Validate the registry's broker→team mapping against the canonical invariant. */
export function validateRegistry(registry) {
  const errors = [];
  const brokers = registry && typeof registry.brokers === "object" && registry.brokers ? registry.brokers : null;
  if (!brokers) return ["registry.brokers is required"];
  for (const [id, cfg] of Object.entries(brokers)) {
    if (!cfg || typeof cfg !== "object") {
      errors.push(`registry.brokers.${id} must be an object`);
      continue;
    }
    if (!hasText(cfg.teamId)) errors.push(`registry.brokers.${id}.teamId is required`);
    const expected = TEAM_BROKER_INVARIANT[cfg.teamId];
    if (expected && expected !== id) {
      errors.push(`registry.brokers.${id} is mapped to team '${cfg.teamId}', but '${cfg.teamId}' must route to '${expected}'`);
    }
  }
  return errors;
}

/** Validate a fleet of declared nodes. */
export function validateFleetRouting(nodes, registry) {
  const registryErrors = validateRegistry(registry);
  if (registryErrors.length) {
    return { ok: false, malformed: true, inputErrors: registryErrors, rows: [], violations: [] };
  }
  if (!Array.isArray(nodes)) {
    return { ok: false, malformed: true, inputErrors: ["nodes must be an array"], rows: [], violations: [] };
  }
  const rows = nodes.map((node) => resolveNodeRouting(node, registry));
  const violations = rows.flatMap((r) => r.violations);
  return { ok: violations.length === 0, malformed: false, inputErrors: [], rows, violations };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      registry: { type: "string", default: "" },
      nodes: { type: "string", default: "" },
      json: { type: "boolean", default: false },
    },
  });

  if (!values.registry || !values.nodes) {
    process.stderr.write(JSON.stringify({ ok: false, error: "both --registry <file> and --nodes <file> are required" }, null, 2) + "\n");
    process.exit(1);
  }

  let registry;
  let nodes;
  try {
    registry = readJson(values.registry);
  } catch (error) {
    process.stderr.write(JSON.stringify({ ok: false, malformed: true, error: `cannot read/parse --registry: ${error.message}` }, null, 2) + "\n");
    process.exit(1);
  }
  try {
    nodes = readJson(values.nodes);
  } catch (error) {
    process.stderr.write(JSON.stringify({ ok: false, malformed: true, error: `cannot read/parse --nodes: ${error.message}` }, null, 2) + "\n");
    process.exit(1);
  }

  const result = validateFleetRouting(nodes, registry);
  const exitCode = result.ok ? 0 : 1;
  const sink = exitCode === 0 ? process.stdout : process.stderr;
  sink.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(exitCode);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
