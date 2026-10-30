export type JsonSchema = {
  type: "object" | "string" | "integer" | "boolean" | "array";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: false;
  enum?: readonly string[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  maxItems?: number;
  items?: JsonSchema;
  pattern?: string;
};

/** Returns a safe message for the first violation, or null when the value matches. Supports the subset used by the tool schemas. */
export function validate(schema: JsonSchema, value: unknown, path = "arguments"): string | null {
  switch (schema.type) {
    case "object":
      return validateObject(schema, value, path);
    case "string":
      return validateString(schema, value, path);
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) return `${path} must be an integer.`;
      if (schema.minimum !== undefined && value < schema.minimum) return `${path} must be at least ${schema.minimum}.`;
      if (schema.maximum !== undefined && value > schema.maximum) return `${path} must be at most ${schema.maximum}.`;
      return null;
    case "boolean":
      return typeof value === "boolean" ? null : `${path} must be true or false.`;
    case "array":
      return validateArray(schema, value, path);
  }
}

function validateObject(schema: JsonSchema, value: unknown, path: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return `${path} must be an object.`;
  const obj = value as Record<string, unknown>;
  const props = schema.properties ?? {};
  for (const key of schema.required ?? []) if (obj[key] === undefined) return `${path}.${key} is required.`;
  for (const key of Object.keys(obj)) {
    if (!(key in props)) return schema.additionalProperties === false ? `${path}.${key} is not an accepted argument.` : null;
    const error = validate(props[key], obj[key], `${path}.${key}`);
    if (error) return error;
  }
  return null;
}

function validateString(schema: JsonSchema, value: unknown, path: string): string | null {
  if (typeof value !== "string") return `${path} must be a string.`;
  if (schema.enum && !schema.enum.includes(value)) return `${path} must be one of: ${schema.enum.join(", ")}.`;
  if (schema.minLength !== undefined && value.trim().length < schema.minLength) return `${path} is too short.`;
  if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${path} must be at most ${schema.maxLength} characters.`;
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) return `${path} has an invalid format.`;
  return null;
}

function validateArray(schema: JsonSchema, value: unknown, path: string): string | null {
  if (!Array.isArray(value)) return `${path} must be an array.`;
  if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${path} has too many items (max ${schema.maxItems}).`;
  for (let i = 0; i < value.length; i++) {
    const error = schema.items ? validate(schema.items, value[i], `${path}[${i}]`) : null;
    if (error) return error;
  }
  return null;
}
