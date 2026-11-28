/**
 * Drone Delivery Skyway (SKYWAY-EXPRESS) — JSON Payload Schema Validator & Lint Inspector
 *
 * Pure client-side JSON Schema validator and structural linter with nested
 * object/array traversal, type & constraint enforcement, JSON Pointer error
 * reporting, and source line indexing. Core engine has zero DOM or network
 * dependencies so it runs directly in Node tests and the browser.
 */

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function escapePointerSegment(segment) {
  return String(segment).replaceAll('~', '~0').replaceAll('/', '~1');
}

function unescapePointerSegment(segment) {
  return String(segment).replaceAll('~1', '/').replaceAll('~0', '~');
}

function actualType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'non-finite number';
    return Number.isInteger(value) ? 'integer' : 'number';
  }
  return typeof value;
}

function formatExpectedType(type) {
  if (Array.isArray(type)) {
    return type.map((entry) => `"${entry}"`).join(' or ');
  }
  return `"${type}"`;
}

function jsonEqual(left, right) {
  if (left === right) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((item, index) => jsonEqual(item, right[index]));
  }
  if (typeof left === 'object') {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => hasOwn(right, key) && jsonEqual(left[key], right[key]));
  }
  return false;
}

function compilePattern(pattern) {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

function resolveLocalRef(ref, rootSchema) {
  if (ref === '#') return rootSchema;
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return undefined;
  const parts = ref.slice(2).split('/').map(unescapePointerSegment);
  let cursor = rootSchema;
  for (const part of parts) {
    if (!cursor || typeof cursor !== 'object' || !hasOwn(cursor, part)) {
      return undefined;
    }
    cursor = cursor[part];
  }
  return cursor;
}

function pushError(errors, path, keyword, message) {
  errors.push({ path, keyword, message });
}

function isValidCalendarDate(yearStr, monthStr, dayStr) {
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

const FORMAT_VALIDATORS = {
  date(value) {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return false;
    return isValidCalendarDate(match[1], match[2], match[3]);
  },
  'date-time'(value) {
    const match = value.match(
      /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/
    );
    if (!match) return false;
    if (!isValidCalendarDate(match[1], match[2], match[3])) return false;
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);
    if (hour > 23 || minute > 59 || second > 60) return false;
    if (match[8] !== undefined) {
      const offsetHour = Number(match[8]);
      const offsetMinute = Number(match[9]);
      if (offsetHour > 23 || offsetMinute > 59) return false;
    }
    return true;
  },
  email(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  },
  uuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  },
  uri(value) {
    try {
      const parsed = new URL(value);
      return Boolean(parsed.protocol);
    } catch {
      return false;
    }
  }
};

export class DroneDeliverySkywaySchemaValidator {
  #lastErrors = [];

  /**
   * Verifies whether `actual` matches `expected` JSON Schema type (or type union array).
   */
  checkTypes(expected, actual) {
    if (Array.isArray(expected)) {
      return expected.length > 0 && expected.some((type) => this.checkTypes(type, actual));
    }

    switch (expected) {
      case 'null':
        return actual === null;
      case 'array':
        return Array.isArray(actual);
      case 'object':
        return isPlainObject(actual);
      case 'integer':
        return typeof actual === 'number' && Number.isInteger(actual);
      case 'number':
        return typeof actual === 'number' && Number.isFinite(actual);
      case 'boolean':
        return typeof actual === 'boolean';
      case 'string':
        return typeof actual === 'string';
      default:
        return false;
    }
  }

  /**
   * Validates `payload` against `schema`, collecting structured diagnostics.
   * Returns `{ valid: boolean, errors: Array<{ path: string, keyword: string, message: string }> }`.
   */
  validate(schema, payload) {
    this.#lastErrors = [];

    if (!isPlainObject(schema)) {
      pushError(this.#lastErrors, '#', 'schema', 'Root schema must be a JSON object.');
      return this.#buildResult();
    }

    const activeRefs = new Set();
    this.#validateNode(schema, payload, '#', this.#lastErrors, schema, activeRefs);
    return this.#buildResult();
  }

  /**
   * Formats the latest validation errors into a numbered plain-text diagnostic report.
   */
  formatValidationErrors() {
    if (this.#lastErrors.length === 0) {
      return 'Validation passed: no schema violations (0 errors).';
    }

    return this.#lastErrors
      .map((error, index) => `${index + 1}. ${error.path} [${error.keyword}] - ${error.message}`)
      .join('\n');
  }

  #buildResult() {
    return {
      valid: this.#lastErrors.length === 0,
      errors: this.#lastErrors.map((error) => ({ ...error }))
    };
  }

  #validateNode(schema, value, path, errors, rootSchema, activeRefs) {
    if (schema === true) return;
    if (schema === false) {
      pushError(errors, path, 'schema', 'Schema "false" rejects every value.');
      return;
    }
    if (!isPlainObject(schema)) {
      pushError(errors, path, 'schema', 'Schema node must be an object or boolean.');
      return;
    }

    if (typeof schema.$ref === 'string') {
      const refKey = `${path}::${schema.$ref}`;
      if (activeRefs.has(refKey)) {
        pushError(errors, path, '$ref', `Circular schema reference detected for ${JSON.stringify(schema.$ref)}.`);
        return;
      }
      const target = resolveLocalRef(schema.$ref, rootSchema);
      if (target === undefined) {
        pushError(errors, path, '$ref', `Unable to resolve schema reference ${JSON.stringify(schema.$ref)}.`);
        return;
      }
      activeRefs.add(refKey);
      this.#validateNode(target, value, path, errors, rootSchema, activeRefs);
      activeRefs.delete(refKey);
    }

    if (hasOwn(schema, 'type') && !this.checkTypes(schema.type, value)) {
      pushError(
        errors,
        path,
        'type',
        `Expected ${formatExpectedType(schema.type)} but received ${actualType(value)}.`
      );
      return;
    }

    if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => jsonEqual(candidate, value))) {
      pushError(
        errors,
        path,
        'enum',
        `Value must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(', ')}.`
      );
    }

    if (hasOwn(schema, 'const') && !jsonEqual(schema.const, value)) {
      pushError(errors, path, 'const', `Value must equal ${JSON.stringify(schema.const)}.`);
    }

    this.#validateNumeric(schema, value, path, errors);
    this.#validateString(schema, value, path, errors);
    this.#validateArray(schema, value, path, errors, rootSchema, activeRefs);
    this.#validateObject(schema, value, path, errors, rootSchema, activeRefs);
    this.#validateCombinators(schema, value, path, errors, rootSchema, activeRefs);
  }

  #validateNumeric(schema, value, path, errors) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;

    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      pushError(errors, path, 'minimum', `Value ${value} is below the minimum of ${schema.minimum}.`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      pushError(errors, path, 'maximum', `Value ${value} exceeds the maximum of ${schema.maximum}.`);
    }
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
      pushError(
        errors,
        path,
        'exclusiveMinimum',
        `Value ${value} must be strictly greater than ${schema.exclusiveMinimum}.`
      );
    }
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) {
      pushError(
        errors,
        path,
        'exclusiveMaximum',
        `Value ${value} must be strictly less than ${schema.exclusiveMaximum}.`
      );
    }
    if (typeof schema.multipleOf === 'number' && Number.isFinite(schema.multipleOf) && schema.multipleOf > 0) {
      const quotient = value / schema.multipleOf;
      const tolerance = Math.max(1e-9, Math.abs(quotient) * 1e-12);
      if (!Number.isFinite(quotient) || Math.abs(quotient - Math.round(quotient)) > tolerance) {
        pushError(errors, path, 'multipleOf', `Value ${value} is not a multiple of ${schema.multipleOf}.`);
      }
    }
  }

  #validateString(schema, value, path, errors) {
    if (typeof value !== 'string') return;

    const length = [...value].length;
    if (typeof schema.minLength === 'number' && length < schema.minLength) {
      pushError(errors, path, 'minLength', `String length ${length} is below minLength ${schema.minLength}.`);
    }
    if (typeof schema.maxLength === 'number' && length > schema.maxLength) {
      pushError(errors, path, 'maxLength', `String length ${length} exceeds maxLength ${schema.maxLength}.`);
    }
    if (typeof schema.pattern === 'string') {
      const regex = compilePattern(schema.pattern);
      if (!regex) {
        pushError(
          errors,
          path,
          'pattern',
          `Schema pattern ${JSON.stringify(schema.pattern)} is not a valid regular expression.`
        );
      } else if (!regex.test(value)) {
        pushError(errors, path, 'pattern', `String does not match pattern ${JSON.stringify(schema.pattern)}.`);
      }
    }
    if (typeof schema.format === 'string' && hasOwn(FORMAT_VALIDATORS, schema.format)) {
      if (!FORMAT_VALIDATORS[schema.format](value)) {
        pushError(errors, path, 'format', `String does not match ${JSON.stringify(schema.format)} format.`);
      }
    }
  }

  #validateArray(schema, value, path, errors, rootSchema, activeRefs) {
    if (!Array.isArray(value)) return;

    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      pushError(errors, path, 'minItems', `Array has ${value.length} item(s); minItems is ${schema.minItems}.`);
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      pushError(errors, path, 'maxItems', `Array has ${value.length} item(s); maxItems is ${schema.maxItems}.`);
    }
    if (schema.uniqueItems === true) {
      let duplicateFound = false;
      for (let right = 1; right < value.length && !duplicateFound; right += 1) {
        for (let left = 0; left < right; left += 1) {
          if (jsonEqual(value[left], value[right])) {
            pushError(errors, path, 'uniqueItems', `Array items at indexes ${left} and ${right} are duplicates.`);
            duplicateFound = true;
            break;
          }
        }
      }
    }

    if (Array.isArray(schema.prefixItems)) {
      value.forEach((item, index) => {
        if (index < schema.prefixItems.length) {
          this.#validateNode(schema.prefixItems[index], item, `${path}/${index}`, errors, rootSchema, activeRefs);
        } else if (schema.items === false) {
          pushError(errors, `${path}/${index}`, 'items', 'Additional array item beyond prefixItems is not allowed.');
        } else if (schema.items !== undefined) {
          this.#validateNode(schema.items, item, `${path}/${index}`, errors, rootSchema, activeRefs);
        }
      });
      return;
    }

    if (schema.items !== undefined) {
      if (Array.isArray(schema.items)) {
        value.forEach((item, index) => {
          if (index < schema.items.length) {
            this.#validateNode(schema.items[index], item, `${path}/${index}`, errors, rootSchema, activeRefs);
          } else if (schema.additionalItems === false) {
            pushError(errors, `${path}/${index}`, 'additionalItems', 'Additional array item is not allowed.');
          } else if (schema.additionalItems !== undefined) {
            this.#validateNode(schema.additionalItems, item, `${path}/${index}`, errors, rootSchema, activeRefs);
          }
        });
      } else {
        value.forEach((item, index) => {
          this.#validateNode(schema.items, item, `${path}/${index}`, errors, rootSchema, activeRefs);
        });
      }
    }
  }

  #validateObject(schema, value, path, errors, rootSchema, activeRefs) {
    if (!isPlainObject(value)) return;

    const keys = Object.keys(value);
    if (typeof schema.minProperties === 'number' && keys.length < schema.minProperties) {
      pushError(
        errors,
        path,
        'minProperties',
        `Object has ${keys.length} propert(ies); minProperties is ${schema.minProperties}.`
      );
    }
    if (typeof schema.maxProperties === 'number' && keys.length > schema.maxProperties) {
      pushError(
        errors,
        path,
        'maxProperties',
        `Object has ${keys.length} propert(ies); maxProperties is ${schema.maxProperties}.`
      );
    }

    if (Array.isArray(schema.required)) {
      for (const reqKey of schema.required) {
        if (typeof reqKey === 'string' && !hasOwn(value, reqKey)) {
          pushError(
            errors,
            `${path}/${escapePointerSegment(reqKey)}`,
            'required',
            `Missing required property ${JSON.stringify(reqKey)}.`
          );
        }
      }
    }

    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    for (const [propKey, childSchema] of Object.entries(properties)) {
      if (hasOwn(value, propKey)) {
        this.#validateNode(
          childSchema,
          value[propKey],
          `${path}/${escapePointerSegment(propKey)}`,
          errors,
          rootSchema,
          activeRefs
        );
      }
    }

    const patternMatchedKeys = new Set();
    if (isPlainObject(schema.patternProperties)) {
      for (const [pattern, childSchema] of Object.entries(schema.patternProperties)) {
        const regex = compilePattern(pattern);
        if (!regex) {
          pushError(
            errors,
            path,
            'patternProperties',
            `Schema patternProperties key ${JSON.stringify(pattern)} is not a valid regular expression.`
          );
          continue;
        }
        for (const key of keys) {
          if (regex.test(key)) {
            patternMatchedKeys.add(key);
            this.#validateNode(
              childSchema,
              value[key],
              `${path}/${escapePointerSegment(key)}`,
              errors,
              rootSchema,
              activeRefs
            );
          }
        }
      }
    }

    if (schema.additionalProperties !== undefined) {
      const extras = keys.filter((key) => !hasOwn(properties, key) && !patternMatchedKeys.has(key));
      if (schema.additionalProperties === false) {
        for (const key of extras) {
          pushError(
            errors,
            `${path}/${escapePointerSegment(key)}`,
            'additionalProperties',
            `Unexpected property ${JSON.stringify(key)} is not allowed by this schema.`
          );
        }
      } else if (schema.additionalProperties !== true) {
        for (const key of extras) {
          this.#validateNode(
            schema.additionalProperties,
            value[key],
            `${path}/${escapePointerSegment(key)}`,
            errors,
            rootSchema,
            activeRefs
          );
        }
      }
    }
  }

  #validateCombinators(schema, value, path, errors, rootSchema, activeRefs) {
    if (Array.isArray(schema.allOf)) {
      for (const childSchema of schema.allOf) {
        this.#validateNode(childSchema, value, path, errors, rootSchema, activeRefs);
      }
    }

    if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
      const passed = schema.anyOf.some((childSchema) => {
        const branchErrors = [];
        this.#validateNode(childSchema, value, path, branchErrors, rootSchema, activeRefs);
        return branchErrors.length === 0;
      });
      if (!passed) {
        pushError(errors, path, 'anyOf', 'Value does not match any schema in "anyOf".');
      }
    }

    if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
      let matches = 0;
      for (const childSchema of schema.oneOf) {
        const branchErrors = [];
        this.#validateNode(childSchema, value, path, branchErrors, rootSchema, activeRefs);
        if (branchErrors.length === 0) matches += 1;
      }
      if (matches === 0) {
        pushError(errors, path, 'oneOf', 'Value does not match any schema in "oneOf".');
      } else if (matches > 1) {
        pushError(errors, path, 'oneOf', `Value matches ${matches} schemas in "oneOf"; exactly one is required.`);
      }
    }

    if (schema.not !== undefined) {
      const branchErrors = [];
      this.#validateNode(schema.not, value, path, branchErrors, rootSchema, activeRefs);
      if (branchErrors.length === 0) {
        pushError(errors, path, 'not', 'Value must not match the schema in "not".');
      }
    }
  }
}

/**
 * Curated Drone Delivery Skyway (SKYWAY-EXPRESS) JSON Schema & payload presets.
 */
export const SCHEMA_TEMPLATES = {
  flightDispatch: {
    label: 'Flight Dispatch Clearance · Valid',
    schema: {
      type: 'object',
      required: ['flightId', 'drone', 'corridor', 'cargo', 'waypoints'],
      additionalProperties: false,
      properties: {
        flightId: { type: 'string', pattern: '^SKY-\\d{4}-[A-Z]{2}$' },
        drone: {
          type: 'object',
          required: ['unitId', 'airframe', 'batteryPct', 'maxPayloadKg'],
          additionalProperties: false,
          properties: {
            unitId: { type: 'string', pattern: '^DRN-\\d{3}$' },
            airframe: { type: 'string', enum: ['QuadRotor-M4', 'HexaCargo-H6', 'VTOL-Glide-V2'] },
            batteryPct: { type: 'integer', minimum: 20, maximum: 100 },
            maxPayloadKg: { type: 'number', minimum: 0.5, maximum: 25 }
          }
        },
        corridor: {
          type: 'object',
          required: ['sector', 'altitudeMeters', 'windKnots', 'geofenceCleared'],
          additionalProperties: false,
          properties: {
            sector: {
              type: 'string',
              enum: ['NORTH-CORRIDOR', 'BAY-BRIDGE', 'METRO-HUB', 'PORT-EXPRESS']
            },
            altitudeMeters: { type: 'integer', minimum: 45, maximum: 120 },
            windKnots: { type: 'number', minimum: 0, maximum: 25, multipleOf: 0.5 },
            geofenceCleared: { type: 'boolean', const: true }
          }
        },
        cargo: {
          type: 'object',
          required: ['manifestId', 'weightKg', 'priority', 'fragile'],
          additionalProperties: false,
          properties: {
            manifestId: { type: 'string', minLength: 5, maxLength: 32 },
            weightKg: { type: 'number', exclusiveMinimum: 0, maximum: 5 },
            priority: { type: 'string', enum: ['standard', 'medical', 'priority-air'] },
            fragile: { type: 'boolean' }
          }
        },
        waypoints: {
          type: 'array',
          minItems: 2,
          maxItems: 12,
          items: {
            type: 'object',
            required: ['lat', 'lon', 'altM'],
            additionalProperties: false,
            properties: {
              lat: { type: 'number', minimum: -90, maximum: 90 },
              lon: { type: 'number', minimum: -180, maximum: 180 },
              altM: { type: 'integer', minimum: 30, maximum: 120 }
            }
          }
        }
      }
    },
    payload: {
      flightId: 'SKY-4092-NW',
      drone: {
        unitId: 'DRN-108',
        airframe: 'HexaCargo-H6',
        batteryPct: 94,
        maxPayloadKg: 5.0
      },
      corridor: {
        sector: 'METRO-HUB',
        altitudeMeters: 85,
        windKnots: 11.5,
        geofenceCleared: true
      },
      cargo: {
        manifestId: 'MNF-2026-8841',
        weightKg: 2.35,
        priority: 'medical',
        fragile: true
      },
      waypoints: [
        { lat: 37.7749, lon: -122.4194, altM: 60 },
        { lat: 37.7897, lon: -122.4014, altM: 85 },
        { lat: 37.8044, lon: -122.2712, altM: 70 }
      ]
    }
  },
  airTelemetry: {
    label: 'Air Corridor Telemetry · Valid',
    schema: {
      $defs: {
        attitudeAxis: { type: 'number', minimum: -45, maximum: 45 }
      },
      type: 'object',
      required: ['packetId', 'timestamp', 'unitId', 'attitude', 'battery', 'linkStatus'],
      additionalProperties: false,
      properties: {
        packetId: { type: 'string', format: 'uuid' },
        timestamp: { type: 'string', format: 'date-time' },
        unitId: { type: 'string', pattern: '^DRN-\\d{3}$' },
        attitude: {
          type: 'object',
          required: ['pitchDeg', 'rollDeg', 'yawDeg'],
          additionalProperties: false,
          properties: {
            pitchDeg: { $ref: '#/$defs/attitudeAxis' },
            rollDeg: { $ref: '#/$defs/attitudeAxis' },
            yawDeg: { type: 'number', minimum: 0, exclusiveMaximum: 360 }
          }
        },
        battery: {
          type: 'object',
          required: ['voltageV', 'tempC', 'remainingPct'],
          additionalProperties: false,
          properties: {
            voltageV: { type: 'number', minimum: 18, maximum: 54 },
            tempC: { type: 'number', minimum: -20, maximum: 65 },
            remainingPct: { type: 'integer', minimum: 0, maximum: 100 }
          }
        },
        linkStatus: {
          type: 'object',
          required: ['rssiDbm', 'handoverTower', 'encrypted'],
          additionalProperties: false,
          properties: {
            rssiDbm: { type: 'integer', minimum: -115, maximum: -20 },
            handoverTower: { type: ['string', 'null'], pattern: '^TWR-[A-Z0-9]{4}$' },
            encrypted: { type: 'boolean', const: true }
          }
        }
      }
    },
    payload: {
      packetId: '550e8400-e29b-41d4-a716-446655440219',
      timestamp: '2026-11-28T18:10:00Z',
      unitId: 'DRN-214',
      attitude: {
        pitchDeg: 4.2,
        rollDeg: -1.8,
        yawDeg: 142.5
      },
      battery: {
        voltageV: 46.8,
        tempC: 31.4,
        remainingPct: 78
      },
      linkStatus: {
        rssiDbm: -64,
        handoverTower: 'TWR-SF09',
        encrypted: true
      }
    }
  },
  weatherClearance: {
    label: 'Weather & Geofence Gate · Valid',
    schema: {
      type: 'object',
      required: ['stationCode', 'issuedDate', 'conditions', 'airspace', 'approvals'],
      additionalProperties: false,
      properties: {
        stationCode: { type: 'string', pattern: '^MET-[A-Z]{3}$' },
        issuedDate: { type: 'string', format: 'date' },
        conditions: {
          type: 'object',
          required: ['windSpeedKnots', 'gustKnots', 'visibilityKm', 'precipitation'],
          additionalProperties: false,
          properties: {
            windSpeedKnots: { type: 'number', minimum: 0, maximum: 25 },
            gustKnots: { type: 'number', minimum: 0, maximum: 32 },
            visibilityKm: { type: 'number', minimum: 1.5, maximum: 50 },
            precipitation: { type: 'string', enum: ['none', 'mist', 'light-rain', 'squall'] }
          }
        },
        airspace: {
          type: 'object',
          required: ['corridorId', 'notamActive', 'ceilingMeters', 'cleared'],
          additionalProperties: false,
          properties: {
            corridorId: { type: 'string', pattern: '^AIR-[0-9]{2}[A-Z]$' },
            notamActive: { type: 'boolean' },
            ceilingMeters: { type: 'integer', minimum: 60, maximum: 150 },
            cleared: { type: 'boolean' }
          }
        },
        approvals: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          uniqueItems: true,
          items: { type: 'string', minLength: 3 }
        }
      }
    },
    payload: {
      stationCode: 'MET-SFO',
      issuedDate: '2026-11-28',
      conditions: {
        windSpeedKnots: 9.5,
        gustKnots: 14.0,
        visibilityKm: 16.0,
        precipitation: 'none'
      },
      airspace: {
        corridorId: 'AIR-04B',
        notamActive: false,
        ceilingMeters: 120,
        cleared: true
      },
      approvals: ['ATC-AUTO', 'WEATHER-GATE', 'GEOFENCE-LOCK']
    }
  },
  mismatch: {
    label: 'Faulty Telemetry Packet · Mismatch Demo',
    schema: {
      type: 'object',
      required: ['flightId', 'drone', 'corridor', 'alerts', 'maxPayloadKg'],
      additionalProperties: false,
      properties: {
        flightId: { type: 'string', pattern: '^SKY-\\d{4}-[A-Z]{2}$' },
        drone: {
          type: 'object',
          required: ['unitId', 'batteryPct', 'airframe'],
          additionalProperties: false,
          properties: {
            unitId: { type: 'string', minLength: 5, pattern: '^DRN-\\d{3}$' },
            batteryPct: { type: 'integer', minimum: 20, maximum: 100 },
            airframe: { type: 'string', enum: ['QuadRotor-M4', 'HexaCargo-H6', 'VTOL-Glide-V2'] }
          }
        },
        corridor: {
          type: 'object',
          required: ['sector', 'altitudeMeters', 'geofenceCleared'],
          additionalProperties: false,
          properties: {
            sector: { type: 'string', enum: ['NORTH-CORRIDOR', 'BAY-BRIDGE', 'METRO-HUB'] },
            altitudeMeters: { type: 'integer', minimum: 45, maximum: 120 },
            geofenceCleared: { type: 'boolean' }
          }
        },
        alerts: {
          type: 'array',
          minItems: 2,
          uniqueItems: true,
          items: { type: 'string', minLength: 2 }
        },
        maxPayloadKg: { type: 'number', minimum: 0.5, maximum: 25 }
      }
    },
    payload: {
      flightId: 'SKY-9',
      drone: {
        unitId: 'D1',
        batteryPct: 12,
        airframe: 'HexaCargo-H6'
      },
      corridor: {
        sector: 'RESTRICTED-NOFLY',
        altitudeMeters: 95.5
      },
      alerts: ['LOW_BATT', 'LOW_BATT'],
      maxPayloadKg: '4.5',
      manualOverride: true
    }
  }
};

function findJsonSyntaxPosition(source) {
  let index = 0;
  let line = 1;
  let column = 1;

  const advance = (count = 1) => {
    for (let i = 0; i < count && index < source.length; i += 1) {
      const ch = source[index];
      if (ch === '\r') {
        line += 1;
        column = 1;
        if (source[index + 1] === '\n') index += 1;
      } else if (ch === '\n') {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
      index += 1;
    }
  };

  const skipWhitespace = () => {
    while (
      index < source.length &&
      (source[index] === ' ' || source[index] === '\t' || source[index] === '\n' || source[index] === '\r')
    ) {
      advance();
    }
  };

  const readString = () => {
    const startPos = { line, column };
    advance();
    while (index < source.length) {
      const ch = source[index];
      if (ch === '"') {
        advance();
        return null;
      }
      if (ch === '\\') {
        advance();
        if (index >= source.length) return { line, column };
        const esc = source[index];
        if (esc === 'u') {
          const hex = source.slice(index + 1, index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return { line, column };
          advance(5);
        } else if ('"\\/bfnrt'.includes(esc)) {
          advance();
        } else {
          return { line, column };
        }
        continue;
      }
      if (ch.charCodeAt(0) < 0x20) {
        return { line, column };
      }
      advance();
    }
    return startPos;
  };

  const parseValue = () => {
    skipWhitespace();
    if (index >= source.length) return { line, column };

    const ch = source[index];
    if (ch === '{') {
      advance();
      skipWhitespace();
      if (source[index] === '}') {
        advance();
        return null;
      }
      while (index < source.length) {
        skipWhitespace();
        if (source[index] !== '"') return { line, column };
        const strErr = readString();
        if (strErr) return strErr;
        skipWhitespace();
        if (source[index] !== ':') return { line, column };
        advance();
        const valErr = parseValue();
        if (valErr) return valErr;
        skipWhitespace();
        if (source[index] === ',') {
          advance();
          continue;
        }
        if (source[index] === '}') {
          advance();
          return null;
        }
        return { line, column };
      }
      return { line, column };
    }

    if (ch === '[') {
      advance();
      skipWhitespace();
      if (source[index] === ']') {
        advance();
        return null;
      }
      while (index < source.length) {
        const valErr = parseValue();
        if (valErr) return valErr;
        skipWhitespace();
        if (source[index] === ',') {
          advance();
          continue;
        }
        if (source[index] === ']') {
          advance();
          return null;
        }
        return { line, column };
      }
      return { line, column };
    }

    if (ch === '"') {
      return readString();
    }

    for (const literal of ['true', 'false', 'null']) {
      if (source.startsWith(literal, index)) {
        advance(literal.length);
        return null;
      }
    }

    const numMatch = source.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (numMatch) {
      advance(numMatch[0].length);
      return null;
    }

    return { line, column };
  };

  const err = parseValue();
  if (err) return err;
  skipWhitespace();
  if (index < source.length) return { line, column };
  return { line: 1, column: 1 };
}

/**
 * Extracts 1-based line and column coordinates for JSON.parse syntax errors across JS engines.
 */
export function parseErrorDetails(error, source) {
  const message = error instanceof Error ? error.message : String(error);
  const lineMatch = message.match(/line (\d+) column (\d+)/i);
  if (lineMatch) {
    return { line: Number(lineMatch[1]), column: Number(lineMatch[2]), message };
  }

  const positionMatch = message.match(/position (\d+)/i);
  if (positionMatch) {
    const position = Math.max(0, Number(positionMatch[1]));
    const before = source.slice(0, position);
    const lines = before.split('\n');
    const line = lines.length;
    const column = lines[lines.length - 1].length + 1;
    return { line, column, message };
  }

  const fallback = findJsonSyntaxPosition(source);
  return { line: fallback.line, column: fallback.column, message };
}

/**
 * Builds a JSON Pointer -> 1-based line lookup map for a valid JSON source string.
 */
export function indexJsonLines(source) {
  const lines = new Map();
  let index = 0;
  let line = 1;

  const skipWhitespace = () => {
    while (index < source.length) {
      const char = source[index];
      if (char === '\n') {
        line += 1;
        index += 1;
      } else if (char === '\r') {
        line += 1;
        index += 1;
        if (source[index] === '\n') index += 1;
      } else if (char === ' ' || char === '\t') {
        index += 1;
      } else {
        break;
      }
    }
  };

  const readString = () => {
    let value = '';
    index += 1;
    while (index < source.length) {
      const char = source[index];
      if (char === '"') {
        index += 1;
        return value;
      }
      if (char === '\\') {
        index += 1;
        const escaped = source[index];
        if (escaped === 'u') {
          const code = Number.parseInt(source.slice(index + 1, index + 5), 16);
          value += Number.isNaN(code) ? '' : String.fromCharCode(code);
          index += 5;
        } else {
          const escapes = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          value += escapes[escaped] ?? escaped;
          index += 1;
        }
        continue;
      }
      if (char === '\n') line += 1;
      value += char;
      index += 1;
    }
    return value;
  };

  const parseValue = (path) => {
    skipWhitespace();
    if (index >= source.length) return;
    lines.set(path, line);
    const char = source[index];
    if (char === '{') {
      parseObject(path);
    } else if (char === '[') {
      parseArray(path);
    } else if (char === '"') {
      readString();
    } else {
      while (index < source.length && !/[\s,\]}]/.test(source[index])) {
        index += 1;
      }
    }
  };

  const parseObject = (path) => {
    index += 1;
    skipWhitespace();
    if (source[index] === '}') {
      index += 1;
      return;
    }
    while (index < source.length) {
      skipWhitespace();
      if (source[index] !== '"') return;
      const key = readString();
      skipWhitespace();
      if (source[index] === ':') index += 1;
      parseValue(`${path}/${escapePointerSegment(key)}`);
      skipWhitespace();
      if (source[index] === ',') {
        index += 1;
        continue;
      }
      if (source[index] === '}') index += 1;
      return;
    }
  };

  const parseArray = (path) => {
    index += 1;
    skipWhitespace();
    if (source[index] === ']') {
      index += 1;
      return;
    }
    let itemIndex = 0;
    while (index < source.length) {
      parseValue(`${path}/${itemIndex}`);
      itemIndex += 1;
      skipWhitespace();
      if (source[index] === ',') {
        index += 1;
        continue;
      }
      if (source[index] === ']') index += 1;
      return;
    }
  };

  parseValue('#');
  return lines;
}

/**
 * Resolves the nearest 1-based line number for a JSON Pointer path, falling back to ancestors.
 */
export function lineForPath(path, lineIndex) {
  let pointer = path;
  while (pointer && pointer !== '#') {
    if (lineIndex.has(pointer)) return lineIndex.get(pointer);
    const slash = pointer.lastIndexOf('/');
    if (slash <= 0) break;
    pointer = pointer.slice(0, slash);
  }
  return lineIndex.get('#') ?? 1;
}

function getSourceLine(source, lineNumber) {
  const lines = source.split(/\r?\n/);
  const idx = Math.max(0, Math.min(lines.length - 1, lineNumber - 1));
  return (lines[idx] ?? '').trim();
}

function selectLineInTextarea(textarea, lineNumber) {
  if (!textarea) return;
  const lines = textarea.value.split('\n');
  const targetIdx = Math.max(0, Math.min(lines.length - 1, lineNumber - 1));
  let start = 0;
  for (let i = 0; i < targetIdx; i += 1) {
    start += lines[i].length + 1;
  }
  const end = start + lines[targetIdx].length;
  textarea.focus();
  textarea.setSelectionRange(start, end);
  const ratio = lines.length > 1 ? targetIdx / (lines.length - 1) : 0;
  textarea.scrollTop = Math.max(0, ratio * Math.max(0, textarea.scrollHeight - textarea.clientHeight));
}

function createEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function renderGutter(gutterEl, source, errorLines) {
  if (!gutterEl) return;
  const lineCount = Math.max(1, source.split(/\r?\n/).length);
  const frag = document.createDocumentFragment();
  for (let lineNum = 1; lineNum <= lineCount; lineNum += 1) {
    const span = document.createElement('span');
    span.className = errorLines.has(lineNum) ? 'gutter-line gutter-line--error' : 'gutter-line';
    span.textContent = String(lineNum);
    frag.appendChild(span);
  }
  gutterEl.replaceChildren(frag);
}

function mount() {
  const root = document.querySelector('[data-schema-lab]');
  if (!root) return;

  const get = (id) => root.querySelector(`#${id}`);
  const validator = new DroneDeliverySkywaySchemaValidator();

  const schemaInput = get('schema-input');
  const payloadInput = get('payload-input');
  const schemaGutter = get('schema-gutter');
  const payloadGutter = get('payload-gutter');
  const schemaPane = get('schema-pane');
  const payloadPane = get('payload-pane');
  const schemaState = get('schema-pane-state');
  const payloadState = get('payload-pane-state');
  const statusBadge = get('status-badge');
  const errorCountEl = get('error-count');
  const errorLabelEl = get('error-label');
  const reportSummaryEl = get('report-summary');
  const errorListEl = get('error-list');
  const rawReportEl = get('raw-report');
  const templateSelect = get('template-select');
  const copyReportBtn = get('copy-report-btn');

  const setBadge = (state, text) => {
    if (!statusBadge) return;
    statusBadge.className = `pill pill--${state}`;
    statusBadge.textContent = text;
  };

  const setPaneStates = ({ schemaOk, payloadOk }) => {
    if (schemaPane) {
      schemaPane.classList.toggle('pane--error', !schemaOk);
      schemaPane.classList.toggle('pane--pass', schemaOk);
    }
    if (payloadPane) {
      payloadPane.classList.toggle('pane--error', !payloadOk);
      payloadPane.classList.toggle('pane--pass', payloadOk);
    }
    if (schemaState) {
      schemaState.className = `pane-state ${schemaOk ? 'pane-state--ok' : 'pane-state--err'}`;
      schemaState.textContent = schemaOk ? 'JSON OK' : 'SYNTAX ERR';
    }
    if (payloadState) {
      payloadState.className = `pane-state ${payloadOk ? 'pane-state--ok' : 'pane-state--err'}`;
      payloadState.textContent = payloadOk ? 'VALID' : 'ISSUES';
    }
  };

  const updateMeta = () => {
    const updateCounter = (id, text) => {
      const target = get(id);
      if (!target) return;
      const lines = text.length === 0 ? 0 : text.split(/\r?\n/).length;
      target.textContent = `${lines} line${lines === 1 ? '' : 's'} · ${text.length} chars`;
    };
    if (schemaInput) updateCounter('schema-meta', schemaInput.value);
    if (payloadInput) updateCounter('payload-meta', payloadInput.value);
  };

  const syncGutters = (schemaErrorLines = new Set(), payloadErrorLines = new Set()) => {
    if (schemaInput) {
      renderGutter(schemaGutter, schemaInput.value, schemaErrorLines);
      if (schemaGutter) schemaGutter.scrollTop = schemaInput.scrollTop;
    }
    if (payloadInput) {
      renderGutter(payloadGutter, payloadInput.value, payloadErrorLines);
      if (payloadGutter) payloadGutter.scrollTop = payloadInput.scrollTop;
    }
  };

  const setSummary = (count, summary, report) => {
    if (errorCountEl) errorCountEl.textContent = String(count);
    if (errorLabelEl) errorLabelEl.textContent = count === 1 ? 'violation' : 'violations';
    if (reportSummaryEl) reportSummaryEl.textContent = summary;
    if (rawReportEl) rawReportEl.textContent = report;
  };

  const buildCallout = ({ line, keyword, path, message, snippet, targetTextarea, targetGutter, isSyntax = false }) => {
    const item = createEl(
      'li',
      `error-callout${targetTextarea ? ' error-callout--interactive' : ''}${isSyntax ? ' error-callout--syntax' : ''}`
    );

    if (targetTextarea) {
      item.tabIndex = 0;
      item.title = `Jump to line ${line}`;
      const jump = () => {
        selectLineInTextarea(targetTextarea, line);
        if (targetGutter) targetGutter.scrollTop = targetTextarea.scrollTop;
      };
      item.addEventListener('click', jump);
      item.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          jump();
        }
      });
    }

    const lineBadge = createEl('span', 'callout-line', `LINE ${line}`);
    const body = createEl('div', 'callout-body');
    const meta = createEl('div', 'callout-meta');
    meta.append(
      createEl('code', 'callout-path', path),
      createEl('span', 'keyword-chip', keyword)
    );
    body.append(meta, createEl('p', 'callout-message', message));

    if (snippet) {
      body.append(createEl('code', 'callout-snippet', snippet));
    }

    item.append(lineBadge, body);
    return item;
  };

  const renderPass = () => {
    const report = validator.formatValidationErrors();
    setBadge('pass', 'PASS · 0 ERRORS');
    setPaneStates({ schemaOk: true, payloadOk: true });
    syncGutters(new Set(), new Set());
    setSummary(0, 'Payload strictly conforms to the Drone Delivery Skyway schema.', report);

    if (errorListEl) {
      const empty = createEl('li', 'empty-state');
      empty.append(
        createEl('span', 'empty-badge', 'PASS'),
        createEl('p', '', 'All required fields, nested objects, array constraints, types, and corridor enums passed.')
      );
      errorListEl.replaceChildren(empty);
    }
  };

  const renderViolations = (errors, payloadSource) => {
    const report = validator.formatValidationErrors();
    const lineIndex = indexJsonLines(payloadSource);
    const payloadErrorLines = new Set();
    const mappedErrors = errors.map((error) => {
      const line = lineForPath(error.path, lineIndex);
      payloadErrorLines.add(line);
      return { ...error, line };
    });

    const label = `${errors.length} ${errors.length === 1 ? 'VIOLATION' : 'VIOLATIONS'}`;
    setBadge('fail', `FAIL · ${label}`);
    setPaneStates({ schemaOk: true, payloadOk: false });
    syncGutters(new Set(), payloadErrorLines);
    setSummary(
      errors.length,
      `Detected ${errors.length} schema mismatch${errors.length === 1 ? '' : 'es'}. Click any callout to highlight that line.`,
      report
    );

    if (errorListEl) {
      errorListEl.replaceChildren(
        ...mappedErrors.map((error) =>
          buildCallout({
            line: error.line,
            keyword: error.keyword,
            path: error.path,
            message: error.message,
            snippet: getSourceLine(payloadSource, error.line),
            targetTextarea: payloadInput,
            targetGutter: payloadGutter
          })
        )
      );
    }
  };

  const renderParseError = (which, error, source, targetTextarea, targetGutter) => {
    const details = parseErrorDetails(error, source);
    const report = `${which} JSON syntax error at line ${details.line}, column ${details.column}: ${details.message}`;
    const errorSet = new Set([details.line]);

    setBadge('fail', `${which.toUpperCase()} SYNTAX ERROR`);
    setPaneStates({
      schemaOk: which !== 'Schema',
      payloadOk: which !== 'Payload'
    });
    if (which === 'Payload' && payloadState) {
      payloadState.textContent = 'SYNTAX ERR';
    }
    syncGutters(
      which === 'Schema' ? errorSet : new Set(),
      which === 'Payload' ? errorSet : new Set()
    );
    setSummary(1, `${which} JSON contains a syntax error. Fix line ${details.line} before schema linting can run.`, report);

    if (errorListEl) {
      errorListEl.replaceChildren(
        buildCallout({
          line: details.line,
          keyword: 'syntax',
          path: `${which} (col ${details.column})`,
          message: details.message,
          snippet: getSourceLine(source, details.line),
          targetTextarea,
          targetGutter,
          isSyntax: true
        })
      );
    }
  };

  const runValidation = () => {
    updateMeta();
    const schemaSource = schemaInput ? schemaInput.value : '';
    const payloadSource = payloadInput ? payloadInput.value : '';

    let parsedSchema;
    try {
      parsedSchema = JSON.parse(schemaSource);
    } catch (error) {
      renderParseError('Schema', error, schemaSource, schemaInput, schemaGutter);
      return;
    }

    let parsedPayload;
    try {
      parsedPayload = JSON.parse(payloadSource);
    } catch (error) {
      renderParseError('Payload', error, payloadSource, payloadInput, payloadGutter);
      return;
    }

    const result = validator.validate(parsedSchema, parsedPayload);
    if (result.valid) {
      renderPass();
    } else {
      renderViolations(result.errors, payloadSource);
    }
  };

  const loadTemplate = (templateKey) => {
    const template = SCHEMA_TEMPLATES[templateKey] ?? SCHEMA_TEMPLATES.flightDispatch;
    if (schemaInput) schemaInput.value = JSON.stringify(template.schema, null, 2);
    if (payloadInput) payloadInput.value = JSON.stringify(template.payload, null, 2);
    runValidation();
  };

  const formatEditors = () => {
    try {
      if (schemaInput) {
        schemaInput.value = JSON.stringify(JSON.parse(schemaInput.value), null, 2);
      }
      if (payloadInput) {
        payloadInput.value = JSON.stringify(JSON.parse(payloadInput.value), null, 2);
      }
    } catch {
      // runValidation highlights the exact syntax error line if parsing fails.
    }
    runValidation();
  };

  schemaInput?.addEventListener('scroll', () => {
    if (schemaGutter) schemaGutter.scrollTop = schemaInput.scrollTop;
  });
  payloadInput?.addEventListener('scroll', () => {
    if (payloadGutter) payloadGutter.scrollTop = payloadInput.scrollTop;
  });

  templateSelect?.addEventListener('change', (event) => loadTemplate(event.target.value));
  get('validate-btn')?.addEventListener('click', runValidation);
  get('format-btn')?.addEventListener('click', formatEditors);
  get('reset-btn')?.addEventListener('click', () => loadTemplate(templateSelect?.value || 'flightDispatch'));
  schemaInput?.addEventListener('input', runValidation);
  payloadInput?.addEventListener('input', runValidation);

  copyReportBtn?.addEventListener('click', async () => {
    if (!rawReportEl || !navigator?.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(rawReportEl.textContent || '');
      const original = copyReportBtn.textContent;
      copyReportBtn.textContent = 'Copied';
      setTimeout(() => {
        copyReportBtn.textContent = original;
      }, 1500);
    } catch {
      // Clipboard permission unavailable or denied.
    }
  });

  loadTemplate(templateSelect?.value || 'flightDispatch');
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
}
