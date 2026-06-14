#!/usr/bin/env node
/**
 * Broker core dependency-isolation guard.
 *
 * The broker is the independent control-plane product; OpenClaw / Hermes are
 * reference *adapters*, not core dependencies. Today packages/broker/src has
 * zero module-level imports of the OpenClaw app, and packages/broker depends on
 * no harness package — this guard locks that in so the decoupling cannot
 * silently regress. String-level references (packet `kind` names, mode strings,
 * comments) are fine and intentionally NOT flagged — only real
 * `import`/`require`/`export ... from` module specifiers are checked.
 *
 * Source-only static check. No build, network, or runtime needed.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(scriptDir, "..");
const BROKER_SRC = path.join(REPO_ROOT, "packages", "broker", "src");
const BROKER_PKG = path.join(REPO_ROOT, "packages", "broker", "package.json");

// Harness/app packages the broker core must not hard-depend on.
const FORBIDDEN_PACKAGES = ["openclaw"];

function isForbiddenSpecifier(specifier) {
  return FORBIDDEN_PACKAGES.some((pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`) || specifier.startsWith(`@${pkg}/`));
}

/** Return forbidden module specifiers imported in a source text (line-numbered). */
export function findForbiddenAppImports(text) {
  const hits = [];
  const lines = String(text).split(/\r?\n/);
  // import ... from "x"; | import "x"; | export ... from "x"; | require("x")
  const fromRe = /(?:^|\s)(?:import|export)\b[^'"`]*?from\s*['"]([^'"]+)['"]/;
  const bareImportRe = /^\s*import\s*['"]([^'"]+)['"]/;
  const requireRe = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/;
  lines.forEach((line, i) => {
    for (const re of [fromRe, bareImportRe, requireRe]) {
      const m = line.match(re);
      if (m && isForbiddenSpecifier(m[1])) {
        hits.push({ line: i + 1, specifier: m[1], text: line.trim().slice(0, 160) });
      }
    }
  });
  return hits;
}

function listTsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/** Check the broker core source tree and package manifest for forbidden deps. */
export function checkBrokerCoreIsolation({ srcDir = BROKER_SRC, pkgJsonPath = BROKER_PKG } = {}) {
  const violations = [];

  for (const file of listTsFiles(srcDir)) {
    const hits = findForbiddenAppImports(fs.readFileSync(file, "utf8"));
    for (const hit of hits) {
      violations.push({ kind: "source_import", file: path.relative(REPO_ROOT, file), ...hit });
    }
  }

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      for (const dep of Object.keys(pkg[field] ?? {})) {
        if (isForbiddenSpecifier(dep)) {
          violations.push({ kind: "package_dependency", file: path.relative(REPO_ROOT, pkgJsonPath), field, specifier: dep });
        }
      }
    }
  } catch (error) {
    violations.push({ kind: "package_unreadable", file: path.relative(REPO_ROOT, pkgJsonPath), error: error instanceof Error ? error.message : String(error) });
  }

  return { ok: violations.length === 0, forbidden: FORBIDDEN_PACKAGES, violations };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const result = checkBrokerCoreIsolation();
  if (!result.ok) {
    console.error("broker core dependency-isolation guard FAILED — the broker core must not import harness/app packages:");
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, forbidden: result.forbidden, checked: "packages/broker/src + packages/broker/package.json" }, null, 2));
}
