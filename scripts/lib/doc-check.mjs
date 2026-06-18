import fs from 'node:fs';
import path from 'node:path';

export function createDocCheckContext({ root = process.cwd(), name = 'document validation' } = {}) {
  const failures = [];

  function fail(message) {
    failures.push(message);
  }

  function expect(condition, message) {
    if (!condition) fail(message);
  }

  function readRel(rel) {
    try {
      return fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      return null;
    }
  }

  function parseJson(rel) {
    const text = readRel(rel);
    if (text === null) {
      fail(`missing ${rel}`);
      return null;
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      fail(`${rel}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  function finish(successMessage) {
    if (failures.length) {
      console.error(`${name} failed:\n- ${failures.join('\n- ')}`);
      process.exit(1);
    }
    console.log(successMessage);
  }

  return {
    root,
    failures,
    fail,
    expect,
    readRel,
    parseJson,
    finish,
  };
}
