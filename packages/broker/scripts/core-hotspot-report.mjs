#!/usr/bin/env node
/**
 * Broker core hotspot + dependency-direction reporter (a2a-nexus#1503).
 *
 * #1503 requires the top broker-core hotspots and the cycle/dependency
 * direction to be reported automatically instead of measured by hand. This
 * reporter builds the static import graph over packages/broker/src (test
 * files excluded) and reports:
 *
 *   - top modules by fan-in (most imported) and fan-out (most importing)
 *   - a coupling hotspot score (fan-in x fan-out) with line counts for size
 *   - import cycles as Tarjan strongly-connected components (size > 1)
 *   - layer-direction violations: src/core is the lowest layer of the
 *     independent broker product, so any src/core module importing a module
 *     outside src/core is an upward edge and is listed by importer
 *
 * Report-only: always exits 0 unless the source tree is unreadable. It never
 * gates — budgets/gates live in check-script-budget.mjs and
 * check-broker-core-dependency-isolation.mjs. Source-only static analysis:
 * no build, network, live broker, DB, or credential access.
 *
 * Usage:
 *   node scripts/core-hotspot-report.mjs [--top N] [--json]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SRC = path.join(SCRIPT_DIR, "..", "src");
const CORE_PREFIX = `core${path.sep}`;

/** Recursively collect production TS files (tests excluded). */
export function collectSourceFiles(srcDir) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        out.push(full);
      }
    }
  };
  walk(srcDir);
  return out.sort();
}

/**
 * Extract relative module specifiers from a source text. Handles multi-line
 * imports, export-from re-exports, bare side-effect imports, and `import type`.
 * Dynamic import() of relative paths is included as well.
 */
export function extractRelativeSpecifiers(text) {
  const specifiers = new Set();
  const patterns = [
    /(?:import|export)\b[\s\S]{0,800}?from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let match;
    while ((match = re.exec(text)) !== null) {
      if (match[1].startsWith(".")) specifiers.add(match[1]);
    }
  }
  return [...specifiers];
}

/** Resolve a relative specifier to a file in fileSet (TS sources may use .js specifiers). */
export function resolveSpecifier(fromFile, specifier, fileSet) {
  const base = path.normalize(path.join(path.dirname(fromFile), specifier));
  const candidates = [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, path.join(base, "index.ts")];
  for (const candidate of candidates) {
    if (fileSet.has(candidate)) return candidate;
  }
  return null;
}

/** Build the import graph: Map<file, importedFiles[]> restricted to the file set. */
export function buildImportGraph(files) {
  const fileSet = new Set(files);
  const graph = new Map();
  for (const file of files) {
    const deps = new Set();
    for (const specifier of extractRelativeSpecifiers(fs.readFileSync(file, "utf8"))) {
      const resolved = resolveSpecifier(file, specifier, fileSet);
      if (resolved && resolved !== file) deps.add(resolved);
    }
    graph.set(file, [...deps]);
  }
  return graph;
}

/** Fan-in (importers within the tree) and fan-out (imports within the tree) per file. */
export function computeFan(graph) {
  const fanIn = new Map();
  const fanOut = new Map();
  for (const [file, deps] of graph) {
    fanOut.set(file, deps.length);
    if (!fanIn.has(file)) fanIn.set(file, 0);
    for (const dep of deps) fanIn.set(dep, (fanIn.get(dep) ?? 0) + 1);
  }
  return { fanIn, fanOut };
}

/** Tarjan strongly-connected components; only components with size > 1 are cycles. */
export function findImportCycles(graph) {
  let nextIndex = 0;
  const index = new Map();
  const lowlink = new Map();
  const onStack = new Set();
  const stack = [];
  const cycles = [];

  const strongConnect = (v) => {
    index.set(v, nextIndex);
    lowlink.set(v, nextIndex);
    nextIndex += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!index.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v), lowlink.get(w)));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v), index.get(w)));
      }
    }
    if (lowlink.get(v) === index.get(v)) {
      const component = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      if (component.length > 1) cycles.push(component.sort());
    }
  };

  for (const file of graph.keys()) {
    if (!index.has(file)) strongConnect(file);
  }
  return cycles.sort((a, b) => b.length - a.length);
}

/**
 * Upward edges: files under the core directory importing files outside it.
 * corePrefix is the directory prefix relative to srcDir (default "core/").
 */
export function findDirectionViolations(graph, srcDir, corePrefix = CORE_PREFIX) {
  const violations = [];
  for (const [file, deps] of graph) {
    const rel = path.relative(srcDir, file);
    if (!rel.startsWith(corePrefix)) continue;
    for (const dep of deps) {
      const depRel = path.relative(srcDir, dep);
      if (!depRel.startsWith(corePrefix)) {
        violations.push({ importer: rel, imported: depRel });
      }
    }
  }
  return violations.sort((a, b) => a.importer.localeCompare(b.importer) || a.imported.localeCompare(b.imported));
}

/** Build the full report object. Paths are repo/srcDir-relative for stable output. */
export function buildReport({ srcDir = DEFAULT_SRC, top = 10 } = {}) {
  const files = collectSourceFiles(srcDir);
  const graph = buildImportGraph(files);
  const { fanIn, fanOut } = computeFan(graph);
  const lines = new Map(files.map((f) => [f, fs.readFileSync(f, "utf8").split("\n").length]));
  const rel = (f) => path.relative(srcDir, f).split(path.sep).join("/");

  let edgeCount = 0;
  for (const deps of graph.values()) edgeCount += deps.length;

  const ranked = (map) =>
    [...map.entries()]
      .map(([file, count]) => ({ file: rel(file), count, lines: lines.get(file) }))
      .sort((a, b) => b.count - a.count || a.file.localeCompare(b.file))
      .slice(0, top);

  const hotspots = [...graph.keys()]
    .map((file) => ({
      file: rel(file),
      fanIn: fanIn.get(file) ?? 0,
      fanOut: fanOut.get(file) ?? 0,
      score: (fanIn.get(file) ?? 0) * (fanOut.get(file) ?? 0),
      lines: lines.get(file),
    }))
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, top);

  const cycles = findImportCycles(graph).map((component) => component.map(rel));
  const directionViolations = findDirectionViolations(graph, srcDir).map((v) => ({
    importer: v.importer.split(path.sep).join("/"),
    imported: v.imported.split(path.sep).join("/"),
  }));

  return {
    srcDir: path.basename(srcDir),
    files: files.length,
    edges: edgeCount,
    topFanIn: ranked(fanIn),
    topFanOut: ranked(fanOut),
    hotspots,
    cycles: cycles.map((members) => ({ size: members.length, members })),
    directionViolations,
  };
}

export function formatText(report) {
  const out = [];
  out.push(
    `broker core hotspot report: ${report.files} modules, ${report.edges} in-tree import edges`,
  );
  out.push("");
  out.push(`top ${report.topFanIn.length} by fan-in (imported by):`);
  for (const item of report.topFanIn) out.push(`  ${item.count}\t${item.file} (${item.lines} lines)`);
  out.push("");
  out.push(`top ${report.topFanOut.length} by fan-out (imports):`);
  for (const item of report.topFanOut) out.push(`  ${item.count}\t${item.file} (${item.lines} lines)`);
  out.push("");
  out.push(`top ${report.hotspots.length} coupling hotspots (fan-in x fan-out):`);
  for (const item of report.hotspots) {
    out.push(`  ${item.score}\t${item.file} (in ${item.fanIn}, out ${item.fanOut}, ${item.lines} lines)`);
  }
  out.push("");
  out.push(`import cycles (strongly-connected components > 1): ${report.cycles.length}`);
  for (const cycle of report.cycles) {
    out.push(`  size ${cycle.size}:`);
    for (const member of cycle.members) out.push(`    ${member}`);
  }
  out.push("");
  out.push(
    `layer-direction violations (core -> outside core): ${report.directionViolations.length}`,
  );
  for (const v of report.directionViolations) out.push(`  ${v.importer} -> ${v.imported}`);
  return out.join("\n");
}

function main(argv) {
  const json = argv.includes("--json");
  const topIndex = argv.indexOf("--top");
  const top = topIndex >= 0 ? Number.parseInt(argv[topIndex + 1] ?? "", 10) : 10;
  const srcDir = process.env.BROKER_SRC_DIR ? path.resolve(process.env.BROKER_SRC_DIR) : DEFAULT_SRC;
  if (!fs.existsSync(srcDir)) {
    console.error(`core-hotspot-report: source dir not found: ${srcDir}`);
    process.exit(2);
  }
  const report = buildReport({ srcDir, top: Number.isFinite(top) && top > 0 ? top : 10 });
  console.log(json ? JSON.stringify(report, null, 2) : formatText(report));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
