import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildRunTckArgs, parseHarnessArgs } from "./a2a-tck-harness-args.mjs";

test("parseHarnessArgs captures pytest passthrough after -- for promoted gates", () => {
  const parsed = parseHarnessArgs([
    "--level", "must",
    "--transport", "jsonrpc",
    "--",
    "tests/compatibility/agent_card",
    "-q",
  ]);

  assert.equal(parsed.level, "must");
  assert.equal(parsed.transport, "jsonrpc");
  assert.deepEqual(parsed.pytestArgs, ["tests/compatibility/agent_card", "-q"]);
});

test("buildRunTckArgs inserts -- before pytest passthrough", () => {
  assert.deepEqual(
    buildRunTckArgs({
      runTckPath: "/tmp/a2a-tck/run_tck.py",
      baseUrl: "http://127.0.0.1:1234",
      level: "must",
      transport: "jsonrpc",
      pytestArgs: ["tests/compatibility/agent_card"],
    }),
    [
      "/tmp/a2a-tck/run_tck.py",
      "--sut-host",
      "http://127.0.0.1:1234",
      "--transport",
      "jsonrpc",
      "--level",
      "must",
      "--",
      "tests/compatibility/agent_card",
    ],
  );
});

test("scheduled measurement captures verbose pytest node outcomes", () => {
  const workflow = readFileSync(new URL("../../../.github/workflows/tck-measurement.yml", import.meta.url), "utf8");
  assert.match(
    workflow,
    /a2a-tck-harness\.mjs --level "\$TCK_LEVEL" --transport "\$TCK_TRANSPORT" -- -v 2>&1 \| tee \/tmp\/tck-run\.log/,
  );
});
