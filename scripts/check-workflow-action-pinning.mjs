#!/usr/bin/env node
/**
 * GitHub Actions SHA-pinning gate (#1228 L3).
 *
 * Third-party workflow actions must be pinned to immutable full commit SHAs.
 * Keep the original moving tag as a trailing comment (for example
 * `uses: actions/checkout@<40-hex-sha> # v7`) so humans can see the intended
 * update lane while automation gets an immutable ref.
 */
import fs from 'node:fs';
import path from 'node:path';

const USES_LINE = /(^\s*-\s+uses:\s*)([^\s#]+)(.*)$/;
const FULL_SHA = /^[0-9a-f]{40}$/i;
const TAG_COMMENT = /#\s*v\d[\w.-]*/i;

function isLocalAction(ref) {
  return ref.startsWith('./') || ref.startsWith('../') || ref.startsWith('docker://');
}

export function evaluateWorkflowActionPinning(files) {
  const failures = [];
  if (!Array.isArray(files) || files.length === 0) {
    return ['no workflow files found under .github/workflows — fail closed'];
  }
  for (const { name, content } of files) {
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      const match = USES_LINE.exec(line);
      if (!match) continue;
      const ref = match[2];
      if (isLocalAction(ref)) continue;
      const at = ref.lastIndexOf('@');
      if (at === -1) {
        failures.push(`${name}:${index + 1}: action reference must include @<40-hex-sha>`);
        continue;
      }
      const pin = ref.slice(at + 1);
      if (!FULL_SHA.test(pin)) {
        failures.push(`${name}:${index + 1}: action reference ${ref} is not pinned to a full commit SHA`);
        continue;
      }
      if (!TAG_COMMENT.test(match[3] ?? '')) {
        failures.push(`${name}:${index + 1}: SHA-pinned action must retain the source tag as a trailing comment (for example # v4)`);
      }
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
  const failures = evaluateWorkflowActionPinning(files);
  if (failures.length) {
    console.error(`workflow action pinning FAILED (${failures.length} problem(s)):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`workflow action pinning ok (${files.length} workflow(s); external actions use full commit SHAs)`);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isDirectRun) main();
