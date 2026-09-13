import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { githubHostsActiveTokenCommand } from "./script-generators.js";

// Obviously-fake tokens, matching the classicGitHubToken pattern already used
// in engine-contract.test.ts — never real credentials.
const tokenA = "ghp_" + "A".repeat(36);
const tokenB = "ghp_" + "B".repeat(36);

/**
 * Runs the actual generated bash command against a fixture hosts.yml file and
 * returns the extracted token, so this test exercises the real shell snippet
 * shipped in the container script rather than reimplementing its logic in
 * JS/TS (a2a-nexus#2137).
 */
function extractToken(hostsYamlContents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "a2a-gh-hosts-"));
  const hostsFile = join(dir, "gh-hosts.yml");
  try {
    writeFileSync(hostsFile, hostsYamlContents, "utf8");
    const command = githubHostsActiveTokenCommand(hostsFile);
    const result = spawnSync("bash", ["-c", command], { encoding: "utf8" });
    assert.equal(result.status, 0, `extraction command failed: ${result.stderr}`);
    return result.stdout.trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("githubHostsActiveTokenCommand extracts the only token from a legacy single-account hosts.yml", () => {
  const hostsYaml = `github.com:
    user: solo-account
    oauth_token: ${tokenA}
    git_protocol: https
`;
  assert.equal(extractToken(hostsYaml), tokenA);
});

test("githubHostsActiveTokenCommand extracts the top-level active token when it is NOT first under users:", () => {
  const hostsYaml = `github.com:
    users:
        acct-a:
            oauth_token: ${tokenA}
        acct-b:
            oauth_token: ${tokenB}
    git_protocol: https
    user: acct-b
    oauth_token: ${tokenB}
`;
  assert.equal(extractToken(hostsYaml), tokenB, "must pick the top-level (active) token, not the first oauth_token: line under users:");
});

test("githubHostsActiveTokenCommand still extracts the top-level active token when it HAPPENS to be first under users: (regression guard)", () => {
  const hostsYaml = `github.com:
    users:
        acct-b:
            oauth_token: ${tokenB}
        acct-a:
            oauth_token: ${tokenA}
    git_protocol: https
    user: acct-b
    oauth_token: ${tokenB}
`;
  assert.equal(extractToken(hostsYaml), tokenB, "must pick the active account's token by position (top-level), not merely because it appears first");
});
