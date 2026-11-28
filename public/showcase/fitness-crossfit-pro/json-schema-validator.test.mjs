import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FitnessCrossfitProSchemaValidator,
  SCHEMA_TEMPLATES,
  indexJsonLines,
  lineForPath,
  parseErrorDetails
} from './json-schema-validator.js';

test('checkTypes verifies JSON Schema primitive types and union type arrays', () => {
  const validator = new FitnessCrossfitProSchemaValidator();

  assert.equal(validator.checkTypes('string', 'WOD-2026'), true);
  assert.equal(validator.checkTypes('number', 64.5), true);
  assert.equal(validator.checkTypes('number', Number.POSITIVE_INFINITY), false);
  assert.equal(validator.checkTypes('number', Number.NaN), false);
  assert.equal(validator.checkTypes('integer', 42), true);
  assert.equal(validator.checkTypes('integer', 42.5), false);
  assert.equal(validator.checkTypes('boolean', false), true);
  assert.equal(validator.checkTypes('array', ['AMRAP', 'EMOM']), true);
  assert.equal(validator.checkTypes('object', { reps: 10 }), true);
  assert.equal(validator.checkTypes('object', null), false);
  assert.equal(validator.checkTypes('object', []), false);
  assert.equal(validator.checkTypes('null', null), true);
  assert.equal(validator.checkTypes('string', 123), false);
  assert.equal(validator.checkTypes(['integer', 'null'], null), true);
  assert.equal(validator.checkTypes(['integer', 'string'], 'rx'), true);
  assert.equal(validator.checkTypes([], 'rx'), false);
  assert.equal(validator.checkTypes('unknown-type', 'rx'), false);
});

test('all valid Fitness Crossfit Pro templates pass their own schemas', () => {
  const validator = new FitnessCrossfitProSchemaValidator();

  for (const key of ['wodSession', 'athleteProfile', 'leaderboardEntry']) {
    const template = SCHEMA_TEMPLATES[key];
    const result = validator.validate(template.schema, template.payload);
    assert.equal(result.valid, true, `${key}: ${validator.formatValidationErrors()}`);
    assert.deepEqual(result.errors, []);
  }
});

test('mismatch demo surfaces nested types, required keys, ranges, enums, uniqueItems, and unexpected properties', () => {
  const validator = new FitnessCrossfitProSchemaValidator();
  const { schema, payload } = SCHEMA_TEMPLATES.mismatch;
  const result = validator.validate(schema, payload);

  assert.equal(result.valid, false);
  const hasViolation = (path, keyword) =>
    result.errors.some((error) => error.path === path && error.keyword === keyword);

  assert.ok(hasViolation('#/sessionId', 'pattern'));
  assert.ok(hasViolation('#/athlete/handle', 'minLength'));
  assert.ok(hasViolation('#/athlete/restingHr', 'minimum'));
  assert.ok(hasViolation('#/athlete/rxCertified', 'type'));
  assert.ok(hasViolation('#/athlete/division', 'required'));
  assert.ok(hasViolation('#/durationSec', 'type'));
  assert.ok(hasViolation('#/caloriesBurned', 'type'));
  assert.ok(hasViolation('#/movements', 'uniqueItems'));
  assert.ok(hasViolation('#/modality', 'enum'));
  assert.ok(hasViolation('#/unauthorizedOverride', 'additionalProperties'));
  assert.equal(result.errors.length, 10);
});

test('validate enforces nested arrays, numeric bounds, multipleOf, and patternProperties', () => {
  const validator = new FitnessCrossfitProSchemaValidator();
  const schema = {
    type: 'object',
    required: ['athlete', 'intervalSec', 'splits'],
    additionalProperties: false,
    properties: {
      athlete: {
        type: 'object',
        required: ['code', 'hrBpm'],
        properties: {
          code: { type: 'string', minLength: 4, pattern: '^CFP-' },
          hrBpm: { type: 'integer', minimum: 40, maximum: 220 }
        }
      },
      intervalSec: { type: 'number', exclusiveMinimum: 0, multipleOf: 0.5 },
      splits: {
        type: 'array',
        minItems: 2,
        uniqueItems: true,
        items: { type: 'integer', minimum: 1 }
      }
    },
    patternProperties: {
      '^zone[1-5]$': { type: 'number', minimum: 0 }
    }
  };

  const badPayload = {
    athlete: { code: 'AB', hrBpm: 185.5 },
    intervalSec: 1.3,
    splits: [45, 45],
    zone3: -2,
    extraField: 'disallowed'
  };

  const result = validator.validate(schema, badPayload);
  assert.equal(result.valid, false);
  assert.deepEqual(
    result.errors.map((err) => `${err.path}:${err.keyword}`),
    [
      '#/athlete/code:minLength',
      '#/athlete/code:pattern',
      '#/athlete/hrBpm:type',
      '#/intervalSec:multipleOf',
      '#/splits:uniqueItems',
      '#/zone3:minimum',
      '#/extraField:additionalProperties'
    ]
  );
});

test('formatValidationErrors reports pass/fail state cleanly and resets between validate calls', () => {
  const validator = new FitnessCrossfitProSchemaValidator();
  const schema = {
    type: 'object',
    required: ['wod'],
    properties: {
      wod: { type: 'string', minLength: 3 }
    }
  };

  assert.equal(validator.formatValidationErrors(), 'Validation passed: no schema violations (0 errors).');

  const failed = validator.validate(schema, { wod: 'A' });
  assert.equal(failed.valid, false);
  assert.equal(
    validator.formatValidationErrors(),
    '1. #/wod [minLength] - String length 1 is below minLength 3.'
  );

  const passed = validator.validate(schema, { wod: 'Murph' });
  assert.equal(passed.valid, true);
  assert.equal(validator.formatValidationErrors(), 'Validation passed: no schema violations (0 errors).');
});

test('supports local $defs/$ref, tuple items, and allOf/anyOf/oneOf/not combinators', () => {
  const validator = new FitnessCrossfitProSchemaValidator();
  const schema = {
    $defs: {
      repCount: { type: 'integer', minimum: 1 }
    },
    type: 'object',
    required: ['reps', 'pair', 'score'],
    properties: {
      reps: { $ref: '#/$defs/repCount' },
      pair: {
        type: 'array',
        prefixItems: [{ type: 'string' }, { type: 'integer', minimum: 1 }],
        items: false
      },
      score: {
        allOf: [{ type: 'number' }, { minimum: 10 }],
        not: { const: 13 }
      }
    }
  };

  assert.equal(
    validator.validate(schema, { reps: 21, pair: ['Thruster', 21], score: 15 }).valid,
    true
  );

  const invalid = validator.validate(schema, { reps: 0, pair: ['Thruster', 21, 'extra'], score: 13 });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some((e) => e.path === '#/reps' && e.keyword === 'minimum'));
  assert.ok(invalid.errors.some((e) => e.path === '#/pair/2' && e.keyword === 'items'));
  assert.ok(invalid.errors.some((e) => e.path === '#/score' && e.keyword === 'not'));

  const oneOfSchema = { oneOf: [{ type: 'number' }, { type: 'integer' }] };
  assert.equal(validator.validate(oneOfSchema, 3.5).valid, true);
  assert.equal(validator.validate(oneOfSchema, 3).valid, false);
  assert.equal(validator.validate(oneOfSchema, 'rx').valid, false);
});

test('invalid root schemas and circular $ref fail gracefully without throwing', () => {
  const validator = new FitnessCrossfitProSchemaValidator();

  for (const badSchema of [null, undefined, false, 42, 'schema', []]) {
    const res = validator.validate(badSchema, {});
    assert.equal(res.valid, false);
    assert.equal(res.errors[0].path, '#');
    assert.equal(res.errors[0].keyword, 'schema');
  }

  const circularSchema = {
    $defs: { node: { $ref: '#/$defs/node' } },
    $ref: '#/$defs/node'
  };
  const circRes = validator.validate(circularSchema, {});
  assert.equal(circRes.valid, false);
  assert.ok(circRes.errors.some((e) => e.keyword === '$ref'));
});

test('indexJsonLines, lineForPath, and parseErrorDetails map multiline payloads and syntax offsets', () => {
  const source = JSON.stringify(
    {
      sessionId: 'WOD-2026-08',
      workout: { name: 'Fran', rx: true },
      movements: ['Thruster', 'Pull-Up'],
      'zone/4': 12
    },
    null,
    2
  );

  const lineIndex = indexJsonLines(source);
  assert.equal(lineIndex.get('#'), 1);
  assert.equal(lineIndex.get('#/sessionId'), 2);
  assert.equal(lineIndex.get('#/workout'), 3);
  assert.equal(lineIndex.get('#/workout/name'), 4);
  assert.equal(lineIndex.get('#/workout/rx'), 5);
  assert.equal(lineIndex.get('#/movements'), 7);
  assert.equal(lineIndex.get('#/movements/0'), 8);
  assert.equal(lineIndex.get('#/movements/1'), 9);
  assert.equal(lineIndex.get('#/zone~14'), 11);

  assert.equal(lineForPath('#/workout/missing', lineIndex), 3);
  assert.equal(lineForPath('#/movements/9/missing', lineIndex), 7);
  assert.equal(lineForPath('#', lineIndex), 1);

  const cases = [
    { src: '{\n  "a": 1,\n  "b": \n}', expectedLine: 4 },
    { src: '{\n  "a": 1,\n  "b": 2,\n}', expectedLine: 4 },
    { src: '{\n  a: 1\n}', expectedLine: 2 },
    { src: '', expectedLine: 1 }
  ];

  for (const { src, expectedLine } of cases) {
    let thrown;
    try {
      JSON.parse(src);
    } catch (err) {
      thrown = err;
    }
    const details = parseErrorDetails(thrown, src);
    assert.equal(details.line, expectedLine, `Failed line detection for: ${JSON.stringify(src)}`);
    assert.ok(details.column >= 1);
  }
});
