import { handleMcpPost, methodNotAllowed } from "@/lib/tenant-mcp/server";

export const dynamic = "force-dynamic";

/** Tenant-scoped MCP server (Streamable HTTP, JSON responses). Bearer auth with a workspace API key (wak_). */
export function POST(request: Request) {
  return handleMcpPost(request);
}

export const GET = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const PUT = methodNotAllowed;
