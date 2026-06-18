import { createDocCheckContext } from './doc-check.mjs';

function getPath(value, dottedPath) {
  return dottedPath.split('.').reduce((current, part) => {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current) && /^\d+$/.test(part)) return current[Number(part)];
    return current[part];
  }, value);
}

function describe(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  return JSON.stringify(value);
}

function matchesWhere(item, where) {
  return Object.entries(where).every(([path, expected]) => getPath(item, path) === expected);
}

function assertionTarget(roots, assertion) {
  const root = roots[assertion.source ?? 'fixture'];
  return assertion.path ? getPath(root, assertion.path) : root;
}

function whenMatches(roots, when) {
  if (!when) return true;
  const actual = assertionTarget(roots, when);
  if ('equals' in when) return actual === when.equals;
  if ('oneOf' in when) return when.oneOf.includes(actual);
  throw new Error(`unsupported when condition ${JSON.stringify(when)}`);
}

function applyAssertion({ expect }, roots, assertion, label) {
  if (!whenMatches(roots, assertion.when)) return;
  const actual = assertionTarget(roots, assertion);
  const message = assertion.message ?? `${label}: ${assertion.path ?? assertion.source ?? 'value'} assertion failed`;

  if ('equals' in assertion) {
    expect(actual === assertion.equals, `${message}: expected ${describe(assertion.equals)}, got ${describe(actual)}`);
  }
  if ('notEquals' in assertion) {
    expect(actual !== assertion.notEquals, `${message}: expected value not to be ${describe(assertion.notEquals)}`);
  }
  if ('oneOf' in assertion) {
    expect(assertion.oneOf.includes(actual), `${message}: expected one of ${describe(assertion.oneOf)}, got ${describe(actual)}`);
  }
  if ('includes' in assertion) {
    const expected = assertion.includes;
    expect(
      typeof actual === 'string' || Array.isArray(actual),
      `${message}: includes target must be string or array`,
    );
    expect(actual?.includes(expected), `${message}: missing ${describe(expected)}`);
  }
  if ('includesAll' in assertion) {
    expect(
      typeof actual === 'string' || Array.isArray(actual),
      `${message}: includesAll target must be string or array`,
    );
    for (const expected of assertion.includesAll) {
      expect(actual?.includes(expected), `${message}: missing ${describe(expected)}`);
    }
  }
  if ('matches' in assertion) {
    expect(typeof actual === 'string', `${message}: matches target must be a string`);
    expect(new RegExp(assertion.matches).test(actual ?? ''), `${message}: ${describe(actual)} does not match /${assertion.matches}/`);
  }
  if ('min' in assertion) {
    expect(typeof actual === 'number', `${message}: min target must be a number`);
    expect(actual >= assertion.min, `${message}: ${actual} < ${assertion.min}`);
  }
  if ('minLength' in assertion) {
    expect(Array.isArray(actual) || typeof actual === 'string', `${message}: minLength target must be array or string`);
    expect((actual?.length ?? 0) >= assertion.minLength, `${message}: length ${(actual?.length ?? 0)} < ${assertion.minLength}`);
  }
  if ('lengthEquals' in assertion) {
    expect(Array.isArray(actual) || typeof actual === 'string', `${message}: lengthEquals target must be array or string`);
    expect((actual?.length ?? 0) === assertion.lengthEquals, `${message}: length ${(actual?.length ?? 0)} !== ${assertion.lengthEquals}`);
  }
  if ('arraySome' in assertion) {
    expect(Array.isArray(actual), `${message}: arraySome target must be an array`);
    expect(actual?.some((item) => matchesWhere(item, assertion.arraySome)), `${message}: missing matching object ${describe(assertion.arraySome)}`);
  }
  if ('arrayNoneMatches' in assertion) {
    expect(Array.isArray(actual), `${message}: arrayNoneMatches target must be an array`);
    const matching = (actual ?? []).filter((item) => matchesWhere(item, assertion.arrayNoneMatches));
    expect(matching.length === 0, `${message}: found ${matching.length} matching object(s) ${describe(assertion.arrayNoneMatches)}`);
  }
  if ('arrayEveryEquals' in assertion) {
    expect(Array.isArray(actual), `${message}: arrayEveryEquals target must be an array`);
    for (const [field, expected] of Object.entries(assertion.arrayEveryEquals)) {
      const bad = (actual ?? []).filter((item) => getPath(item, field) !== expected);
      expect(bad.length === 0, `${message}: ${bad.length} item(s) do not have ${field}=${describe(expected)}`);
    }
  }
}

export function runDocSpecCheck(specId, { registryPath = 'docs/ops/data-driven-validation-registry.json' } = {}) {
  const ctx = createDocCheckContext({ name: `doc spec ${specId}` });
  const { parseJson, readRel, expect, fail, finish } = ctx;
  const registry = parseJson(registryPath);
  const spec = registry?.checks?.find((entry) => entry.id === specId);
  expect(Boolean(spec), `registry: missing check ${specId}`);
  if (!spec) {
    fail(`registry: missing check ${specId}`);
    finish(`doc spec ${specId} failed`);
    return;
  }

  const fixture = spec.fixture ? parseJson(spec.fixture) : null;
  const doc = spec.doc ? readRel(spec.doc) : null;
  const currentState = spec.currentState ? readRel(spec.currentState) : null;
  const extraDocs = Object.fromEntries(
    Object.entries(spec.extraDocs ?? {}).map(([name, docPath]) => [name, readRel(docPath)]),
  );
  const pkg = parseJson('package.json');
  const releaseGateInventory = parseJson('docs/ops/release-gate-step-inventory.json');

  if (spec.fixture) expect(fixture !== null, `${spec.id}: missing fixture ${spec.fixture}`);
  if (spec.doc) expect(doc !== null, `${spec.id}: missing doc ${spec.doc}`);
  if (spec.currentState) expect(currentState !== null, `${spec.id}: missing current-state doc ${spec.currentState}`);
  for (const [name, content] of Object.entries(extraDocs)) {
    expect(content !== null, `${spec.id}: missing extra doc ${name}: ${spec.extraDocs[name]}`);
  }

  const roots = { fixture, doc, currentState, package: pkg, releaseGateInventory, ...extraDocs };
  for (const assertion of spec.assertions ?? []) {
    applyAssertion(ctx, roots, assertion, spec.id);
  }

  if (spec.packageScript) {
    expect(
      pkg?.scripts?.[spec.packageScript.name] === spec.packageScript.command,
      `${spec.id}: package script ${spec.packageScript.name} mismatch`,
    );
  }

  if (spec.releaseGateStep) {
    const step = releaseGateInventory?.entries?.find((entry) => entry.name === spec.releaseGateStep.name);
    expect(Boolean(step), `${spec.id}: release-gate inventory missing ${spec.releaseGateStep.name}`);
    if (step) {
      expect(step.tier === spec.releaseGateStep.tier, `${spec.id}: release-gate tier mismatch for ${step.name}`);
      expect(
        JSON.stringify(step.args) === JSON.stringify(spec.releaseGateStep.args),
        `${spec.id}: release-gate args mismatch for ${step.name}`,
      );
    }
  }

  if (ctx.failures.length) {
    console.error(`${spec.title ?? spec.id} validation failed:\n- ${ctx.failures.join('\n- ')}`);
    process.exit(1);
  }
  finish(spec.successMessage ?? `${spec.id} ok`);
}
