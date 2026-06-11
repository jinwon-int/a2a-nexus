import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);

test("a2a-tck-harness --self-check boots the broker and probes the A2A surface", async () => {
  const script = resolve(process.cwd(), "scripts/a2a-tck-harness.mjs");
  const { stdout } = await execFileAsync("node", [script, "--self-check"], {
    timeout: 30_000,
  });
  assert.match(stdout, /agent card ok/);
  assert.match(stdout, /JSON-RPC surface ok/);
  assert.match(stdout, /self-check passed/);
});

test("a2a-tck-harness without A2A_TCK_DIR exits with setup instructions", async () => {
  const script = resolve(process.cwd(), "scripts/a2a-tck-harness.mjs");
  await assert.rejects(
    execFileAsync("node", [script], {
      timeout: 30_000,
      env: { ...process.env, A2A_TCK_DIR: "" },
    }),
    (error: unknown) => {
      const err = error as { code?: number; stderr?: string };
      assert.equal(err.code, 2, "missing TCK dir must exit 2, not crash");
      assert.match(err.stderr ?? "", /A2A_TCK_DIR is not set/);
      return true;
    },
  );
});
