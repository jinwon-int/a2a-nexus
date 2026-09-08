/**
 * json-schema-lite: a deliberately small, fail-closed JSON Schema validator
 * (#2084).
 *
 * Replaces the `ajv` dependency chain (5 packages + an overrides pin, ~3 MB)
 * whose only consumer was the bounded PR review lifecycle conformance check.
 * It supports exactly the keyword subset those five frozen schemas use:
 *
 *   type, enum, const, pattern, minLength, maxLength, minimum,
 *   exclusiveMinimum, minItems, maxItems, uniqueItems, required,
 *   properties, additionalProperties, items (schema form), oneOf, allOf,
 *   if/then/else, $ref (local `#/definitions/...` and registry file refs)
 *
 * Annotations ($schema, title, description, default, definitions) are
 * accepted and ignored. Anything else FAILS CLOSED with a throw: if a schema
 * grows a keyword this validator does not implement, the conformance check
 * errors out instead of silently validating less. Extending the supported
 * subset is a deliberate code change, never an accident.
 */
const SUPPORTED_KEYWORDS = new Set([
  // annotations / containers
  '$schema', 'title', 'description', 'default', 'definitions',
  // core
  '$ref', 'type', 'enum', 'const',
  // strings
  'pattern', 'minLength', 'maxLength',
  // numbers
  'minimum', 'exclusiveMinimum', 'maximum', 'exclusiveMaximum',
  // arrays
  'items', 'minItems', 'maxItems', 'uniqueItems',
  // objects
  'required', 'properties', 'additionalProperties',
  // combinators
  'oneOf', 'allOf', 'anyOf', 'if', 'then', 'else',
]);

const MAX_ERRORS = 25;

function isIntegerLike(value) {
  return typeof value === 'number' && Number.isInteger(value);
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => deepEqual(a[key], b[key]));
}

function typeMatches(type, value) {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return isIntegerLike(value);
    case 'boolean': return typeof value === 'boolean';
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'null': return value === null;
    default:
      throw new Error(`json-schema-lite: unsupported type "${type}"`);
  }
}

/**
 * Create a validator for one schema document (ajv-compatible shape: a callable
 * `validate(value) → boolean` carrying an `errors` array).
 *
 * @param {object} rootSchema the schema document to compile
 * @param {{ registry?: Record<string, object> }} options registry maps
 *   whole-document $ref targets (e.g. "intent-contract-v1.json") to schemas.
 * @returns {{ (value: unknown): boolean, errors: Array<object> }}
 */
export function createJsonSchemaValidator(rootSchema, { registry = {} } = {}) {
  const errors = [];

  function resolveRef(ref, docRoot) {
    if (ref.startsWith('#/')) {
      let current = docRoot;
      for (const segment of ref.slice(2).split('/')) {
        current = current?.[segment];
        if (current === undefined) {
          throw new Error(`json-schema-lite: unresolvable local $ref "${ref}"`);
        }
      }
      return current;
    }
    const registered = registry[ref];
    if (!registered) {
      throw new Error(`json-schema-lite: $ref "${ref}" is not in the schema registry`);
    }
    return registered;
  }

  function assertSupported(schema, refHint) {
    for (const key of Object.keys(schema)) {
      if (!SUPPORTED_KEYWORDS.has(key)) {
        throw new Error(
          `json-schema-lite: unsupported JSON Schema keyword "${key}"` +
          (refHint ? ` (inside ${refHint})` : '') +
          ' — the bounded-lifecycle schemas are frozen at the audited subset; ' +
          'extend json-schema-lite deliberately instead of silently validating less (#2084)',
        );
      }
    }
    // Only schema-form items is supported; tuple form fails closed.
    if (Array.isArray(schema.items)) {
      throw new Error('json-schema-lite: tuple-form items is not supported (#2084 fail-closed)');
    }
  }

  function validateAgainst(schema, value, path, refHint, docRoot) {
    if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
      throw new Error(`json-schema-lite: schema node at ${path || '$'} is not an object`);
    }
    assertSupported(schema, refHint);

    let ok = true;
    function fail(message) {
      ok = false;
      if (errors.length < MAX_ERRORS) {
        errors.push({ instancePath: path, schemaPath: refHint, message });
      }
    }

    if (typeof schema.$ref === 'string') {
      const target = resolveRef(schema.$ref, docRoot);
      // A whole-document (registry) ref switches the document root that local
      // `#/definitions/...` fragments inside the target resolve against.
      const nextDocRoot = registry[schema.$ref] ?? docRoot;
      if (!validateAgainst(target, value, path, schema.$ref, nextDocRoot)) {
        ok = false;
      }
    }

    if ('type' in schema) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!types.some((type) => typeMatches(type, value))) {
        fail(`must be ${types.join(' or ')}`);
      }
    }
    if ('enum' in schema && !schema.enum.some((option) => deepEqual(option, value))) {
      fail('must be one of the enum values');
    }
    if ('const' in schema && !deepEqual(schema.const, value)) {
      fail('must equal the const value');
    }
    if (typeof value === 'string') {
      if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
        fail(`must match pattern ${schema.pattern}`);
      }
      if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
        fail(`must be at least ${schema.minLength} characters`);
      }
      if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
        fail(`must be at most ${schema.maxLength} characters`);
      }
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (typeof schema.minimum === 'number' && value < schema.minimum) {
        fail(`must be >= ${schema.minimum}`);
      }
      if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
        fail(`must be > ${schema.exclusiveMinimum}`);
      }
      if (typeof schema.maximum === 'number' && value > schema.maximum) {
        fail(`must be <= ${schema.maximum}`);
      }
      if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) {
        fail(`must be < ${schema.exclusiveMaximum}`);
      }
    }
    if (Array.isArray(value)) {
      if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
        fail(`must have at least ${schema.minItems} items`);
      }
      if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
        fail(`must have at most ${schema.maxItems} items`);
      }
      if (schema.uniqueItems === true) {
        for (let i = 0; i < value.length; i += 1) {
          for (let j = i + 1; j < value.length; j += 1) {
            if (deepEqual(value[i], value[j])) {
              fail(`items ${i} and ${j} are duplicates`);
            }
          }
        }
      }
      if (typeof schema.items === 'object' && schema.items !== null) {
        value.forEach((item, index) => {
          if (!validateAgainst(schema.items, item, `${path}[${index}]`, refHint, docRoot)) ok = false;
        });
      }
    }
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      for (const key of schema.required ?? []) {
        if (!(key in value)) fail(`missing required property "${key}"`);
      }
      if (typeof schema.properties === 'object' && schema.properties !== null) {
        for (const [key, subschema] of Object.entries(schema.properties)) {
          if (key in value) {
            if (!validateAgainst(subschema, value[key], `${path}.${key}`, refHint, docRoot)) ok = false;
          }
        }
      }
      if (schema.additionalProperties === false && typeof schema.properties === 'object') {
        for (const key of Object.keys(value)) {
          if (!(key in (schema.properties ?? {}))) {
            fail(`unexpected additional property "${key}"`);
          }
        }
      } else if (typeof schema.additionalProperties === 'object') {
        const declared = typeof schema.properties === 'object' && schema.properties !== null
          ? Object.keys(schema.properties)
          : [];
        for (const key of Object.keys(value)) {
          if (!declared.includes(key)) {
            if (!validateAgainst(schema.additionalProperties, value[key], `${path}.${key}`, refHint, docRoot)) ok = false;
          }
        }
      }
    }

    if (Array.isArray(schema.allOf)) {
      for (const [index, branch] of schema.allOf.entries()) {
        if (!validateAgainst(branch, value, path, `${refHint ?? '$'}.allOf[${index}]`, docRoot)) ok = false;
      }
    }
    if (Array.isArray(schema.oneOf)) {
      const matches = schema.oneOf.filter((branch, index) =>
        validateAgainst(branch, value, path, `${refHint ?? '$'}.oneOf[${index}]`, docRoot)).length;
      if (matches !== 1) fail(`must match exactly one oneOf branch (matched ${matches})`);
    }
    if (Array.isArray(schema.anyOf)) {
      const matches = schema.anyOf.some((branch, index) =>
        validateAgainst(branch, value, path, `${refHint ?? '$'}.anyOf[${index}]`, docRoot));
      if (!matches) fail('must match at least one anyOf branch');
    }
    if ('if' in schema) {
      const passesIf = validateAgainst(schema.if, value, path, `${refHint ?? '$'}.if`, docRoot);
      if (passesIf && 'then' in schema) {
        if (!validateAgainst(schema.then, value, path, `${refHint ?? '$'}.then`, docRoot)) ok = false;
      }
      if (!passesIf && 'else' in schema) {
        if (!validateAgainst(schema.else, value, path, `${refHint ?? '$'}.else`, docRoot)) ok = false;
      }
    }
    return ok;
  }

  function validate(value) {
    errors.length = 0;
    return validateAgainst(rootSchema, value, '$', undefined, rootSchema);
  }
  validate.errors = errors;
  return validate;
}
