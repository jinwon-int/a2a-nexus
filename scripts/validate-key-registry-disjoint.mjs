#!/usr/bin/env node
/**
 * Disjoint role-registry validator (#1383 V-c).
 *
 * The structural source of finalizer independence is that finalizer, worker,
 * and broker keys live in DISJOINT role registries — the gate's explicit
 * producing-key check (scripts/check-finalizer-verdict.mjs) is only
 * belt-and-suspenders. This validator enforces the disjointness three ways,
 * fail-closed:
 *
 *   1. keyId ROLE PREFIX — every keyId carries its role namespace:
 *      worker keys `worker:`, finalizer keys `finalizer:`, broker keys `broker:`.
 *   2. keyId GLOBAL UNIQUENESS — no keyId appears in more than one registry.
 *   3. PUBLIC KEY UNIQUENESS (load-bearing) — no public key appears under two
 *      roles, compared on a normalized SPKI-PEM form so the SAME Ed25519 keypair
 *      cannot be registered as both (e.g.) a worker and a finalizer even if one
 *      side stores it as a JWK and the other as a PEM.
 *
 * Each registry is accepted in its NATIVE shape:
 *   - worker: A2AHttpSignatureKeyRegistry — Record<keyId, { publicKeyJwk, ... }>
 *   - finalizer: { keys: { [keyId]: pem }, roots?: [] }
 *   - brokerCountersign: Record<keyId, { pem }> | Record<keyId, pem>
 *
 * Read-only, node:crypto only. No broker dependency, no network, no writes.
 *
 * Usage:
 *   node scripts/validate-key-registry-disjoint.mjs \
 *     [--worker w.json] [--finalizer f.json] [--broker b.json] [--json]
 * Exit 0 = disjoint; 1 = violations; 2 = read/usage error.
 */
import fs from "node:fs";
import { createPublicKey } from "node:crypto";
import { parseArgs } from "node:util";

const ROLE_PREFIX = { worker: "worker:", finalizer: "finalizer:", broker: "broker:" };

/** Normalize any public key (JWK object or PEM string) to canonical SPKI PEM. */
function normalizePublicKey(material) {
  if (material && typeof material === "object") {
    return createPublicKey({ key: material, format: "jwk" }).export({ type: "spki", format: "pem" }).toString();
  }
  if (typeof material === "string") {
    return createPublicKey(material).export({ type: "spki", format: "pem" }).toString();
  }
  throw new Error("public key material is neither a JWK object nor a PEM string");
}

/** Extract [keyId, rawPublicKeyMaterial] pairs from a registry in native shape. */
function extractEntries(role, registry) {
  if (registry === undefined || registry === null) return [];
  if (role === "finalizer") {
    const keys = registry.keys && typeof registry.keys === "object" ? registry.keys : {};
    return Object.entries(keys).map(([keyId, pem]) => [keyId, pem]);
  }
  // worker + broker: Record<keyId, record|string>. Pull the public key material
  // out of whichever field carries it.
  return Object.entries(registry).map(([keyId, record]) => {
    if (typeof record === "string") return [keyId, record];
    if (record && typeof record === "object") {
      return [keyId, record.publicKeyJwk ?? record.pem ?? record.publicKeyPem ?? record.publicKey];
    }
    return [keyId, undefined];
  });
}

/**
 * Validate that the supplied registries are role-disjoint. Every argument is
 * optional; only the supplied subset is checked. Returns a list of problems
 * (empty = disjoint). Pure and deterministic.
 */
export function validateKeyRegistryDisjoint({ worker, finalizer, brokerCountersign } = {}) {
  const problems = [];
  const roles = [
    ["worker", worker],
    ["finalizer", finalizer],
    ["broker", brokerCountersign],
  ];

  const keyIdOwner = new Map(); // keyId -> role
  const pubKeyOwner = new Map(); // normalized PEM -> `${role}:${keyId}`

  for (const [role, registry] of roles) {
    for (const [keyId, material] of extractEntries(role, registry)) {
      // 1. role prefix
      if (!keyId.startsWith(ROLE_PREFIX[role])) {
        problems.push(`${role} registry keyId '${keyId}' must carry the '${ROLE_PREFIX[role]}' role prefix`);
      }
      // 2. keyId global uniqueness
      const priorRole = keyIdOwner.get(keyId);
      if (priorRole !== undefined) {
        problems.push(`keyId '${keyId}' appears in both the ${priorRole} and ${role} registries (keyIds must be globally unique)`);
      } else {
        keyIdOwner.set(keyId, role);
      }
      // 3. public key uniqueness (normalized)
      let normalized;
      try {
        normalized = normalizePublicKey(material);
      } catch (error) {
        problems.push(`${role} registry keyId '${keyId}' has an invalid/unparseable public key: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      const priorOwner = pubKeyOwner.get(normalized);
      if (priorOwner !== undefined) {
        const [priorRole2, priorKeyId] = priorOwner.split(/:(.*)/s);
        problems.push(`the same public key is registered under two roles: ${priorRole2} '${priorKeyId}' and ${role} '${keyId}' — a keypair must not be dual-role (structural independence)`);
      } else {
        pubKeyOwner.set(normalized, `${role}:${keyId}`);
      }
    }
  }
  return problems;
}

function readJsonOrNull(file) {
  if (!file) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function main(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        worker: { type: "string" },
        finalizer: { type: "string" },
        broker: { type: "string" },
        json: { type: "boolean", default: false },
      },
    }));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (!values.worker && !values.finalizer && !values.broker) {
    process.stderr.write("usage: validate-key-registry-disjoint.mjs [--worker w.json] [--finalizer f.json] [--broker b.json] [--json]\n");
    return 2;
  }
  let problems;
  try {
    problems = validateKeyRegistryDisjoint({
      worker: readJsonOrNull(values.worker),
      finalizer: readJsonOrNull(values.finalizer),
      brokerCountersign: readJsonOrNull(values.broker),
    });
  } catch (error) {
    process.stderr.write(`cannot read registry: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (values.json) {
    process.stdout.write(`${JSON.stringify({ ok: problems.length === 0, problems }, null, 2)}\n`);
    return problems.length ? 1 : 0;
  }
  if (problems.length) {
    process.stderr.write(`key registry disjointness FAILED (${problems.length} problem(s)):\n`);
    for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
    return 1;
  }
  process.stdout.write("key registries are role-disjoint (prefix + keyId + public key)\n");
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
