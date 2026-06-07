import assert from "node:assert/strict";
import test from "node:test";

import plugin from "../dist/index.js";

test("plugin config changes require Gateway restart", () => {
  assert.deepEqual(plugin.reload, {
    restartPrefixes: ["plugins.entries.a2a-broker-adapter.config"],
  });
});
