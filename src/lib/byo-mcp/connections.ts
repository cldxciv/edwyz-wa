import { prisma } from "@/lib/db";
import { audit } from "@/lib/auth/audit";
import { openSecret, sealSecret } from "@/lib/crypto/secrets";
import { assertPublicUrl, defaultResolver } from "@/lib/integrations/ssrf";
import { HttpError, type Actor } from "@/lib/tenancy";
import { fetchTools, McpClientError, type McpDeps } from "./client";
import { clearConnectionExposure, exposureEntry, getCustomerExposure, setConnectionExposure } from "./exposure";
import { isCustomerSafeTool } from "./risk";

export const MAX_CONNECTIONS = 10;

type Row = { id: string; name: string; url: string; authEnc: string | null; allowedTools: string[]; enabled: boolean; createdAt: Date };

/** customerTools lists the allowed tools the admin explicitly exposed to the customer-facing AI agent (needed for risky tools). */
export function toView(row: Row, exposed: Set<string> = new Set()) {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    hasAuth: !!row.authEnc,
    allowedTools: row.allowedTools,
    customerTools: row.allowedTools.filter((t) => exposed.has(exposureEntry(row.id, t))),
    enabled: row.enabled,
    createdAt: row.createdAt,
  };
}

function cleanName(v: unknown): string {
  if (typeof v !== "string" || !v.trim() || v.trim().length > 80) throw new HttpError(400, "Enter a name of up to 80 characters.");
  return v.trim();
}

function cleanToken(v: unknown): string | null {
  if (v === null || v === "") return null;
  if (typeof v !== "string" || v.length > 2048 || /[\s\u0000-\u001f]/.test(v)) throw new HttpError(400, "The access token is not valid.");
  return v;
}

function cleanTools(v: unknown): string[] {
  if (!Array.isArray(v) || v.length > 200 || v.some((t) => typeof t !== "string" || !t || t.length > 128)) throw new HttpError(400, "allowedTools must be a list of tool names.");
  return [...new Set(v as string[])];
}

async function cleanUrl(v: unknown, deps: McpDeps): Promise<string> {
  if (typeof v !== "string") throw new HttpError(400, "Enter the server URL.");
  const safe = await assertPublicUrl(v.trim(), deps.resolve ?? defaultResolver, "Server URLs");
  return safe.url.href;
}

export async function listConnections(tenantId: string) {
  const [rows, exposed] = await Promise.all([prisma.mcpConnection.findMany({ where: { tenantId }, orderBy: { createdAt: "asc" } }), getCustomerExposure(tenantId)]);
  return rows.map((row) => toView(row, exposed));
}

async function load(tenantId: string, id: string): Promise<Row> {
  const row = await prisma.mcpConnection.findFirst({ where: { id, tenantId } });
  if (!row) throw new HttpError(404, "Connection not found.");
  return row;
}

export async function createConnection(actor: Actor, input: Record<string, unknown>, deps: McpDeps = {}) {
  const name = cleanName(input.name);
  const url = await cleanUrl(input.url, deps);
  const token = cleanToken(input.authToken ?? null);
  if ((await prisma.mcpConnection.count({ where: { tenantId: actor.tenantId } })) >= MAX_CONNECTIONS) throw new HttpError(409, `You can connect up to ${MAX_CONNECTIONS} servers.`);
  const row = await prisma.mcpConnection.create({
    data: { tenantId: actor.tenantId, name, url, authEnc: token ? sealSecret(actor.tenantId, token) : null, allowedTools: [] },
  });
  await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "mcp.connection_created", target: row.id });
  return toView(row);
}

/** Which of the connection's tools stay exposed to customers after this update; null when exposure is unchanged. */
async function nextExposure(tenantId: string, existing: Row, input: Record<string, unknown>, data: Record<string, unknown>): Promise<string[] | null> {
  const urlChanged = typeof data.url === "string" && data.url !== existing.url;
  if (!("customerTools" in input) && !("allowedTools" in input) && !urlChanged) return null;
  if (urlChanged) return [];
  const exposed = await getCustomerExposure(tenantId);
  const requested = "customerTools" in input ? cleanTools(input.customerTools) : existing.allowedTools.filter((t) => exposed.has(exposureEntry(existing.id, t)));
  const allowed = (data.allowedTools as string[] | undefined) ?? existing.allowedTools;
  return requested.filter((t) => allowed.includes(t));
}

export async function updateConnection(actor: Actor, id: string, input: Record<string, unknown>, deps: McpDeps = {}) {
  const existing = await load(actor.tenantId, id);
  const data: Record<string, unknown> = {};
  if ("name" in input) data.name = cleanName(input.name);
  if ("url" in input) data.url = await cleanUrl(input.url, deps);
  if ("authToken" in input) {
    const token = cleanToken(input.authToken);
    data.authEnc = token ? sealSecret(actor.tenantId, token) : null;
  }
  if ("allowedTools" in input) data.allowedTools = cleanTools(input.allowedTools);
  if ("enabled" in input) {
    if (typeof input.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false.");
    data.enabled = input.enabled;
  }
  const exposure = await nextExposure(actor.tenantId, existing, input, data);
  if (exposure) {
    await setConnectionExposure(actor.tenantId, id, exposure);
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "mcp.customer_tools_updated", target: id, meta: { exposed: exposure.length } });
  }
  await prisma.mcpConnection.updateMany({ where: { id, tenantId: actor.tenantId }, data });
  await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "mcp.connection_updated", target: id, meta: { fields: Object.keys(data).join(",") } });
  return toView(await load(actor.tenantId, id), await getCustomerExposure(actor.tenantId));
}

export async function deleteConnection(actor: Actor, id: string) {
  await load(actor.tenantId, id);
  await prisma.mcpConnection.deleteMany({ where: { id, tenantId: actor.tenantId } });
  await clearConnectionExposure(actor.tenantId, id).catch(() => undefined);
  await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "mcp.connection_deleted", target: id });
}

/** Connects to the server and returns its tools with allowlist and risk flags for the UI. Never returns the token. */
export async function testConnection(actor: Actor, id: string, deps: McpDeps = {}) {
  const row = await load(actor.tenantId, id);
  try {
    const token = row.authEnc ? openSecret(actor.tenantId, row.authEnc) : null;
    const [{ serverName, tools }, exposed] = await Promise.all([fetchTools(row.url, token, deps), getCustomerExposure(actor.tenantId)]);
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "mcp.connection_tested", target: id, meta: { ok: true, tools: tools.length } });
    return {
      ok: true as const,
      serverName,
      tools: tools.map((t) => ({ name: t.name, description: t.description, risky: !isCustomerSafeTool(t.name, t.description, t), allowed: row.allowedTools.includes(t.name), customerExposed: exposed.has(exposureEntry(row.id, t.name)) })),
    };
  } catch (e) {
    const message = e instanceof McpClientError || e instanceof HttpError ? e.message : "Could not connect to the server.";
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "mcp.connection_tested", target: id, meta: { ok: false } });
    return { ok: false as const, error: message, tools: [] as never[] };
  }
}
