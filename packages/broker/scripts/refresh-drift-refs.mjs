#!/usr/bin/env node
/**
 * Opt-in drift reference refresh script.
 *
 * This script fetches the current HEAD commit from the official A2A SDK repos
 * and updates the pinned refs in src/fixtures/a2a-protocol-compatibility.ts.
 *
 * It is NOT part of default CI — maintainers must run it explicitly and then
 * re-verify with `npm run test:drift-watch`.
 *
 * No live broker deploy, DB mutation, or production change is performed.
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const FIXTURE_PATH = resolve(process.cwd(), "src/fixtures/a2a-protocol-compatibility.ts");

const REFS = [
  { repo: "a2aproject/a2a-js", label: "a2a-js" },
  { repo: "a2aproject/a2a-python", label: "a2a-python" },
  { repo: "a2aproject/a2a-samples", label: "a2a-samples" },
];

const now = new Date().toISOString().replace(/\.\d{3}Z$/, "KST")
  .replace(/T/, "T")
  .replace(/:\d{2}KST$/, ":00KST");

const results = [];
for (const ref of REFS) {
  try {
    const sha = execSync(`git ls-remote https://github.com/${ref.repo}.git HEAD`, {
      encoding: "utf8",
      timeout: 15000,
    }).trim().split(/\s+/)[0];
    results.push({ ...ref, sha, ok: true });
  } catch (err) {
    results.push({ ...ref, sha: null, ok: false, error: String(err) });
  }
}

// Print refresh report
console.log(`A2A drift refs refreshed at ${now}`);
for (const r of results) {
  if (r.ok) {
    console.log(`  ${r.repo}: ${r.sha}`);
  } else {
    console.log(`  ${r.repo}: FAILED — ${r.error}`);
  }
}

// Update the fixture file with refreshed timestamps
const source = readFileSync(FIXTURE_PATH, "utf8");
let updated = source;
for (const r of results) {
  if (!r.ok) continue;
  // Update the refreshedAt timestamp for each matching repo
  const repoRegex = new RegExp(
    `(repo:\\s*"${r.repo.replace(/\//g, "\\/")}".*?refreshedAt:\\s*)"[^"]*"`,
    "s",
  );
  updated = updated.replace(repoRegex, `$1"${now}"`);
  // Also update the pinned ref
  const refRegex = new RegExp(
    `(repo:\\s*"${r.repo.replace(/\//g, "\\/")}".*?ref:\\s*)"[^"]*"`,
    "s",
  );
  updated = updated.replace(refRegex, `$1"${r.sha}"`);
}

writeFileSync(FIXTURE_PATH, updated, "utf8");
console.log(`\nUpdated ${FIXTURE_PATH}`);
console.log("Run `npm run test:drift-watch` to re-verify.");
