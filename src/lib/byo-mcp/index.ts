import { prisma } from "@/lib/db";
import { audit } from "@/lib/auth/audit";
import { openSecret } from "@/lib/crypto/secrets";
import { createLimiter } from "@/lib/ratelimit";
import { HttpError } from "@/lib/tenancy";
import { fetchTools, invokeTool, McpClientError, type McpDeps } from "./client";

export type McpToolInfo = { connectionId: string; name: string; description: string; inputSchema: Record<string, unknown>; readOnlyHint?: boolean; destructiveHint?: boolean };

export const MAX_ARGS_BYTES = 16 * 1024;
export const RATE_LIMIT_CALLS = 30;
export const RATE_WINDOW_MS = 60_000;
const TOOL_CACHE_MS = 5 * 60_000;

const callLimiter = createLimiter(RATE_LIMIT_CALLS, RATE_WINDOW_MS, "byo-mcp");
const toolCache = new Map<string, { at: number; tools: McpToolInfo[] }>();

export function resetByoMcpState() {
  void callLimiter.clear();
  toolCache.clear();
}

function takeRateSlot(tenantId: string, now: number) {
  if (!callLimiter.consume(tenantId, now)) throw new HttpError(429, "Too many tool calls. Try again in a minute.");
}

/** Tools the tenant explicitly allowed (McpConnection.allowedTools) on enabled connections. */
export async function listAllowedTools(tenantId: string, deps: McpDeps = {}): Promise<McpToolInfo[]> {
  const rows = await prisma.mcpConnection.findMany({ where: { tenantId, enabled: true } });
  const out: McpToolInfo[] = [];
  for (const row of rows) {
    if (row.allowedTools.length === 0) continue;
    const key = `${tenantId}:${row.id}:${row.url}:${row.allowedTools.join("|")}`;
    const hit = toolCache.get(key);
    if (hit && Date.now() - hit.at < TOOL_CACHE_MS) {
      out.push(...hit.tools);
      continue;
    }
    try {
      const { tools } = await fetchTools(row.url, row.authEnc ? openSecret(tenantId, row.authEnc) : null, deps);
      const allowed = tools
        .filter((t) => row.allowedTools.includes(t.name))
        .map((t) => ({ connectionId: row.id, name: t.name, description: t.description, inputSchema: t.inputSchema, readOnlyHint: t.readOnlyHint, destructiveHint: t.destructiveHint }));
      toolCache.set(key, { at: Date.now(), tools: allowed });
      out.push(...allowed);
    } catch {
      continue;
    }
  }
  return out;
}

/** Calls an allowed tool on the customer's own MCP server (SSRF-safe, time and size limited). Throws HttpError(403) when the tool is not allowed. */
export async function callTool(
  tenantId: string,
  connectionId: string,
  toolName: string,
  args: Record<string, unknown>,
  deps: McpDeps = {},
): Promise<{ text: string; isError: boolean }> {
  const row = await prisma.mcpConnection.findFirst({ where: { id: connectionId, tenantId, enabled: true } });
  if (!row || !row.allowedTools.includes(toolName)) throw new HttpError(403, "That tool is not allowed.");
  if (!args || typeof args !== "object" || Array.isArray(args) || Buffer.byteLength(JSON.stringify(args)) > MAX_ARGS_BYTES) {
    throw new HttpError(400, "The tool arguments are too large.");
  }
  takeRateSlot(tenantId, (deps.now ?? Date.now)());

  let isError = true;
  try {
    const result = await invokeTool(row.url, row.authEnc ? openSecret(tenantId, row.authEnc) : null, toolName, args, deps);
    isError = result.isError;
    return result;
  } catch (e) {
    const safe = e instanceof McpClientError || e instanceof HttpError;
    return { text: safe ? e.message : "The tool call failed.", isError: true };
  } finally {
    await audit({ tenantId, action: "mcp.tool_call", target: connectionId, meta: { tool: toolName, isError } });
  }
}
