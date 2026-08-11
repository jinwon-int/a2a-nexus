#!/usr/bin/env node
// Polls a child broker terminal-outbox and posts parent-owned cross-broker
// Terminal Brief projections to the parent broker. Default-off runtime wrapper.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";
import { pollCrossBrokerTerminalBriefReceiver } from "../dist/core/cross-broker-terminal-brief-receiver.js";

function envBool(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

const secretFileCache = new Map();

/**
 * Read a credential/key file named by an env var. The file must be root-only
 * (no group/other access) — fail closed otherwise. Values are cached and are
 * never logged.
 */
function envSecretFile(name) {
  const path = process.env[name];
  if (!path) return undefined;
  if (secretFileCache.has(path)) return secretFileCache.get(path);
  if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) {
    throw new Error(`${name} file must not be group/other accessible (expected 0600-style permissions): ${path}`);
  }
  const value = readFileSync(path, "utf8").trim();
  if (!value) throw new Error(`${name} file is empty: ${path}`);
  secretFileCache.set(path, value);
  return value;
}

function envNumber(name, fallback) {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function readCursor(path) {
  if (!path) return null;
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return typeof parsed.cursor === "string" ? parsed.cursor : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeCursor(path, cursor) {
  if (!path || !cursor) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ cursor, updatedAt: new Date().toISOString() }, null, 2) + "\n");
}

function buildConfig(cursor) {
  return {
    sourceBrokerId: process.env.CROSS_BROKER_SOURCE_BROKER_ID ?? "brokerbeta",
    sourceBaseUrl: process.env.CROSS_BROKER_SOURCE_BASE_URL ?? "http://127.0.0.1:8799",
    destinationBrokerId: process.env.CROSS_BROKER_DEST_BROKER_ID ?? "brokeralpha",
    destinationBaseUrl: process.env.CROSS_BROKER_DEST_BASE_URL ?? "http://127.0.0.1:8787",
    cursor,
    limit: envNumber("CROSS_BROKER_LIMIT", 50),
    reconcileUnacked: envBool("CROSS_BROKER_RECONCILE_UNACKED", true),
    requesterId: process.env.CROSS_BROKER_REQUESTER_ID,
    requesterRole: process.env.CROSS_BROKER_REQUESTER_ROLE === "operator" ? "operator" : "hub",
    sourceEdgeSecret: process.env.CROSS_BROKER_SOURCE_EDGE_SECRET,
    destinationEdgeSecret: process.env.CROSS_BROKER_DEST_EDGE_SECRET,
    edgeSecret: process.env.CROSS_BROKER_EDGE_SECRET,
    // Minimum-scope peer credentials (handoff:status toward the source
    // outbox, handoff:evidence toward the destination projection ingest).
    // Secrets are file-based (root-only) and never logged.
    sourcePeerBrokerId: process.env.CROSS_BROKER_SOURCE_PEER_BROKER_ID,
    sourcePeerSecret: envSecretFile("CROSS_BROKER_SOURCE_PEER_SECRET_FILE"),
    destinationPeerBrokerId: process.env.CROSS_BROKER_DEST_PEER_BROKER_ID,
    destinationPeerSecret: envSecretFile("CROSS_BROKER_DEST_PEER_SECRET_FILE"),
    // Request-bound sender proof (required once the destination pins this
    // sender's public key via CROSS_BROKER_SENDER_PROOF_KEYS_FILE).
    senderProofPrivateKeyPem: envSecretFile("CROSS_BROKER_SENDER_PROOF_PRIVATE_KEY_FILE"),
    senderProofBrokerId: process.env.CROSS_BROKER_SENDER_PROOF_BROKER_ID,
    senderProofKid: process.env.CROSS_BROKER_SENDER_PROOF_KID,
  };
}

async function once() {
  const cursorFile = process.env.CROSS_BROKER_CURSOR_FILE;
  const cursor = await readCursor(cursorFile);
  const result = await pollCrossBrokerTerminalBriefReceiver(buildConfig(cursor), fetch);
  // Persist any forward progress: the cursor may advance past permanently
  // skipped events even when a later event is blocked (result.ok === false).
  if (result.cursorToPersist && result.cursorToPersist !== cursor) {
    await writeCursor(cursorFile, result.cursorToPersist);
  } else if (result.ok) {
    await writeCursor(cursorFile, result.cursorToPersist);
  }
  console.log(JSON.stringify({
    kind: "a2a.cross-broker-terminal-brief-receiver.poll",
    ok: result.ok,
    fetched: result.fetched,
    ignored: result.ignored,
    posted: result.posted,
    accepted: result.accepted,
    replayed: result.replayed,
    blocked: result.blocked,
    skipped: result.skipped,
    cursorToPersist: result.cursorToPersist,
  }, null, 2));
  return result.ok ? 0 : 1;
}

if (!envBool("CROSS_BROKER_TERMINAL_BRIEF_RECEIVER_ENABLED") && !process.argv.includes("--once")) {
  console.log(JSON.stringify({
    kind: "a2a.cross-broker-terminal-brief-receiver.disabled",
    ok: true,
    reason: "set CROSS_BROKER_TERMINAL_BRIEF_RECEIVER_ENABLED=1 or run with --once",
  }, null, 2));
  process.exit(0);
}

const intervalMs = envNumber("CROSS_BROKER_POLL_INTERVAL_MS", 3000);
if (process.argv.includes("--once")) {
  process.exit(await once());
}

while (true) {
  await once();
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
}
