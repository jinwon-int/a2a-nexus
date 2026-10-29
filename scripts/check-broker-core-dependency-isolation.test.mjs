import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as checker from "./check-broker-core-dependency-isolation.mjs";

const { CORE_ISOLATION_TARGETS, checkAllCoreIsolationTargets, findForbiddenAppImports, checkBrokerCoreIsolation } = checker;
const SCRIPT = fileURLToPath(new URL("./check-broker-core-dependency-isolation.mjs", import.meta.url));

// #2386: remove every temp dir this file creates.
const trackedTempDirs = [];
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trackedTempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of trackedTempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

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

test("findForbiddenAppImports sees multi-line, export-star and dynamic forbidden imports", () => {
  const multi = findForbiddenAppImports(`import {\n  gateway,\n  type Session,\n} from "openclaw";\n`);
  assert.equal(multi.length, 1);
  assert.equal(multi[0].specifier, "openclaw");
  assert.equal(multi[0].line, 1);
  assert.equal(findForbiddenAppImports(`export * from "openclaw/sdk";`).length, 1);
  assert.equal(findForbiddenAppImports(`const m = await import(\n  "openclaw"\n);`).length, 1);
  assert.equal(findForbiddenAppImports(`/* import { x } from "openclaw"; */`).length, 0);
});

test("checkBrokerCoreIsolation passes the real broker core (no harness imports today)", () => {
  const result = checkBrokerCoreIsolation();
  assert.equal(result.ok, true, JSON.stringify(result.violations));
  // #2477: the review-lifecycle engine the broker runs stays in scope.
  assert.ok(CORE_ISOLATION_TARGETS.some((t) => t.srcDir.endsWith(path.join("packages", "review-lifecycle", "src"))));
  const all = checkAllCoreIsolationTargets();
  assert.equal(all.ok, true, JSON.stringify(all.violations));
});

test("checkBrokerCoreIsolation fails closed on a synthetic forbidden source import", () => {
  const dir = tempDir("dep-iso-");
  const pkg = path.join(dir, "package.json");
  fs.writeFileSync(path.join(dir, "leak.ts"), `import { gateway } from "openclaw";\n`);
  fs.writeFileSync(pkg, JSON.stringify({ name: "x", dependencies: {} }));
  const result = checkBrokerCoreIsolation({ srcDir: dir, pkgJsonPath: pkg });
  assert.equal(result.ok, false);
  assert.equal(result.violations[0].kind, "source_import");
  assert.equal(result.violations[0].specifier, "openclaw");
});

test("checkBrokerCoreIsolation fails closed on a forbidden package dependency", () => {
  const dir = tempDir("dep-iso-pkg-");
  const pkg = path.join(dir, "package.json");
  fs.writeFileSync(pkg, JSON.stringify({ name: "x", dependencies: { openclaw: "*" } }));
  const result = checkBrokerCoreIsolation({ srcDir: dir, pkgJsonPath: pkg });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.kind === "package_dependency" && v.specifier === "openclaw"));
});

// ---------------------------------------------------------------------------
// Import parser (#2453 PR-0): every import form, value vs type-only.

function kinds(text) {
  return checker.parseModuleImports(text).map((entry) => `${entry.specifier}:${entry.kind}`);
}

test("parseModuleImports reads multi-line imports and import type", () => {
  assert.deepEqual(
    kinds(`import {\n  a,\n  b,\n} from "./one.js";\nimport type {\n  T,\n} from "./two.js";\nimport type D from "./three.js";\n`),
    ["./one.js:value", "./two.js:type", "./three.js:type"],
  );
});

test("parseModuleImports: mixed { a, type B } is a value edge; all-type named is type-only", () => {
  assert.deepEqual(kinds(`import { a, type B } from "./mixed.js";`), ["./mixed.js:value"]);
  assert.deepEqual(kinds(`import { type A, type B } from "./types.js";`), ["./types.js:type"]);
  assert.deepEqual(kinds(`import Default, { type B } from "./default.js";`), ["./default.js:value"]);
  assert.deepEqual(kinds(`import * as ns from "./ns.js";`), ["./ns.js:value"]);
  assert.deepEqual(kinds(`import "./side-effect.js";`), ["./side-effect.js:value"]);
});

test("parseModuleImports: export-from and export * are value edges unless declared type", () => {
  assert.deepEqual(
    kinds(
      `export { a } from "./a.js";\nexport * from "./b.js";\nexport * as ns from "./c.js";\n` +
        `export type { T } from "./d.js";\nexport { type U, type V } from "./e.js";\nexport { w, type X } from "./f.js";\n`,
    ),
    ["./a.js:value", "./b.js:value", "./c.js:value", "./d.js:type", "./e.js:type", "./f.js:value"],
  );
});

test("parseModuleImports: dynamic import() is a value edge, import() type position is type-only", () => {
  assert.deepEqual(
    kinds(`async function f() { const m = await import(\n  "./lazy.js"\n); void import("./later.js"); }\n` +
      `type Shape = import("./shape.js").Shape;\nconst r = require("./cjs.js");\n`),
    ["./lazy.js:value", "./later.js:value", "./shape.js:type", "./cjs.js:value"],
  );
});

test("parseModuleImports ignores specifiers inside comments and plain strings", () => {
  assert.deepEqual(kinds(`// import { x } from "./a.js";\n/* export * from "./b.js"; */\nconst s = 'from "./c.js"';\n`), []);
});

// ---------------------------------------------------------------------------
// Domain map + allow-matrix + type ratchet on synthetic core trees.

const DOMAINS = {
  kernel: { mayImport: [] },
  dispatch: { mayImport: ["kernel"], mayImportTypeOnly: ["claim"] },
  claim: { mayImport: ["kernel"] },
  facade: { mayImport: ["kernel", "dispatch", "claim"] },
  "test-support": { mayImport: ["kernel", "dispatch", "claim", "facade"] },
};

function fixture(files, modules, { typeOnlyViolations = [], domains = DOMAINS } = {}) {
  const dir = tempDir("core-domains-");
  const coreDir = path.join(dir, "core");
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(coreDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(coreDir, rel), text);
  }
  const map = { schemaVersion: 1, domains, modules };
  const baseline = { schemaVersion: 1, typeOnlyViolations };
  return { coreDir, map, baseline };
}

const BASE_FILES = {
  "types.ts": `export interface Task { id: string }\n`,
  "admission.ts": `import type { Task } from "./types.js";\nexport const admit = (t: Task) => t;\n`,
  "worker.ts": `export interface Worker { id: string }\nexport const wake = () => 1;\n`,
  "broker.ts": `import { admit } from "./admission.js";\nexport { admit };\n`,
  "broker-test-helpers.ts": `import { admit } from "./broker.js";\nexport { admit };\n`,
  "admission.test.ts": `import { wake } from "./worker.js";\nvoid wake;\n`,
};
const BASE_MODULES = {
  "types.ts": "kernel",
  "admission.ts": "dispatch",
  "worker.ts": "claim",
  "broker.ts": "facade",
  "broker-test-helpers.ts": "test-support",
};

test("checkCoreDomainBoundaries passes a clean synthetic tree (tests are not modules)", () => {
  const result = checker.checkCoreDomainBoundaries(fixture(BASE_FILES, BASE_MODULES));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.modules, 5);
  assert.deepEqual(result.valueViolations, []);
  assert.deepEqual(result.typeViolations, []);
});

test("completeness: a core module missing from the map fails", () => {
  const result = checker.checkCoreDomainBoundaries(
    fixture({ ...BASE_FILES, "new-module.ts": `export const x = 1;\n` }, BASE_MODULES),
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.missingFromMap, ["new-module.ts"]);
});

test("completeness: a map entry for a non-existent module fails", () => {
  const result = checker.checkCoreDomainBoundaries(fixture(BASE_FILES, { ...BASE_MODULES, "ghost.ts": "kernel" }));
  assert.equal(result.ok, false);
  assert.deepEqual(result.unknownInMap, ["ghost.ts"]);
});

test("completeness: a module in a subdirectory is a module too", () => {
  const result = checker.checkCoreDomainBoundaries(
    fixture({ ...BASE_FILES, "nested/deep.ts": `export const x = 1;\n` }, BASE_MODULES),
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.missingFromMap, ["nested/deep.ts"]);
});

test("a map entry naming an undeclared domain fails", () => {
  const result = checker.checkCoreDomainBoundaries(fixture(BASE_FILES, { ...BASE_MODULES, "worker.ts": "nowhere" }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /nowhere/.test(error)), JSON.stringify(result.errors));
});

test("allow-matrix: a value edge kernel -> dispatch fails, even as a multi-line import", () => {
  const result = checker.checkCoreDomainBoundaries(
    fixture({ ...BASE_FILES, "types.ts": `import {\n  admit,\n} from "./admission.js";\nexport { admit };\n` }, BASE_MODULES),
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.valueViolations.map((v) => `${v.from}>${v.to}`), ["types.ts>admission.ts"]);
});

test("allow-matrix: export * and dynamic import() count as value violations", () => {
  const starResult = checker.checkCoreDomainBoundaries(
    fixture({ ...BASE_FILES, "types.ts": `export * from "./worker.js";\n` }, BASE_MODULES),
  );
  assert.deepEqual(starResult.valueViolations.map((v) => `${v.from}>${v.to}`), ["types.ts>worker.ts"]);
  const dynamicResult = checker.checkCoreDomainBoundaries(
    fixture({ ...BASE_FILES, "worker.ts": `export const wake = async () => (await import("./admission.js")).admit;\n` }, BASE_MODULES),
  );
  assert.deepEqual(dynamicResult.valueViolations.map((v) => `${v.from}>${v.to}`), ["worker.ts>admission.ts"]);
});

test("allow-matrix: a mixed { value, type } import is a value violation, not a type one", () => {
  const result = checker.checkCoreDomainBoundaries(
    fixture({ ...BASE_FILES, "worker.ts": `import { admit, type Task } from "./admission.js";\nexport const w = (t: Task) => admit(t);\n` }, BASE_MODULES),
  );
  assert.equal(result.valueViolations.length, 1);
  assert.equal(result.typeViolations.length, 0);
});

test("allow-matrix: type-only rights (dispatch -> claim) admit type edges but not value edges", () => {
  const typeOk = checker.checkCoreDomainBoundaries(
    fixture({ ...BASE_FILES, "admission.ts": `import type { Worker } from "./worker.js";\nexport const admit = (w: Worker) => w;\n` }, BASE_MODULES),
  );
  assert.equal(typeOk.ok, true, JSON.stringify(typeOk.errors));
  const valueBad = checker.checkCoreDomainBoundaries(
    fixture({ ...BASE_FILES, "admission.ts": `import { wake } from "./worker.js";\nexport const admit = wake;\n` }, BASE_MODULES),
  );
  assert.equal(valueBad.ok, false);
  assert.deepEqual(valueBad.valueViolations.map((v) => `${v.from}>${v.to}`), ["admission.ts>worker.ts"]);
});

test("allow-matrix: nothing but test-support may import the facade", () => {
  const result = checker.checkCoreDomainBoundaries(
    fixture({ ...BASE_FILES, "worker.ts": `import { admit } from "./broker.js";\nexport const wake = admit;\n` }, BASE_MODULES),
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.valueViolations.map((v) => `${v.from}>${v.to}`), ["worker.ts>broker.ts"]);
});

const TYPE_VIOLATION_FILES = {
  ...BASE_FILES,
  "types.ts": `import type { Worker } from "./worker.js";\nexport interface Task { id: string; w?: Worker }\n`,
};

test("type ratchet: a type-only violation that is not in the baseline fails", () => {
  const result = checker.checkCoreDomainBoundaries(fixture(TYPE_VIOLATION_FILES, BASE_MODULES));
  assert.equal(result.ok, false);
  assert.deepEqual(result.newTypeViolations.map((v) => `${v.from}>${v.to}`), ["types.ts>worker.ts"]);
});

test("type ratchet: a baselined type-only violation passes; a value edge on the same pair still fails", () => {
  const baselined = [{ from: "types.ts", to: "worker.ts" }];
  const ok = checker.checkCoreDomainBoundaries(fixture(TYPE_VIOLATION_FILES, BASE_MODULES, { typeOnlyViolations: baselined }));
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.equal(ok.typeViolations.length, 1);
  const promoted = checker.checkCoreDomainBoundaries(
    fixture({ ...BASE_FILES, "types.ts": `import { wake } from "./worker.js";\nexport const t = wake;\n` }, BASE_MODULES, {
      typeOnlyViolations: baselined,
    }),
  );
  assert.equal(promoted.ok, false);
  assert.equal(promoted.valueViolations.length, 1);
});

test("type ratchet: a fixed baseline entry is reported as lowerable without failing", () => {
  const result = checker.checkCoreDomainBoundaries(
    fixture(BASE_FILES, BASE_MODULES, { typeOnlyViolations: [{ from: "types.ts", to: "worker.ts" }] }),
  );
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.lowerableTypeViolations.map((v) => `${v.from}>${v.to}`), ["types.ts>worker.ts"]);
});

test("a domain directory is authoritative: core/<domain>/x.ts needs no map entry, and a map entry for it fails", () => {
  const files = { ...BASE_FILES, "claim/liveness.ts": `import { wake } from "../worker.js";\nexport const live = wake;\n` };
  const ok = checker.checkCoreDomainBoundaries(fixture(files, BASE_MODULES));
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.equal(ok.modules, 6);
  const dup = checker.checkCoreDomainBoundaries(fixture(files, { ...BASE_MODULES, "claim/liveness.ts": "claim" }));
  assert.equal(dup.ok, false);
});

// ---------------------------------------------------------------------------
// The committed map and baseline against the real tree.

test("the committed domain map covers every core module and the real tree has no value violation", () => {
  const result = checker.checkCoreDomainBoundaries();
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
  assert.deepEqual(result.missingFromMap, []);
  assert.deepEqual(result.unknownInMap, []);
  assert.deepEqual(result.valueViolations, []);
  assert.ok(result.modules >= 181, `expected >= 181 core modules, got ${result.modules}`);
});

test("the committed type-only baseline matches the real tree exactly (no slack to absorb new edges)", () => {
  const result = checker.checkCoreDomainBoundaries();
  assert.deepEqual(result.newTypeViolations, []);
  assert.deepEqual(result.lowerableTypeViolations, [], "baseline has fixed entries; lower it with --lower-baseline");
});

test("the CLI exits 0 on the real tree and reports the domain summary", () => {
  const res = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.coreDomains.valueViolations, 0);
  assert.equal(typeof out.coreDomains.perDomain.kernel, "number");
});
