const MAX_DEPTH = 8;
const MAX_PATTERN = 200;
const MAX_PATTERN_INPUT = 500;
const MAX_UNBOUNDED_QUANTIFIERS = 3;

type Schema = Record<string, unknown>;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return isObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    default:
      return true;
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const QUANTIFIED_GROUP_WITH_REPEAT = /\([^()]*(?:[+*]|\{\d+(?:,\d*)?\}|\|)[^()]*\)\s*(?:[+*]|\{\d+(?:,\d*)?\})/;
const UNBOUNDED_QUANTIFIER = /(?<!\\)(?:[+*]|\{\d+,\})/g;

/**
 * The pattern comes from the tenant's own server and runs on the shared event loop, so only patterns that cannot backtrack catastrophically are used.
 * Returns null (the keyword is skipped, like other unsupported ones) for patterns that are too long, invalid, use backreferences or lookarounds,
 * repeat a group that itself repeats or alternates, or have more than a few unbounded quantifiers.
 */
function safePattern(pattern: string): RegExp | null {
  if (pattern.length > MAX_PATTERN) return null;
  if (/\\[1-9]|\\k<|\(\?[=!<]/.test(pattern)) return null;
  if (QUANTIFIED_GROUP_WITH_REPEAT.test(pattern)) return null;
  if ((pattern.match(UNBOUNDED_QUANTIFIER)?.length ?? 0) > MAX_UNBOUNDED_QUANTIFIERS) return null;
  for (const flags of ["u", ""]) {
    try {
      return new RegExp(pattern, flags);
    } catch {
      continue;
    }
  }
  return null;
}

function checkString(schema: Schema, value: string, path: string): string | null {
  if (typeof schema.minLength === "number" && value.length < schema.minLength) return `${path} is too short.`;
  if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return `${path} is too long.`;
  if (typeof schema.pattern === "string") {
    const regex = safePattern(schema.pattern);
    if (regex) {
      if (value.length > MAX_PATTERN_INPUT) return `${path} is too long.`;
      if (!regex.test(value)) return `${path} does not match the required format.`;
    }
  }
  return null;
}

function checkNumber(schema: Schema, value: number, path: string): string | null {
  if (typeof schema.minimum === "number" && value < schema.minimum) return `${path} is below the minimum.`;
  if (typeof schema.maximum === "number" && value > schema.maximum) return `${path} is above the maximum.`;
  return null;
}

function checkArray(schema: Schema, value: unknown[], path: string, depth: number): string | null {
  if (typeof schema.minItems === "number" && value.length < schema.minItems) return `${path} has too few items.`;
  if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return `${path} has too many items.`;
  if (isObject(schema.items)) {
    for (let i = 0; i < value.length; i++) {
      const error = check(schema.items, value[i], `${path}[${i}]`, depth + 1);
      if (error) return error;
    }
  }
  return null;
}

function checkObject(schema: Schema, value: Record<string, unknown>, path: string, depth: number): string | null {
  const props = isObject(schema.properties) ? schema.properties : {};
  if (Array.isArray(schema.required)) {
    for (const key of schema.required) if (typeof key === "string" && !has(value, key)) return `${path}.${key} is required.`;
  }
  for (const key of Object.keys(value)) {
    if (has(props, key)) {
      const sub = props[key];
      const error = isObject(sub) ? check(sub, value[key], `${path}.${key}`, depth + 1) : null;
      if (error) return error;
    } else if (schema.additionalProperties === false) {
      return `${path}.${key} is not an accepted argument.`;
    } else if (isObject(schema.additionalProperties)) {
      const error = check(schema.additionalProperties, value[key], `${path}.${key}`, depth + 1);
      if (error) return error;
    }
  }
  return null;
}

function checkCombinators(schema: Schema, value: unknown, path: string, depth: number): string | null {
  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) {
      const error = isObject(sub) ? check(sub, value, path, depth + 1) : null;
      if (error) return error;
    }
  }
  for (const key of ["anyOf", "oneOf"] as const) {
    const options = schema[key];
    if (Array.isArray(options) && options.length > 0 && !options.some((sub) => isObject(sub) && check(sub, value, path, depth + 1) === null)) {
      return `${path} does not match any allowed form.`;
    }
  }
  return null;
}

function check(schema: Schema, value: unknown, path: string, depth: number): string | null {
  if (depth > MAX_DEPTH) return `${path} is nested too deeply.`;
  const types = Array.isArray(schema.type) ? schema.type.filter((t): t is string => typeof t === "string") : typeof schema.type === "string" ? [schema.type] : [];
  if (types.length > 0 && !types.some((t) => matchesType(t, value))) return `${path} must be of type ${types.join(" or ")}, not ${kindOf(value)}.`;
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => sameValue(option, value))) return `${path} is not one of the allowed values.`;
  if (has(schema, "const") && !sameValue(schema.const, value)) return `${path} is not the allowed value.`;
  const combined = checkCombinators(schema, value, path, depth);
  if (combined) return combined;
  if (typeof value === "string") return checkString(schema, value, path);
  if (typeof value === "number") return checkNumber(schema, value, path);
  if (Array.isArray(value)) return checkArray(schema, value, path, depth);
  if (isObject(value)) return checkObject(schema, value, path, depth);
  return null;
}

/**
 * Checks model-chosen tool arguments against the tool's JSON Schema before the tool is called. Supports the common subset
 * (type, enum, const, required, properties, additionalProperties, string/number/array bounds, pattern, anyOf/oneOf/allOf);
 * other keywords are ignored. Returns a safe message for the first violation (never echoing values), or null when valid.
 */
export function validateToolArgs(schema: unknown, args: unknown): string | null {
  if (!isObject(args)) return "arguments must be an object.";
  const root: Schema = isObject(schema) ? { ...schema, type: "object" } : { type: "object" };
  return check(root, args, "arguments", 0);
}
