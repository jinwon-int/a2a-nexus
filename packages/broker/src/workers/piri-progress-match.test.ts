/**
 * Piri progress directory matching regression tests (#2011).
 *
 * A stray short directory in the piri work root (e.g. `s`) used to match
 * nearly every task id via `taskId.includes(entry.name)`, so its days-old
 * `piri-progress.jsonl` mtime was reported as live progress and the broker's
 * stale detection dead-lettered fresh tasks through automatic requeues.
 *
 * @see jinwon-int/a2a-nexus#2011
 */

import test from "node:test";
import assert from "node:assert/strict";

import { piriProgressDirMatches, sanitizePiriName } from "./broker-worker-client.js";

const WORKER = "dungae";
const TASK_ID = "skills_intake_review-pr18-dungae-20260828T182004Z";
const sessionDir = sanitizePiriName(`a2a-${WORKER}-${TASK_ID}-analysis`).slice(0, 48);

test("exact sanitized session directory matches", () => {
  assert.equal(piriProgressDirMatches(sessionDir, sessionDir, TASK_ID), true);
});

test("suffixed session shapes containing the sanitized task id match", () => {
  const dialectic = `${sessionDir}-dialectic`;
  assert.equal(piriProgressDirMatches(dialectic, sessionDir, TASK_ID), true);

  const github = sanitizePiriName(`a2a-${WORKER}-${TASK_ID}-analysis-github`);
  assert.equal(piriProgressDirMatches(github, sessionDir, TASK_ID), true);
});

test("the stray one-character directory from #2011 never matches", () => {
  assert.equal(piriProgressDirMatches("s", sessionDir, TASK_ID), false);
});

test("generic short or unrelated directory names never match", () => {
  assert.equal(piriProgressDirMatches("k3canary2", sessionDir, TASK_ID), false);
  assert.equal(piriProgressDirMatches("a2a-dungae-2026", sessionDir, TASK_ID), false);
  assert.equal(piriProgressDirMatches("a2a-dungae-uuid-session", sessionDir, TASK_ID), false);
});

test("hyphenated task ids match their sanitized directory shapes", () => {
  const hyphenated = "skills-intake-review-pr18-dungae-20260828T182004Z";
  const dir = sanitizePiriName(`a2a-${WORKER}-${hyphenated}-analysis`).slice(0, 48);
  assert.equal(piriProgressDirMatches(dir, dir, hyphenated), true);
  assert.equal(piriProgressDirMatches(`${dir}-github`, dir, hyphenated), true);
});

test("a task id whose sanitized form is too generic only matches exactly", () => {
  const generic = "ab-cd";
  assert.ok(sanitizePiriName(generic).length < 8);
  assert.equal(piriProgressDirMatches("ab-cd-x", sanitizePiriName(generic), generic), false);
  assert.equal(piriProgressDirMatches(sanitizePiriName(generic), sanitizePiriName(generic), generic), true);
});
