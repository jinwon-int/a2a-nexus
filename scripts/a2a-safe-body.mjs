#!/usr/bin/env node
/**
 * Safe GitHub body writer for A2A automation.
 *
 * Bodies are written as literal UTF-8 bytes to a temporary 0600 Markdown file and
 * then passed to gh with --body-file. The body is never placed in argv, shell
 * heredocs, inline --body strings, or stdout. This prevents Markdown backticks,
 * code fences, pipes, $VAR, and $(command) substrings from being evaluated or
 * corrupted by shell interpolation.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function assertText(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function assertNumberLike(value, name) {
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new TypeError(`${name} must be a number or string`);
  }
  const text = String(value);
  if (!/^\d+$/.test(text)) throw new TypeError(`${name} must be an issue/PR number`);
  return text;
}

function addRepeatedFlag(args, flag, values) {
  for (const value of values ?? []) {
    if (typeof value === 'string' && value.trim()) args.push(flag, value.trim());
  }
}

export function writeBodyFile(body, options = {}) {
  if (typeof body !== 'string') throw new TypeError('body must be a string');
  const dir = options.dir ?? tmpdir();
  assertText(dir, 'dir');
  const tmpDir = mkdtempSync(join(dir, options.prefix ?? 'a2a-gh-body-'));
  const path = join(tmpDir, options.filename ?? 'body.md');
  writeFileSync(path, body, { encoding: 'utf8', mode: 0o600 });
  // Some platforms honor umask on creation; chmod makes the invariant explicit.
  chmodSync(path, 0o600);
  return {
    path,
    dir: tmpDir,
    cleanup() {
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

export async function withBodyFile(body, callback, options = {}) {
  if (typeof callback !== 'function') throw new TypeError('callback must be a function');
  const bodyFile = writeBodyFile(body, options);
  try {
    return await callback(bodyFile.path);
  } finally {
    if (options.keep !== true) bodyFile.cleanup();
  }
}

function runGh(args, options = {}) {
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const result = spawnSyncImpl(options.ghBin ?? 'gh', args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    maxBuffer: options.maxBuffer ?? 1024 * 1024,
  });
  if (result.error) throw result.error;
  const status = result.status ?? 1;
  if (status !== 0) {
    const action = args.slice(0, 2).join(' ');
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    throw new Error(`gh ${action} failed with exit ${status}${stderr ? `: ${stderr}` : ''}`);
  }
  return {
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    status,
  };
}

export function createIssue(input, options = {}) {
  assertText(input?.repo, 'repo');
  assertText(input?.title, 'title');
  if (typeof input?.body !== 'string') throw new TypeError('body must be a string');
  return withBodyFile(input.body, (bodyFile) => {
    const args = ['issue', 'create', '--repo', input.repo, '--title', input.title, '--body-file', bodyFile];
    addRepeatedFlag(args, '--label', input.labels);
    addRepeatedFlag(args, '--assignee', input.assignees);
    if (input.milestone) args.push('--milestone', String(input.milestone));
    if (input.project) args.push('--project', String(input.project));
    return runGh(args, options);
  }, options);
}

export function editIssue(input, options = {}) {
  assertText(input?.repo, 'repo');
  const number = assertNumberLike(input?.number, 'number');
  if (typeof input?.body !== 'string') throw new TypeError('body must be a string');
  return withBodyFile(input.body, (bodyFile) => {
    const args = ['issue', 'edit', number, '--repo', input.repo, '--body-file', bodyFile];
    if (input.title) args.push('--title', String(input.title));
    addRepeatedFlag(args, '--add-label', input.addLabels);
    addRepeatedFlag(args, '--remove-label', input.removeLabels);
    return runGh(args, options);
  }, options);
}

export function commentIssue(input, options = {}) {
  assertText(input?.repo, 'repo');
  const number = assertNumberLike(input?.number, 'number');
  if (typeof input?.body !== 'string') throw new TypeError('body must be a string');
  return withBodyFile(input.body, (bodyFile) => {
    return runGh(['issue', 'comment', number, '--repo', input.repo, '--body-file', bodyFile], options);
  }, options);
}

export const __test = Object.freeze({ runGh });
