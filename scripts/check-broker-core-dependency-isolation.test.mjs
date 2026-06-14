import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { findForbiddenAppImports, checkBrokerCoreIsolation } from "./check-broker-core-dependency-isolation.mjs";

test("findForbiddenAppImports flags openclaw module imports but not string references", () => {
  assert.equal(findForbiddenAppImports(`import { x } from "openclaw";`).length, 1);
  assert.equal(findForbiddenAppImports(`import { y } from "openclaw/gateway";`).length, 1);
  assert.equal(findForbiddenAppImports(`export { z } from "@openclaw/sdk";`).length, 1);
  assert.equal(findForbiddenAppImports(`const m = require("openclaw");`).length, 1);
  // String-level references (packet kinds, mode names, comments) must NOT flag.
  assert.equal(findForbiddenAppImports(`const kind = "a2a-broker.openclaw-event";`).length, 0);
  assert.equal(findForbiddenAppImports(`// openclaw is the reference adapter`).length, 0);
  assert.equal(findForbiddenAppImports(`import { broker } from "./core/broker.js";`).length, 0);
});

test("checkBrokerCoreIsolation passes the real broker core (no harness imports today)", () => {
  const result = checkBrokerCoreIsolation();
  assert.equal(result.ok, true, JSON.stringify(result.violations));
});

test("checkBrokerCoreIsolation fails closed on a synthetic forbidden source import", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dep-iso-"));
  const pkg = path.join(dir, "package.json");
  try {
    fs.writeFileSync(path.join(dir, "leak.ts"), `import { gateway } from "openclaw";\n`);
    fs.writeFileSync(pkg, JSON.stringify({ name: "x", dependencies: {} }));
    const result = checkBrokerCoreIsolation({ srcDir: dir, pkgJsonPath: pkg });
    assert.equal(result.ok, false);
    assert.equal(result.violations[0].kind, "source_import");
    assert.equal(result.violations[0].specifier, "openclaw");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("checkBrokerCoreIsolation fails closed on a forbidden package dependency", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dep-iso-pkg-"));
  const pkg = path.join(dir, "package.json");
  try {
    fs.writeFileSync(pkg, JSON.stringify({ name: "x", dependencies: { openclaw: "*" } }));
    const result = checkBrokerCoreIsolation({ srcDir: dir, pkgJsonPath: pkg });
    assert.equal(result.ok, false);
    assert.ok(result.violations.some((v) => v.kind === "package_dependency" && v.specifier === "openclaw"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
