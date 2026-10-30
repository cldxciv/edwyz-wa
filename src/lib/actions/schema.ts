/**
 * Input schemas of action definitions (docs/EDDY-SPEC.md 4.1). validate() and JsonSchema stay in tenant-mcp/schema.ts until
 * EDDY-20 moves them here; this module re-exports them so definitions and invoke.ts import one place. strictSchemaProblems
 * is the registry's load check: every object in a tool schema closes its properties and lists what it requires, as strict
 * tool use needs (4.9).
 */
import type { JsonSchema } from "@/lib/tenant-mcp/schema";

export { validate, type JsonSchema } from "@/lib/tenant-mcp/schema";

/** Everything that keeps a schema from being a strict tool schema, as sentences naming the path. Empty when it is fine. */
export function strictSchemaProblems(schema: JsonSchema, path = "inputSchema"): string[] {
  const problems: string[] = [];
  const walk = (s: JsonSchema, at: string) => {
    if (s.type === "object") {
      if (s.additionalProperties !== false) problems.push(`${at} must set additionalProperties: false.`);
      if (!Array.isArray(s.required)) problems.push(`${at} must list required properties (an empty list is fine).`);
      const props = s.properties ?? {};
      for (const key of s.required ?? []) if (!(key in props)) problems.push(`${at}.required names "${key}", which is not a property.`);
      for (const [key, child] of Object.entries(props)) walk(child, `${at}.${key}`);
    } else if (s.type === "array") {
      if (!s.items) problems.push(`${at} must describe its items.`);
      else walk(s.items, `${at}[]`);
    }
  };
  if (schema.type !== "object") problems.push(`${path} must be an object schema.`);
  walk(schema, path);
  return problems;
}
