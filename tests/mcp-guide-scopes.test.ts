import { describe, expect, it } from "vitest";
import { SCOPE_INFO } from "@/components/integrations/helpers";
import { MCP_TOOL_LIST, withScopeNames } from "@/components/mcp/helpers";
import { TOOLS } from "@/lib/tenant-mcp/tools";

describe("MCP guide scope names", () => {
  it("shows the friendly name next to each raw scope", () => {
    expect(withScopeNames("contacts:read")).toBe(`contacts:read (${SCOPE_INFO["contacts:read"].label})`);
    expect(withScopeNames("conversations:read + messages:write to send")).toBe(
      `conversations:read (${SCOPE_INFO["conversations:read"].label}) + messages:write (${SCOPE_INFO["messages:write"].label}) to send`,
    );
    expect(withScopeNames("nothing:here")).toBe("nothing:here");
  });

  it("lists the same tool names as the server", () => {
    expect(MCP_TOOL_LIST.map((t) => t.name).sort()).toEqual(TOOLS.map((t) => t.name).sort());
  });
});
