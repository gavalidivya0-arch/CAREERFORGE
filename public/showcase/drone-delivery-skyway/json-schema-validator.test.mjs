import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DroneDeliverySkywaySchemaValidator,
  SCHEMA_TEMPLATES,
  indexJsonLines,
  lineForPath,
  parseErrorDetails
} from './json-schema-validator.js';

test('checkTypes verifies all JSON Schema primitives and union arrays', () => {
  const validator = new DroneDeliverySkywaySchemaValidator();

  assert.equal(validator.checkTypes('string', 'SKY-4092-NW'), true);
  assert.equal(validator.checkTypes('number', 11.5), true);
  assert.equal(validator.checkTypes('number', Number.NaN), false);
  assert.equal(validator.checkTypes('number', Number.POSITIVE_INFINITY), false);
  assert.equal(validator.checkTypes('integer', 85), true);
  assert.equal(validator.checkTypes('integer', 85.5), false);
  assert.equal(validator.checkTypes('boolean', true), true);
  assert.equal(validator.checkTypes('array', [1, 2]), true);
  assert.equal(validator.checkTypes('object', { sector: 'METRO-HUB' }), true);
  assert.equal(validator.checkTypes('object', null), false);
  assert.equal(validator.checkTypes('object', []), false);
  assert.equal(validator.checkTypes('null', null), true);
  assert.equal(validator.checkTypes(['string', 'null'], null), true);
  assert.equal(validator.checkTypes(['string', 'null'], 'TWR-SF09'), true);
  assert.equal(validator.checkTypes(['integer', 'boolean'], 'yes'), false);
  assert.equal(validator.checkTypes([], 'anything'), false);
  assert.equal(validator.checkTypes('unknown', 'anything'), false);
});

test('all valid Drone Delivery Skyway templates pass their schemas', () => {
  const validator = new DroneDeliverySkywaySchemaValidator();

  for (const key of ['flightDispatch', 'airTelemetry', 'weatherClearance']) {
    const template = SCHEMA_TEMPLATES[key];
    const result = validator.validate(template.schema, template.payload);
    assert.equal(result.valid, true, `${key}: ${validator.formatValidationErrors()}`);
    assert.deepEqual(result.errors, []);
  }
});

test('mismatch demo reports nested types, required keys, constraints, and unexpected properties', () => {
  const validator = new DroneDeliverySkywaySchemaValidator();
  const template = SCHEMA_TEMPLATES.mismatch;
  const result = validator.validate(template.schema, template.payload);

  assert.equal(result.valid, false);
  const has = (path, keyword) => result.errors.some((e) => e.path === path && e.keyword === keyword);

  assert.ok(has('#/flightId', 'pattern'));
  assert.ok(has('#/drone/unitId', 'minLength'));
  assert.ok(has('#/drone/unitId', 'pattern'));
  assert.ok(has('#/drone/batteryPct', 'minimum'));
  assert.ok(has('#/corridor/geofenceCleared', 'required'));
  assert.ok(has('#/corridor/sector', 'enum'));
  assert.ok(has('#/corridor/altitudeMeters', 'type'));
  assert.ok(has('#/alerts', 'uniqueItems'));
  assert.ok(has('#/maxPayloadKg', 'type'));
  assert.ok(has('#/manualOverride', 'additionalProperties'));
  assert.equal(result.errors.length, 10);
});

test('enforces numeric bounds, multipleOf, string code-point lengths, formats, and patternProperties', () => {
  const validator = new DroneDeliverySkywaySchemaValidator();
  const schema = {
    type: 'object',
    minProperties: 2,
    maxProperties: 6,
    required: ['callsign', 'dispatchDate', 'issuedAt', 'windKnots', 'weightKg'],
    additionalProperties: false,
    properties: {
      callsign: { type: 'string', minLength: 2, maxLength: 6 },
      dispatchDate: { type: 'string', format: 'date' },
      issuedAt: { type: 'string', format: 'date-time' },
      windKnots: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 30, multipleOf: 0.5 },
      weightKg: { type: 'number', minimum: 0.1, maximum: 5.0 },
      telemetryUrl: { type: 'string', format: 'uri' }
    },
    patternProperties: {
      '^sensor_': { type: 'integer', minimum: 0 }
    }
  };

  const valid = {
    callsign: '🚁9',
    dispatchDate: '2026-02-28',
    issuedAt: '2026-11-28T18:10:00Z',
    windKnots: 12.5,
    weightKg: 3.2,
    sensor_alt: 80
  };
  assert.equal(validator.validate(schema, valid).valid, true);

  const invalid = {
    callsign: 'A',
    dispatchDate: '2026-02-30',
    issuedAt: '2026-11-28T25:00:00Z',
    windKnots: 0,
    weightKg: 5.1,
    telemetryUrl: 'not-a-valid-uri',
    sensor_alt: -1
  };
  const res = validator.validate(schema, invalid);
  assert.equal(res.valid, false);
  const keys = res.errors.map((e) => `${e.path}:${e.keyword}`);
  assert.deepEqual(keys, [
    '#:maxProperties',
    '#/callsign:minLength',
    '#/dispatchDate:format',
    '#/issuedAt:format',
    '#/windKnots:exclusiveMinimum',
    '#/weightKg:maximum',
    '#/telemetryUrl:format',
    '#/sensor_alt:minimum'
  ]);
});

test('handles falsy const/enum values, prefixItems, tuple items, and combinators', () => {
  const validator = new DroneDeliverySkywaySchemaValidator();
  const schema = {
    $defs: {
      altitude: { type: 'integer', minimum: 30, maximum: 120 }
    },
    type: 'object',
    required: ['zeroConst', 'boolFalse', 'coords', 'priority'],
    properties: {
      zeroConst: { const: 0 },
      boolFalse: { enum: [false, null] },
      coords: {
        type: 'array',
        prefixItems: [{ type: 'number' }, { type: 'number' }, { $ref: '#/$defs/altitude' }],
        items: false
      },
      priority: {
        allOf: [{ type: 'integer' }, { minimum: 1 }],
        not: { const: 13 }
      }
    }
  };

  assert.equal(
    validator.validate(schema, {
      zeroConst: 0,
      boolFalse: false,
      coords: [37.77, -122.41, 80],
      priority: 2
    }).valid,
    true
  );

  const bad = validator.validate(schema, {
    zeroConst: 1,
    boolFalse: true,
    coords: [37.77, -122.41, 20, 'extra'],
    priority: 13
  });
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.some((e) => e.path === '#/zeroConst' && e.keyword === 'const'));
  assert.ok(bad.errors.some((e) => e.path === '#/boolFalse' && e.keyword === 'enum'));
  assert.ok(bad.errors.some((e) => e.path === '#/coords/2' && e.keyword === 'minimum'));
  assert.ok(bad.errors.some((e) => e.path === '#/coords/3' && e.keyword === 'items'));
  assert.ok(bad.errors.some((e) => e.path === '#/priority' && e.keyword === 'not'));

  const oneOfSchema = { oneOf: [{ type: 'number' }, { type: 'integer' }] };
  assert.equal(validator.validate(oneOfSchema, 3.5).valid, true);
  assert.equal(validator.validate(oneOfSchema, 3).valid, false);
});

test('formatValidationErrors resets between runs and validate returns defensive copies', () => {
  const validator = new DroneDeliverySkywaySchemaValidator();
  const schema = {
    type: 'object',
    required: ['flightId'],
    properties: {
      flightId: { type: 'string', minLength: 4 }
    }
  };

  assert.equal(validator.formatValidationErrors(), 'Validation passed: no schema violations (0 errors).');

  const failed = validator.validate(schema, { flightId: 'S1' });
  assert.equal(failed.valid, false);
  failed.errors[0].message = 'mutated';
  assert.equal(
    validator.formatValidationErrors(),
    '1. #/flightId [minLength] - String length 2 is below minLength 4.'
  );

  const passed = validator.validate(schema, { flightId: 'SKY-4092' });
  assert.equal(passed.valid, true);
  assert.equal(validator.formatValidationErrors(), 'Validation passed: no schema violations (0 errors).');
});

test('invalid schemas, invalid patterns, and circular $ref fail gracefully', () => {
  const validator = new DroneDeliverySkywaySchemaValidator();

  for (const badSchema of [null, undefined, false, 42, 'schema', []]) {
    const res = validator.validate(badSchema, {});
    assert.equal(res.valid, false);
    assert.equal(res.errors[0].path, '#');
    assert.equal(res.errors[0].keyword, 'schema');
  }

  const badPattern = validator.validate({ type: 'string', pattern: '[unclosed' }, 'SKY');
  assert.equal(badPattern.valid, false);
  assert.equal(badPattern.errors[0].keyword, 'pattern');

  const circularSchema = {
    $defs: { node: { $ref: '#/$defs/node' } },
    $ref: '#/$defs/node'
  };
  const circRes = validator.validate(circularSchema, {});
  assert.equal(circRes.valid, false);
  assert.ok(circRes.errors.some((e) => e.keyword === '$ref'));
});

test('indexJsonLines, lineForPath, and parseErrorDetails resolve line numbers accurately', () => {
  const source = JSON.stringify(
    {
      flightId: 'SKY-4092-NW',
      corridor: { sector: 'METRO-HUB', altitudeMeters: 85 },
      alerts: ['WIND_OK', 'CLEAR'],
      'zone/alpha': true
    },
    null,
    2
  );

  const lines = indexJsonLines(source);
  assert.equal(lines.get('#'), 1);
  assert.equal(lines.get('#/flightId'), 2);
  assert.equal(lines.get('#/corridor'), 3);
  assert.equal(lines.get('#/corridor/sector'), 4);
  assert.equal(lines.get('#/corridor/altitudeMeters'), 5);
  assert.equal(lines.get('#/alerts'), 7);
  assert.equal(lines.get('#/alerts/0'), 8);
  assert.equal(lines.get('#/alerts/1'), 9);
  assert.equal(lines.get('#/zone~1alpha'), 11);

  assert.equal(lineForPath('#/corridor/missing', lines), 3);
  assert.equal(lineForPath('#/alerts/9/missing', lines), 7);
  assert.equal(lineForPath('#', lines), 1);

  const syntaxCases = [
    { src: '{\n  "a": 1,\n  "b": \n}', expectedLine: 4 },
    { src: '{\n  "a": 1,\n  "b": 2,\n}', expectedLine: 4 },
    { src: '{\n  a: 1\n}', expectedLine: 2 },
    { src: '', expectedLine: 1 }
  ];

  for (const { src, expectedLine } of syntaxCases) {
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
