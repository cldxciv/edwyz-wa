import { assertPublicUrl, defaultResolver, type Resolver } from "@/lib/integrations/ssrf";
import { pinnedMcpTransport, type McpTransport } from "./transport";

export const PROTOCOL_VERSION = "2025-06-18";
export const MAX_RESPONSE_BYTES = 256 * 1024;
export const TEST_TIMEOUT_MS = 10_000;
export const CALL_TIMEOUT_MS = 15_000;
export const RESULT_TEXT_CAP = 8 * 1024;
const MAX_TOOLS = 200;
const MAX_PAGES = 5;

export class McpClientError extends Error {}

export type McpDeps = { resolve?: Resolver; transport?: McpTransport; now?: () => number };
export type RemoteTool = { name: string; description: string; inputSchema: Record<string, unknown>; readOnlyHint?: boolean; destructiveHint?: boolean };
export type CallResult = { text: string; isError: boolean };

type Session = { call: (method: string, params?: Record<string, unknown>) => Promise<unknown>; serverName: string };

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const clean = (s: unknown, max: number) => (typeof s === "string" ? s.replace(CONTROL, "").slice(0, max) : "");

/** Parses either a plain JSON-RPC body or an SSE stream and returns the message answering `id`. */
export function parseRpcBody(contentType: string, body: string, id: number): Record<string, unknown> {
  const candidates: unknown[] = [];
  if (contentType.toLowerCase().includes("text/event-stream")) {
    for (const event of body.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data) continue;
      try {
        candidates.push(JSON.parse(data));
      } catch {
        continue;
      }
    }
  } else {
    try {
      const parsed = JSON.parse(body);
      candidates.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      throw new McpClientError("The server sent a response that is not valid JSON.");
    }
  }
  const match = candidates.find((m) => m && typeof m === "object" && (m as { id?: unknown }).id === id);
  if (!match) throw new McpClientError("The server did not answer the request.");
  return match as Record<string, unknown>;
}

async function openSession(rawUrl: string, token: string | null, timeoutMs: number, deps: McpDeps): Promise<Session> {
  const target = await assertPublicUrl(rawUrl, deps.resolve ?? defaultResolver);
  const transport = deps.transport ?? pinnedMcpTransport;
  const now = deps.now ?? Date.now;
  const deadline = now() + timeoutMs;
  let nextId = 1;
  let sessionId: string | null = null;
  let negotiated = PROTOCOL_VERSION;

  const send = async (payload: Record<string, unknown>) => {
    const remaining = deadline - now();
    if (remaining <= 0) throw new McpClientError("The server took too long to respond.");
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "user-agent": "Edwyz-MCP/1.0",
      "mcp-protocol-version": negotiated,
    };
    if (token) headers.authorization = `Bearer ${token}`;
    if (sessionId) headers["mcp-session-id"] = sessionId;
    try {
      return await transport({ url: target.url, address: target.addresses[0], method: "POST", headers, body: JSON.stringify(payload), timeoutMs: remaining, maxBytes: MAX_RESPONSE_BYTES });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      if (msg === "timeout") throw new McpClientError("The server took too long to respond.");
      if (msg === "too_large") throw new McpClientError("The server response was too large.");
      throw new McpClientError("Could not connect to the server.");
    }
  };

  const call = async (method: string, params?: Record<string, unknown>) => {
    const id = nextId++;
    const res = await send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    if (res.status >= 300 && res.status < 400) throw new McpClientError("The server redirected the request; redirects are not followed.");
    if (res.status === 401 || res.status === 403) throw new McpClientError("The server rejected the access token.");
    if (res.status < 200 || res.status >= 300) throw new McpClientError(`The server answered with status ${res.status}.`);
    const sid = res.headers["mcp-session-id"];
    if (sid && !sessionId) sessionId = sid.slice(0, 256);
    const message = parseRpcBody(res.headers["content-type"] ?? "", res.body, id);
    if (message.error) throw new McpClientError("The server reported an error for this request.");
    return message.result;
  };

  const init = (await call("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "edwyz-wa", version: "1.0" },
  })) as { protocolVersion?: unknown; serverInfo?: { name?: unknown } } | undefined;
  if (typeof init?.protocolVersion === "string") negotiated = init.protocolVersion.slice(0, 32);
  const note = await send({ jsonrpc: "2.0", method: "notifications/initialized" });
  if (note.status < 200 || note.status >= 300) throw new McpClientError("The server refused the initialized notification.");
  return { call, serverName: clean(init?.serverInfo?.name, 80) };
}

export async function fetchTools(rawUrl: string, token: string | null, deps: McpDeps = {}): Promise<{ serverName: string; tools: RemoteTool[] }> {
  const session = await openSession(rawUrl, token, TEST_TIMEOUT_MS, deps);
  const tools: RemoteTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = (await session.call("tools/list", cursor ? { cursor } : undefined)) as { tools?: unknown; nextCursor?: unknown } | undefined;
    if (!Array.isArray(result?.tools)) throw new McpClientError("The server did not return a tool list.");
    for (const t of result.tools as Record<string, unknown>[]) {
      const name = clean(t?.name, 128);
      if (!name || tools.some((x) => x.name === name)) continue;
      const schema = t.inputSchema && typeof t.inputSchema === "object" && !Array.isArray(t.inputSchema) ? (t.inputSchema as Record<string, unknown>) : { type: "object" };
      const notes = t.annotations && typeof t.annotations === "object" && !Array.isArray(t.annotations) ? (t.annotations as Record<string, unknown>) : {};
      tools.push({
        name,
        description: clean(t.description, 500),
        inputSchema: JSON.stringify(schema).length <= 4096 ? schema : { type: "object" },
        ...(typeof notes.readOnlyHint === "boolean" ? { readOnlyHint: notes.readOnlyHint } : {}),
        ...(typeof notes.destructiveHint === "boolean" ? { destructiveHint: notes.destructiveHint } : {}),
      });
      if (tools.length >= MAX_TOOLS) return { serverName: session.serverName, tools };
    }
    if (typeof result.nextCursor !== "string" || !result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return { serverName: session.serverName, tools };
}

/** Flattens the MCP content array to plain text. Non-text items are dropped, never interpreted. */
export function resultToText(result: unknown): CallResult {
  const r = (result ?? {}) as { content?: unknown; isError?: unknown };
  const parts = Array.isArray(r.content)
    ? (r.content as Record<string, unknown>[]).map((c) => (c && c.type === "text" && typeof c.text === "string" ? c.text : "[non-text content omitted]"))
    : [];
  return { text: clean(parts.join("\n"), RESULT_TEXT_CAP), isError: r.isError === true };
}

export async function invokeTool(rawUrl: string, token: string | null, name: string, args: Record<string, unknown>, deps: McpDeps = {}): Promise<CallResult> {
  const session = await openSession(rawUrl, token, CALL_TIMEOUT_MS, deps);
  return resultToText(await session.call("tools/call", { name, arguments: args }));
}
