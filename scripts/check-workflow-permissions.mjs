#!/usr/bin/env node
/**
 * Workflow token-permissions gate (#1228 L1).
 *
 * Every GitHub Actions workflow must declare an explicit top-level
 * `permissions:` block so the GITHUB_TOKEN starts from a least-privilege
 * grant instead of the repository default (historically read/write on
 * everything). Individual jobs may still widen their own scope with a
 * job-level block where needed (e.g. paths-filter needs pull-requests:
 * read) — this gate only checks that the workflow-level default exists
 * and is not the `write-all` escape hatch. Absence-detection: a new
 * workflow added without a permissions block turns this gate red.
 */
import fs from 'node:fs';
import path from 'node:path';

const TOP_LEVEL_PERMISSIONS = /^permissions:/m;
const WRITE_ALL = /^permissions:\s*write-all\s*$/m;

export function evaluateWorkflowPermissions(files) {
  const failures = [];
  if (!Array.isArray(files) || files.length === 0) {
    return ['no workflow files found under .github/workflows — fail closed'];
  }
  for (const { name, content } of files) {
    if (!TOP_LEVEL_PERMISSIONS.test(content)) {
      failures.push(`${name}: missing top-level permissions block (GITHUB_TOKEN falls back to the repository default grant)`);
    } else if (WRITE_ALL.test(content)) {
      failures.push(`${name}: top-level permissions is write-all — declare the minimal scopes instead`);
    }
  }
  return failures;
}

export function loadWorkflowFiles(dir) {
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort()
    .map((name) => ({ name, content: fs.readFileSync(path.join(dir, name), 'utf8') }));
}

function main() {
  const dir = path.resolve(process.cwd(), process.env.WORKFLOWS_DIR || '.github/workflows');
  const files = loadWorkflowFiles(dir);
  const failures = evaluateWorkflowPermissions(files);
  if (failures.length) {
    console.error(`workflow permissions FAILED (${failures.length} problem(s)):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`workflow permissions ok (${files.length} workflow(s) declare a top-level permissions block)`);
}

const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isDirectRun) main();
