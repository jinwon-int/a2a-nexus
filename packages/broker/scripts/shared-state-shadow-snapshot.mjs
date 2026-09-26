#!/usr/bin/env node
// Aggregate-only evidence snapshot of the broker's `/health.stateShadow`
// block (#1504 Phase 7 prerequisite P2).
//
// Why this exists: the Phase 6 shadow counters (compared / matches /
// warmupMismatches / unexplained per family) live only in broker process
// memory. Every restart — a deploy, a container recreate, or an unattended
// host reboot (T1 rebooted 2026-09-12 and 2026-09-26 at 03:15 KST) — resets
// them, and the evidence for the window that just ended is gone. Phase 7
// needs that number *on disk* immediately before the cutover stop (plan step
// A1) so gate 4 ("shadow unexplained = 0") is decided from a durable record,
// not from memory of a chat message.
//
// What it does:
//   1. reads `/health` from a loopback broker (or a saved body via --input);
//   2. keeps ONLY the allowlisted aggregate counters — no keys, nonces,
//      identities, or any other `/health` field reach the output
//      (§5.5/§5.6 observability rules);
//   3. checks the runtime invariant compared = matches + warmupMismatches +
//      unexplained for each family;
//   4. writes one JSON evidence file (mode 0600, never overwrites) and prints
//      a one-line verdict.
//
// Exit codes: 0 pass (unexplained = 0 in both families) · 2 unexplained > 0
// (Phase 7 must stop) · 3 no usable evidence (fetch failed, no stateShadow
// block, malformed counters, or write failed) · 64 usage error.
//
// Read-only against the broker: a single GET /health. It never restarts,
// deploys, flips flags, or touches any state file.
//
// The edge secret is read from the environment only (BROKER_EDGE_SECRET,
// A2A_BROKER_EDGE_SECRET, EDGE_SECRET, A2A_EDGE_SECRET) — never from argv,
// where it would show up in `ps` — and is never printed or written.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const SNAPSHOT_KIND = "a2a-broker.state-shadow-snapshot.v1";
export const ISSUE = "#1504";
const DEFAULT_BASE_URL = "http://127.0.0.1:8787";
const DEFAULT_TIMEOUT_MS = 15_000;
const FAMILIES = ["replay", "rate"];
const COUNTERS = ["compared", "matches", "warmupMismatches", "unexplained"];
const EDGE_SECRET_ENV = ["BROKER_EDGE_SECRET", "A2A_BROKER_EDGE_SECRET", "EDGE_SECRET", "A2A_EDGE_SECRET"];

export const EXIT = Object.freeze({ pass: 0, unexplained: 2, noEvidence: 3, usage: 64 });

class UsageError extends Error {}

const USAGE = `usage: shared-state-shadow-snapshot.mjs --out <file> [options]

  --out <file>        evidence file to create (refuses to overwrite)
  --stdout            print the snapshot JSON instead of writing a file
  --label <text>      free-text label, e.g. pre-phase7-replay
  --base-url <url>    broker base URL (default ${DEFAULT_BASE_URL})
  --input <file|->    read a saved /health body instead of fetching
  --timeout <ms>      fetch timeout (default ${DEFAULT_TIMEOUT_MS})

Edge secret: environment only (${EDGE_SECRET_ENV.join(", ")}).`;

export function parseArgs(argv) {
  const opts = { baseUrl: DEFAULT_BASE_URL, timeoutMs: DEFAULT_TIMEOUT_MS, stdout: false };
  const valueFlags = new Map([
    ["--out", "out"], ["--label", "label"], ["--base-url", "baseUrl"],
    ["--input", "input"], ["--timeout", "timeoutMs"],
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--stdout") { opts.stdout = true; continue; }
    if (arg === "--edge-secret" || arg.startsWith("--edge-secret=")) {
      throw new UsageError("--edge-secret is not accepted on the command line; set it in the environment");
    }
    const eq = arg.indexOf("=");
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const key = valueFlags.get(name);
    if (!key) throw new UsageError(`unknown argument: ${arg}`);
    const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
    if (value === undefined || value === "") throw new UsageError(`${name} needs a value`);
    opts[key] = value;
  }
  opts.timeoutMs = Number(opts.timeoutMs);
  if (!Number.isInteger(opts.timeoutMs) || opts.timeoutMs <= 0) throw new UsageError("--timeout must be a positive integer");
  if (!opts.stdout && !opts.out) throw new UsageError("--out <file> or --stdout is required");
  if (opts.stdout && opts.out) throw new UsageError("--out and --stdout are mutually exclusive");
  if (opts.input === undefined) {
    let url;
    try { url = new URL(opts.baseUrl); } catch { throw new UsageError(`invalid --base-url: ${opts.baseUrl}`); }
    if (url.username || url.password) throw new UsageError("--base-url must not carry credentials");
  }
  return opts;
}

function isCount(v) {
  return Number.isSafeInteger(v) && v >= 0;
}

/**
 * Reduce a `/health` body to the allowlisted evidence. Returns
 * `{ ok: true, shadow }` or `{ ok: false, reason }`. Nothing outside the
 * allowlist is ever copied, whatever the body contains.
 */
export function extractShadow(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, reason: "health-body-not-object" };
  const raw = body.stateShadow;
  if (raw === undefined || raw === null) return { ok: false, reason: "state-shadow-absent" };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "state-shadow-not-object" };
  if (!isCount(raw.startedAtUnixMs)) return { ok: false, reason: "started-at-invalid" };
  const shadow = { startedAtUnixMs: raw.startedAtUnixMs };
  for (const family of FAMILIES) {
    const src = raw[family];
    if (!src || typeof src !== "object" || Array.isArray(src)) return { ok: false, reason: `${family}-missing` };
    const out = {};
    for (const counter of COUNTERS) {
      if (!isCount(src[counter])) return { ok: false, reason: `${family}.${counter}-invalid` };
      out[counter] = src[counter];
    }
    if (out.compared !== out.matches + out.warmupMismatches + out.unexplained) {
      return { ok: false, reason: `${family}-counters-inconsistent` };
    }
    shadow[family] = out;
  }
  return { ok: true, shadow };
}

/** Build the evidence document (pure — no I/O). */
export function buildSnapshot({ body, capturedAtMs, label, source }) {
  const extracted = extractShadow(body);
  const doc = {
    kind: SNAPSHOT_KIND,
    issue: ISSUE,
    capturedAt: new Date(capturedAtMs).toISOString(),
    label: label ?? null,
    source,
  };
  if (!extracted.ok) {
    return { doc: { ...doc, verdict: "no-evidence", reason: extracted.reason }, exitCode: EXIT.noEvidence };
  }
  const { shadow } = extracted;
  const unexplained = shadow.replay.unexplained + shadow.rate.unexplained;
  const verdict = unexplained === 0 ? "pass" : "unexplained";
  return {
    doc: {
      ...doc,
      verdict,
      window: {
        startedAt: new Date(shadow.startedAtUnixMs).toISOString(),
        durationMs: Math.max(0, capturedAtMs - shadow.startedAtUnixMs),
      },
      stateShadow: shadow,
    },
    exitCode: verdict === "pass" ? EXIT.pass : EXIT.unexplained,
  };
}

export function summaryLine(doc) {
  if (doc.verdict === "no-evidence") return `state-shadow-snapshot: no-evidence reason=${doc.reason}`;
  const s = doc.stateShadow;
  const hours = (doc.window.durationMs / 3_600_000).toFixed(1);
  return `state-shadow-snapshot: ${doc.verdict} window=${doc.window.startedAt}+${hours}h`
    + ` replay=${s.replay.matches}/${s.replay.compared} unexplained=${s.replay.unexplained}`
    + ` rate=${s.rate.matches}/${s.rate.compared} unexplained=${s.rate.unexplained}`;
}

function readEdgeSecret(env) {
  for (const name of EDGE_SECRET_ENV) {
    const v = env[name];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

async function readInput(input, stdin) {
  const text = input === "-" ? await new Response(stdin).text() : fs.readFileSync(input, "utf8");
  return JSON.parse(text);
}

async function fetchHealth({ baseUrl, timeoutMs, env, fetchImpl }) {
  const headers = { accept: "application/json" };
  const secret = readEdgeSecret(env);
  if (secret) headers["x-a2a-edge-secret"] = secret;
  const res = await fetchImpl(new URL("/health", baseUrl), { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`GET /health -> HTTP ${res.status}`);
  return res.json();
}

/** Origin only: never a path, query, or userinfo. */
function describeSource(opts) {
  if (opts.input !== undefined) return { mode: "input" };
  return { mode: "live", origin: new URL(opts.baseUrl).origin };
}

export async function main(argv, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  now = () => Date.now(),
} = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    stderr.write(`${err.message}\n${USAGE}\n`);
    return EXIT.usage;
  }
  if (opts.help) { stdout.write(`${USAGE}\n`); return EXIT.pass; }

  const source = describeSource(opts);
  let body;
  let fetchError;
  try {
    body = opts.input !== undefined
      ? await readInput(opts.input, stdin)
      : await fetchHealth({ baseUrl: opts.baseUrl, timeoutMs: opts.timeoutMs, env, fetchImpl });
  } catch (err) {
    // Error messages from fetch/JSON never contain request headers.
    fetchError = err instanceof Error ? err.message : String(err);
  }

  let doc;
  let exitCode;
  if (fetchError !== undefined) {
    doc = {
      kind: SNAPSHOT_KIND, issue: ISSUE, capturedAt: new Date(now()).toISOString(),
      label: opts.label ?? null, source, verdict: "no-evidence", reason: "health-read-failed",
    };
    exitCode = EXIT.noEvidence;
    stderr.write(`state-shadow-snapshot: /health read failed: ${fetchError}\n`);
  } else {
    ({ doc, exitCode } = buildSnapshot({ body, capturedAtMs: now(), label: opts.label, source }));
  }

  const json = `${JSON.stringify(doc, null, 2)}\n`;
  if (opts.stdout) {
    stdout.write(json);
  } else {
    try {
      fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true, mode: 0o700 });
      // `wx`: an evidence file is never silently replaced.
      fs.writeFileSync(opts.out, json, { flag: "wx", mode: 0o600 });
    } catch (err) {
      stderr.write(`state-shadow-snapshot: cannot write ${opts.out}: ${err.code ?? err.message}\n`);
      return EXIT.noEvidence;
    }
    stdout.write(`wrote ${opts.out}\n`);
  }
  stderr.write(`${summaryLine(doc)}\n`);
  return exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
