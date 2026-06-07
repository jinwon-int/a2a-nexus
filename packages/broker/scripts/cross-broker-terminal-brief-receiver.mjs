#!/usr/bin/env node
// Polls a child broker terminal-outbox and posts parent-owned cross-broker
// Terminal Brief projections to the parent broker. Default-off runtime wrapper.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import process from "node:process";
import { pollCrossBrokerTerminalBriefReceiver } from "../dist/core/cross-broker-terminal-brief-receiver.js";

function envBool(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
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
    sourceBrokerId: process.env.CROSS_BROKER_SOURCE_BROKER_ID ?? "gwakga",
    sourceBaseUrl: process.env.CROSS_BROKER_SOURCE_BASE_URL ?? "http://127.0.0.1:8799",
    destinationBrokerId: process.env.CROSS_BROKER_DEST_BROKER_ID ?? "seoseo",
    destinationBaseUrl: process.env.CROSS_BROKER_DEST_BASE_URL ?? "http://127.0.0.1:8787",
    cursor,
    limit: envNumber("CROSS_BROKER_LIMIT", 50),
    reconcileUnacked: envBool("CROSS_BROKER_RECONCILE_UNACKED", true),
    requesterId: process.env.CROSS_BROKER_REQUESTER_ID,
    requesterRole: process.env.CROSS_BROKER_REQUESTER_ROLE === "operator" ? "operator" : "hub",
    sourceEdgeSecret: process.env.CROSS_BROKER_SOURCE_EDGE_SECRET,
    destinationEdgeSecret: process.env.CROSS_BROKER_DEST_EDGE_SECRET,
    edgeSecret: process.env.CROSS_BROKER_EDGE_SECRET,
  };
}

async function once() {
  const cursorFile = process.env.CROSS_BROKER_CURSOR_FILE;
  const cursor = await readCursor(cursorFile);
  const result = await pollCrossBrokerTerminalBriefReceiver(buildConfig(cursor), fetch);
  if (result.ok) await writeCursor(cursorFile, result.cursorToPersist);
  console.log(JSON.stringify({
    kind: "a2a.cross-broker-terminal-brief-receiver.poll",
    ok: result.ok,
    fetched: result.fetched,
    ignored: result.ignored,
    posted: result.posted,
    accepted: result.accepted,
    replayed: result.replayed,
    blocked: result.blocked,
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
