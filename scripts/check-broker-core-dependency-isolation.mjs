#!/usr/bin/env node
/**
 * Broker core dependency-isolation guard.
 *
 * Two invariants, one gate (no new script: the scripts/*.mjs and root npm
 * script budgets are full):
 *
 * 1. Harness isolation (original guard). The broker is the independent
 *    control-plane product; OpenClaw / Hermes are reference *adapters*, not
 *    core dependencies. packages/broker/src must not import a harness package
 *    and packages/broker must not depend on one. String-level references
 *    (packet `kind` names, mode strings, comments) are fine and intentionally
 *    NOT flagged — only real module specifiers are checked.
 *
 * 2. Core domain boundaries (#2453 PR-0). Every non-test module under
 *    packages/broker/src/core is assigned a domain by the committed map
 *    docs/ops/broker-core-domain-map.json (or by its core/<domain>/ directory
 *    once domains move). The map's allow-matrix says which domains each domain
 *    may import. The gate fails when
 *      - a core module is missing from the map, or the map names a module that
 *        does not exist (completeness: a new file must declare its domain);
 *      - any VALUE import edge between core modules violates the allow-matrix;
 *      - a TYPE-only violation appears that is not in the committed baseline
 *        docs/ops/broker-core-type-edge-baseline.json (the baseline only goes
 *        down; fixed entries are reported and `--lower-baseline` rewrites it).
 *
 * Imports are parsed with the TypeScript compiler API, so multi-line imports,
 * `import type`, mixed `import { a, type B }` (a value edge), `export … from`
 * and `export * from` (value edges unless declared `type`), dynamic `import()`
 * (value) and `import("x")` type nodes (type-only) are all seen. Edges are
 * deduplicated per (importer, target) pair and a value import wins.
 *
 * Source-only static check. No build, network, or runtime needed.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(scriptDir, "..");
const BROKER_SRC = path.join(REPO_ROOT, "packages", "broker", "src");
const BROKER_PKG = path.join(REPO_ROOT, "packages", "broker", "package.json");
const CORE_DIR = path.join(BROKER_SRC, "core");
export const DOMAIN_MAP_PATH = path.join(REPO_ROOT, "docs", "ops", "broker-core-domain-map.json");
export const TYPE_BASELINE_PATH = path.join(REPO_ROOT, "docs", "ops", "broker-core-type-edge-baseline.json");

// #2477: the bounded review lifecycle engine left packages/broker/src for the
// a2a-review-lifecycle workspace package, but the broker still runs it at
// runtime, so it stays inside this guard's scope.
export const CORE_ISOLATION_TARGETS = Object.freeze([
  Object.freeze({ srcDir: BROKER_SRC, pkgJsonPath: BROKER_PKG }),
  Object.freeze({
    srcDir: path.join(REPO_ROOT, "packages", "review-lifecycle", "src"),
    pkgJsonPath: path.join(REPO_ROOT, "packages", "review-lifecycle", "package.json"),
  }),
]);

// Harness/app packages the broker core must not hard-depend on.
const FORBIDDEN_PACKAGES = ["openclaw"];

function isForbiddenSpecifier(specifier) {
  return FORBIDDEN_PACKAGES.some((pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`) || specifier.startsWith(`@${pkg}/`));
}

// ---------------------------------------------------------------------------
// Import parsing

function namedElementsAllType(elements) {
  return elements.length > 0 && elements.every((element) => element.isTypeOnly);
}

/**
 * Every module specifier a source text imports, with its kind.
 * `kind` is "type" only when the edge is erased at runtime by declaration:
 * `import type`, `export type`, every named specifier `type X`, or an
 * `import("x")` type node. Everything else is "value" (conservative).
 */
export function parseModuleImports(text, fileName = "module.ts") {
  const source = String(text);
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out = [];
  const add = (node, specifier, kind, form) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    out.push({ specifier, kind, form, line: line + 1 });
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (!clause) add(node, spec, "value", "import-side-effect");
      else if (clause.isTypeOnly) add(node, spec, "type", "import-type");
      else {
        const bindings = clause.namedBindings;
        const allType = !clause.name && bindings && ts.isNamedImports(bindings) && namedElementsAllType(bindings.elements);
        add(node, spec, allType ? "type" : "value", allType ? "import-named-types" : "import");
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      const clause = node.exportClause;
      const allType = node.isTypeOnly || (clause && ts.isNamedExports(clause) && namedElementsAllType(clause.elements));
      add(node, spec, allType ? "type" : "value", !clause ? "export-star" : "export-from");
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expr = node.moduleReference.expression;
      if (ts.isStringLiteral(expr)) add(node, expr.text, node.isTypeOnly ? "type" : "value", "import-equals");
    } else if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node, node.arguments[0].text, "value", "dynamic-import");
      else if (ts.isIdentifier(node.expression) && node.expression.text === "require") add(node, node.arguments[0].text, "value", "require");
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      add(node, node.argument.literal.text, "type", "import-type-node");
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Return forbidden module specifiers imported in a source text (line-numbered). */
export function findForbiddenAppImports(text) {
  const lines = String(text).split(/\r?\n/);
  return parseModuleImports(text)
    .filter((entry) => isForbiddenSpecifier(entry.specifier))
    .map((entry) => ({ line: entry.line, specifier: entry.specifier, text: (lines[entry.line - 1] ?? "").trim().slice(0, 160) }));
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

/** Run checkBrokerCoreIsolation over every runtime core target (#2477). */
export function checkAllCoreIsolationTargets(targets = CORE_ISOLATION_TARGETS) {
  const violations = targets.flatMap((target) => checkBrokerCoreIsolation(target).violations);
  return { ok: violations.length === 0, forbidden: FORBIDDEN_PACKAGES, violations };
}

// ---------------------------------------------------------------------------
// Core domain boundaries (#2453 PR-0)

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const toPosix = (p) => p.split(path.sep).join("/");
const edgeKey = (edge) => `${edge.from}>${edge.to}`;

/** Resolve a relative specifier from a core module to a core-relative module path, or null. */
function resolveCoreTarget(fromRel, specifier, moduleSet) {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), specifier));
  const candidates = /\.js$/.test(joined)
    ? [joined.replace(/\.js$/, ".ts")]
    : /\.ts$/.test(joined)
      ? [joined]
      : [`${joined}.ts`, `${joined}/index.ts`];
  return candidates.find((candidate) => moduleSet.has(candidate)) ?? null;
}

/** Collect deduplicated intra-core edges (value wins over type). */
export function collectCoreEdges(coreDir, moduleRels) {
  const moduleSet = new Set(moduleRels);
  const edges = new Map();
  for (const from of moduleRels) {
    const text = fs.readFileSync(path.join(coreDir, from), "utf8");
    for (const entry of parseModuleImports(text, from)) {
      const to = resolveCoreTarget(from, entry.specifier, moduleSet);
      if (!to || to === from) continue;
      const key = `${from}>${to}`;
      const prev = edges.get(key);
      const typeOnly = entry.kind === "type";
      if (!prev) edges.set(key, { from, to, typeOnly, line: entry.line });
      else if (prev.typeOnly && !typeOnly) edges.set(key, { from, to, typeOnly: false, line: entry.line });
    }
  }
  return [...edges.values()].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));
}

/**
 * Check the core tree against the domain map, allow-matrix and type baseline.
 * Pure over its inputs so it runs against synthetic trees in tests.
 */
export function checkCoreDomainBoundaries({ coreDir = CORE_DIR, map, baseline } = {}) {
  map ??= readJson(DOMAIN_MAP_PATH);
  baseline ??= readJson(TYPE_BASELINE_PATH);
  const errors = [];
  const domains = map.domains ?? {};
  const domainNames = new Set(Object.keys(domains));
  const mapModules = map.modules ?? {};

  for (const [name, spec] of Object.entries(domains)) {
    for (const field of ["mayImport", "mayImportTypeOnly"]) {
      if (spec[field] !== undefined && !Array.isArray(spec[field])) errors.push(`domain ${name}: ${field} must be an array`);
      for (const target of spec[field] ?? []) {
        if (!domainNames.has(target)) errors.push(`domain ${name}: ${field} names undeclared domain "${target}"`);
      }
    }
  }

  // #2453 row 7 root flip (owner decision 2026-10-30, option 1): when the map
  // declares `rootDefaultDomain`, a module directly under core/ that the map
  // does not list belongs to that domain (kernel). The map then lists only the
  // root exceptions; an entry that repeats the default is a second source of
  // truth and fails. Modules in a non-domain subdirectory still need an entry.
  const rootDefault = map.rootDefaultDomain;
  if (rootDefault !== undefined && !domainNames.has(rootDefault)) {
    errors.push(`rootDefaultDomain names undeclared domain "${rootDefault}"`);
  }
  const moduleRels = listTsFiles(coreDir).map((file) => toPosix(path.relative(coreDir, file))).sort();
  const onDisk = new Set(moduleRels);
  const domainOf = new Map();
  const missingFromMap = [];
  const rootDefaulted = [];
  for (const rel of moduleRels) {
    const top = rel.includes("/") ? rel.split("/")[0] : null;
    const dirDomain = top && domainNames.has(top) ? top : null;
    if (dirDomain) {
      // A domain directory is authoritative; a map entry would be a second source of truth.
      if (Object.hasOwn(mapModules, rel)) errors.push(`${rel}: lives in the core/${dirDomain}/ domain directory; remove its map entry`);
      domainOf.set(rel, dirDomain);
    } else if (Object.hasOwn(mapModules, rel)) {
      const domain = mapModules[rel];
      if (!domainNames.has(domain)) errors.push(`${rel}: map assigns undeclared domain "${domain}"`);
      if (rootDefault !== undefined && !top && domain === rootDefault) {
        errors.push(`${rel}: the core/ root defaults to "${rootDefault}"; remove its map entry`);
      }
      domainOf.set(rel, domain);
    } else if (rootDefault !== undefined && !top) {
      rootDefaulted.push(rel);
      domainOf.set(rel, rootDefault);
    } else {
      missingFromMap.push(rel);
    }
  }
  const unknownInMap = Object.keys(mapModules).filter((rel) => !onDisk.has(rel)).sort();
  for (const rel of missingFromMap) errors.push(`${rel}: core module missing from the domain map — declare its domain in ${toPosix(path.relative(REPO_ROOT, DOMAIN_MAP_PATH))}`);
  for (const rel of unknownInMap) errors.push(`${rel}: domain map lists a module that does not exist — remove the entry`);

  const allowed = (fromDomain, toDomain, typeOnly) => {
    if (fromDomain === toDomain) return true;
    const spec = domains[fromDomain];
    if (!spec) return false;
    if ((spec.mayImport ?? []).includes(toDomain)) return true;
    return typeOnly && (spec.mayImportTypeOnly ?? []).includes(toDomain);
  };

  const edges = collectCoreEdges(coreDir, moduleRels);
  const valueViolations = [];
  const typeViolations = [];
  for (const edge of edges) {
    const fromDomain = domainOf.get(edge.from);
    const toDomain = domainOf.get(edge.to);
    if (!fromDomain || !toDomain || allowed(fromDomain, toDomain, edge.typeOnly)) continue;
    const violation = { from: edge.from, to: edge.to, fromDomain, toDomain, line: edge.line };
    (edge.typeOnly ? typeViolations : valueViolations).push(violation);
  }
  for (const v of valueViolations) {
    errors.push(`${v.from}:${v.line} value-imports ${v.to} (${v.fromDomain} -> ${v.toDomain} is not allowed by the domain allow-matrix)`);
  }

  const baselineEntries = Array.isArray(baseline.typeOnlyViolations) ? baseline.typeOnlyViolations : [];
  if (!Array.isArray(baseline.typeOnlyViolations)) errors.push("type baseline: typeOnlyViolations must be an array");
  const baselineKeys = new Set(baselineEntries.map(edgeKey));
  const currentKeys = new Set(typeViolations.map(edgeKey));
  const newTypeViolations = typeViolations.filter((v) => !baselineKeys.has(edgeKey(v)));
  const lowerableTypeViolations = baselineEntries.filter((v) => !currentKeys.has(edgeKey(v))).map(({ from, to }) => ({ from, to }));
  for (const v of newTypeViolations) {
    errors.push(`${v.from}:${v.line} type-imports ${v.to} (${v.fromDomain} -> ${v.toDomain}); new type-only violation not in the baseline — re-point it to the defining module or declare a narrow port`);
  }

  const perDomain = {};
  for (const domain of domainOf.values()) perDomain[domain] = (perDomain[domain] ?? 0) + 1;

  return {
    ok: errors.length === 0,
    errors,
    modules: moduleRels.length,
    perDomain,
    edges: edges.length,
    typeOnlyEdges: edges.filter((edge) => edge.typeOnly).length,
    missingFromMap,
    unknownInMap,
    rootDefaultDomain: rootDefault ?? null,
    rootDefaulted,
    valueViolations,
    typeViolations,
    typeBaseline: baselineEntries.length,
    newTypeViolations,
    lowerableTypeViolations,
  };
}

/** Rewrite the type baseline to the current set, only if that does not add an entry. */
export function lowerTypeBaseline(result, baselinePath = TYPE_BASELINE_PATH) {
  if (result.newTypeViolations.length > 0) {
    return { ok: false, reason: "refusing to write: the current tree has type-only violations that are not in the baseline (the baseline only goes down)" };
  }
  const baseline = readJson(baselinePath);
  baseline.typeOnlyViolations = result.typeViolations.map(({ from, to }) => ({ from, to }));
  fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
  return { ok: true, from: result.typeBaseline, to: baseline.typeOnlyViolations.length };
}

function summarize(domainResult) {
  return {
    ok: domainResult.ok,
    map: toPosix(path.relative(REPO_ROOT, DOMAIN_MAP_PATH)),
    modules: domainResult.modules,
    rootDefaultDomain: domainResult.rootDefaultDomain,
    rootDefaulted: domainResult.rootDefaulted.length,
    perDomain: domainResult.perDomain,
    edges: domainResult.edges,
    typeOnlyEdges: domainResult.typeOnlyEdges,
    valueViolations: domainResult.valueViolations.length,
    typeOnlyViolations: domainResult.typeViolations.length,
    typeOnlyBaseline: domainResult.typeBaseline,
    lowerableTypeViolations: domainResult.lowerableTypeViolations,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== "--lower-baseline");
  if (unknown.length) {
    console.error(`unknown argument(s): ${unknown.join(", ")}`);
    process.exit(2);
  }
  const isolation = checkAllCoreIsolationTargets();
  const domainResult = checkCoreDomainBoundaries();
  if (args.includes("--lower-baseline")) {
    const written = lowerTypeBaseline(domainResult);
    console.log(JSON.stringify(written, null, 2));
    process.exit(written.ok ? 0 : 1);
  }
  const report = { ok: isolation.ok && domainResult.ok, forbidden: isolation.forbidden, coreDomains: summarize(domainResult) };
  if (!report.ok) {
    if (!isolation.ok) {
      console.error("broker core dependency-isolation guard FAILED — the broker core must not import harness/app packages:");
      console.error(JSON.stringify(isolation, null, 2));
    }
    if (!domainResult.ok) {
      console.error("broker core domain-boundary guard FAILED (#2453; map + allow-matrix in docs/ops/broker-core-domain-map.json):");
      for (const error of domainResult.errors) console.error(`  - ${error}`);
    }
    console.error(JSON.stringify(report, null, 2));
    process.exit(1);
  }
  if (domainResult.lowerableTypeViolations.length > 0) {
    console.error(
      `broker core domain-boundary guard: ${domainResult.lowerableTypeViolations.length} baselined type-only violation(s) are fixed; ` +
        "lower the baseline with: node scripts/check-broker-core-dependency-isolation.mjs --lower-baseline",
    );
  }
  console.log(JSON.stringify({ ...report, checked: "packages/{broker,review-lifecycle}/src + package.json + core domain map" }, null, 2));
}
