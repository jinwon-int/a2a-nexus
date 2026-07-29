import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const examplePath = fileURLToPath(
  new URL("../examples/broker-adapter-replay.mjs", import.meta.url),
);
const exampleSource = readFileSync(examplePath, "utf8");
const packageRoot = fileURLToPath(new URL("..", import.meta.url));

const expectedStdout = [
  '{"schemaVersion":"a2a.policy-referee.broker-example-result.v1","caseId":"anonymous-class-intent-allow","decision":"allow","callerAction":"proceed"}',
  '{"schemaVersion":"a2a.policy-referee.broker-example-result.v1","caseId":"warn-deny-observe-proceed","decision":"deny","callerAction":"observe_proceed"}',
  '{"schemaVersion":"a2a.policy-referee.broker-example-result.v1","caseId":"enforce-require-approval","decision":"require_approval","callerAction":"route_approval"}',
  '{"schemaVersion":"a2a.policy-referee.broker-example-result.v1","caseId":"daily-budget-deny","decision":"deny","callerAction":"reject"}',
  '{"schemaVersion":"a2a.policy-referee.broker-example-result.v1","caseId":"warn-require-approval","decision":"require_approval","callerAction":"route_approval"}',
  "",
].join("\n");

test("built broker adapter example emits exact bounded replay output", () => {
  const result = spawnSync(process.execPath, [examplePath], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, expectedStdout);
  assert.equal(result.stderr, "");
  assert.equal(Buffer.byteLength(result.stdout), Buffer.byteLength(expectedStdout));

  for (const line of result.stdout.trimEnd().split("\n")) {
    assert.deepEqual(Object.keys(JSON.parse(line) as object), [
      "schemaVersion",
      "caseId",
      "decision",
      "callerAction",
    ]);
  }
  assert.doesNotMatch(
    result.stdout,
    /(?:\/|\\|reason|identity|workerId|account|provider|https?:|credential|secret|token|header|payload|\s{2,})/i,
  );
});

test("example imports only Node built-ins and the built package public root", () => {
  const specifiers = [
    ...exampleSource.matchAll(/from\s+["']([^"']+)["']/g),
    ...exampleSource.matchAll(/import\s+["']([^"']+)["']/g),
  ].map((match) => match[1]);
  assert.deepEqual(specifiers, [
    "node:fs",
    "node:url",
    "a2a-policy-referee",
  ]);
  assert.equal(exampleSource.includes("evaluatePolicyRefereeCli"), true);
  assert.equal(exampleSource.includes("parsePolicyRefereePolicyDocument"), true);
  assert.equal(exampleSource.includes("parsePolicyRefereeTaskEnvelope"), true);
  assert.equal(exampleSource.includes("parsePolicyRefereeWorkerEnvelope"), true);
  assert.doesNotMatch(exampleSource, /(?:\.\.\/(?:dist|src)|packages\/broker|broker\/src|runtime\/|import\s*\(|require\s*\()/);
});

test("invalid external example fails closed without reflecting input or source path", () => {
  const sourceMarker = "private-source-path-marker";
  const inputMarker = "identity-secret-url-credential-marker";
  const work = mkdtempSync(join(tmpdir(), `${sourceMarker}-`));
  try {
    const manifestPath = join(work, `${sourceMarker}.json`);
    writeFileSync(manifestPath, `${JSON.stringify({
      schemaVersion: "a2a.policy-referee.broker-example-manifest.v1",
      cases: [{
        id: "invalid-worker-class",
        policy: {
          schemaVersion: "a2a.broker.policy.v1",
          mode: "enforce",
          defaultAction: "allow",
          rules: [],
        },
        brokerInput: {
          operation: "claim",
          intent: "analyze",
          workerClass: inputMarker,
        },
        expected: {
          decision: "allow",
          callerAction: "proceed",
        },
      }],
    })}\n`);

    const result = spawnSync(
      process.execPath,
      [examplePath, manifestPath],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 64);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      '{"schemaVersion":"a2a.policy-referee.broker-example-error.v1","code":"invalid_example"}\n',
    );
    assert.equal(result.stderr.includes(sourceMarker), false);
    assert.equal(result.stderr.includes(inputMarker), false);
    assert.doesNotMatch(result.stderr, /(?:\/|\\|reason|identity|url|credential|secret|workerClass)/i);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("npm pack dry-run contains the package-owned guide and replay example", () => {
  const work = mkdtempSync(join(tmpdir(), "policy-referee-pack-"));
  try {
    const result = spawnSync(
      "npm",
      ["pack", "--dry-run", "--json"],
      {
        cwd: packageRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          npm_config_cache: join(work, "npm-cache"),
          npm_config_update_notifier: "false",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const report = JSON.parse(result.stdout) as Array<{
      name: string;
      version: string;
      files: Array<{ path: string }>;
    }>;
    assert.equal(report.length, 1);
    assert.equal(report[0]?.name, "a2a-policy-referee");
    assert.equal(report[0]?.version, "0.1.0");
    const paths = report[0]?.files.map((file) => file.path) ?? [];
    assert.equal(paths.includes("docs/broker-adapter.md"), true);
    assert.equal(paths.includes("examples/broker-adapter-cases.json"), true);
    assert.equal(paths.includes("examples/broker-adapter-replay.mjs"), true);

    const packageJson = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    ) as { name?: string; version?: string; private?: boolean };
    assert.equal(packageJson.name, "a2a-policy-referee");
    assert.equal(packageJson.version, "0.1.0");
    assert.equal(packageJson.private, true);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
