// json-schema-lite unit tests (#2084): the keyword subset the bounded
// PR review lifecycle schemas use, plus the fail-closed contract — any
// unsupported keyword must throw rather than silently validate less.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createJsonSchemaValidator } from './json-schema-lite.mjs';

test('type keyword accepts matches and rejects non-matches', () => {
  const validate = createJsonSchemaValidator({ type: 'string' });
  assert.equal(validate('x'), true);
  assert.equal(validate(1), false);
  assert.equal(validate(null), false);

  const integer = createJsonSchemaValidator({ type: 'integer' });
  assert.equal(integer(3), true);
  assert.equal(integer(3.5), false);
});

test('string keywords: pattern, minLength, maxLength', () => {
  const validate = createJsonSchemaValidator({
    type: 'string',
    pattern: '^[a-z]+$',
    minLength: 2,
    maxLength: 4,
  });
  assert.equal(validate('ab'), true);
  assert.equal(validate('abcde'), false);
  assert.equal(validate('AB'), false);
  assert.equal(validate('a'), false);
});

test('number keywords: minimum and exclusiveMinimum', () => {
  const validate = createJsonSchemaValidator({ type: 'number', minimum: 1 });
  assert.equal(validate(1), true);
  assert.equal(validate(0.5), false);
  const exclusive = createJsonSchemaValidator({ type: 'number', exclusiveMinimum: 1 });
  assert.equal(exclusive(1), false);
  assert.equal(exclusive(1.5), true);
});

test('array keywords: minItems, maxItems, uniqueItems, items', () => {
  const validate = createJsonSchemaValidator({
    type: 'array',
    minItems: 1,
    maxItems: 2,
    uniqueItems: true,
    items: { type: 'string', minLength: 1 },
  });
  assert.equal(validate(['a']), true);
  assert.equal(validate(['a', 'b']), true);
  assert.equal(validate([]), false);
  assert.equal(validate(['a', 'b', 'c']), false);
  assert.equal(validate(['a', 'a']), false);
  assert.equal(validate(['a', '']), false);
  // duplicate detection is deep (JSON value equality), not identity
  assert.equal(validate([{ a: 1 }, { a: 1 }]), false);
  assert.equal(validate([['x'], ['x']]), false);
});

test('object keywords: required, properties, additionalProperties false', () => {
  const validate = createJsonSchemaValidator({
    type: 'object',
    required: ['id'],
    additionalProperties: false,
    properties: {
      id: { type: 'string', pattern: '^AC-[0-9]+$' },
      note: { type: 'string' },
    },
  });
  assert.equal(validate({ id: 'AC-1' }), true);
  assert.equal(validate({ id: 'AC-1', note: 'n' }), true);
  assert.equal(validate({}), false);
  assert.equal(validate({ id: 'zz' }), false);
  assert.equal(validate({ id: 'AC-1', extra: 1 }), false);
});

test('const and enum compare by JSON value equality', () => {
  const constValidate = createJsonSchemaValidator({ const: 'IntentContractV1' });
  assert.equal(constValidate('IntentContractV1'), true);
  assert.equal(constValidate('other'), false);
  const enumValidate = createJsonSchemaValidator({ enum: ['pass', 'fail', ['x']] });
  assert.equal(enumValidate('pass'), true);
  assert.equal(enumValidate(['x']), true);
  assert.equal(enumValidate('maybe'), false);
});

test('oneOf demands exactly one matching branch', () => {
  const validate = createJsonSchemaValidator({
    oneOf: [{ type: 'string' }, { type: 'string', maxLength: 2 }],
  });
  // both branches match → invalid; exactly one → valid
  assert.equal(validate('abc'), true);
  assert.equal(validate('ab'), false);
  assert.equal(validate(1), false);
});

test('allOf requires every branch and if/then applies conditionally', () => {
  const validate = createJsonSchemaValidator({
    type: 'object',
    properties: { category: { type: 'string' }, blocking: { type: 'boolean' } },
    allOf: [
      {
        if: { properties: { category: { enum: ['style', 'preference'] } } },
        then: { properties: { blocking: { const: false } } },
      },
    ],
  });
  assert.equal(validate({ category: 'style', blocking: false }), true);
  assert.equal(validate({ category: 'style', blocking: true }), false);
  // if-condition not met → then does not apply
  assert.equal(validate({ category: 'security', blocking: true }), true);
  // absent category → if subschema vacuously passes → then applies
  assert.equal(validate({ blocking: true }), false);
});

test('local $ref resolves against the document root', () => {
  const validate = createJsonSchemaValidator({
    type: 'object',
    required: ['findings'],
    properties: {
      findings: {
        type: 'array',
        items: { $ref: '#/definitions/finding' },
      },
    },
    definitions: {
      finding: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string' } } },
    },
  });
  assert.equal(validate({ findings: [{ id: 'f1' }] }), true);
  assert.equal(validate({ findings: [{ nope: 1 }] }), false);
});

test('whole-document registry $ref switches the document root for nested local refs', () => {
  const target = {
    type: 'object',
    required: ['items'],
    properties: { items: { type: 'array', items: { $ref: '#/definitions/entry' } } },
    definitions: { entry: { type: 'string' } },
  };
  const validate = createJsonSchemaValidator(
    { oneOf: [{ $ref: 'target-doc.json' }, { type: 'null' }] },
    { registry: { 'target-doc.json': target } },
  );
  assert.equal(validate({ items: ['a'] }), true);
  assert.equal(validate({ items: [1] }), false);
  assert.equal(validate(null), true);
  assert.equal(validate('x'), false);
});

test('unresolvable $refs throw instead of silently passing', () => {
  assert.throws(
    () => createJsonSchemaValidator({ $ref: '#/definitions/missing' })({}),
    /unresolvable local \$ref/,
  );
  assert.throws(
    () => createJsonSchemaValidator({ $ref: 'unknown-doc.json' }, { registry: {} })({}),
    /not in the schema registry/,
  );
});

test('unsupported keywords fail closed with a thrown error (#2084)', () => {
  for (const keyword of ['format', 'patternProperties', 'contains', 'propertyNames']) {
    assert.throws(
      () => createJsonSchemaValidator({ [keyword]: {} })('x'),
      new RegExp(`unsupported JSON Schema keyword "${keyword}"`),
      `expected fail-closed on ${keyword}`,
    );
  }
  // anyOf IS supported (schema form), so it must not throw
  assert.equal(createJsonSchemaValidator({ anyOf: [{ type: 'string' }] })('x'), true);
  // tuple-form items fails closed
  assert.throws(
    () => createJsonSchemaValidator({ items: [{ type: 'string' }] })([]),
    /tuple-form items is not supported/,
  );
  // unsupported type name fails closed
  assert.throws(
    () => createJsonSchemaValidator({ type: 'weird' })('x'),
    /unsupported type/,
  );
});
