import { SCOPE_INFO, type Scope } from "@/components/integrations/helpers";

/** Adds the plain-language name after each raw scope in a text, so the guide matches the names in the API key dialog. */
export const withScopeNames = (text: string): string => text.replace(/\b[a-z]+:(?:read|write|manage)\b/g, (code) => (SCOPE_INFO[code as Scope] ? `${code} (${SCOPE_INFO[code as Scope].label})` : code));

export const MCP_TOOL_LIST: { name: string; description: string; scope: string }[] = [
  { name: "list_conversations", description: "List recent conversations with window state.", scope: "conversations:read" },
  { name: "get_conversation_messages", description: "Read the messages of a conversation.", scope: "conversations:read" },
  { name: "search_contacts", description: "Find contacts by name, phone or tag.", scope: "contacts:read" },
  { name: "get_contact", description: "Get one contact with attributes and consent.", scope: "contacts:read" },
  { name: "list_templates", description: "List templates and their status.", scope: "templates:read" },
  { name: "get_report_summary", description: "Message and conversation totals for a date range.", scope: "contacts:read" },
  { name: "send_text_reply", description: "Draft, or with confirm send, a free-text reply inside the 24-hour window.", scope: "conversations:read + messages:write to send" },
  { name: "send_template_message", description: "Draft, or with confirm send, an approved template.", scope: "templates:read + messages:write to send" },
  { name: "add_contact_tag", description: "Add a tag to a contact.", scope: "contacts:write" },
  { name: "set_conversation_status", description: "Open, pend, solve or block a conversation.", scope: "conversations:write" },
  { name: "assign_conversation", description: "Assign or unassign a conversation.", scope: "conversations:write" },
  { name: "create_broadcast_draft", description: "Save a broadcast draft. Never starts it.", scope: "messages:write" },
];

export function mcpSnippets(url: string): { title: string; code: string }[] {
  return [
    { title: "Claude Code (command line)", code: `claude mcp add --transport http edwyz-wa ${url} --header "Authorization: Bearer YOUR_API_KEY"` },
    {
      title: "Claude Desktop or any client that reads .mcp.json",
      code: JSON.stringify({ mcpServers: { "edwyz-wa": { type: "http", url, headers: { Authorization: "Bearer YOUR_API_KEY" } } } }, null, 2),
    },
    {
      title: "Generic client using the mcp-remote bridge",
      code: JSON.stringify({ mcpServers: { "edwyz-wa": { command: "npx", args: ["-y", "mcp-remote", url, "--header", "Authorization:${EDWYZ_AUTH}"], env: { EDWYZ_AUTH: "Bearer YOUR_API_KEY" } } } }, null, 2),
    },
    {
      title: "Test with curl",
      code: `curl -X POST ${url} \\\n  -H "Authorization: Bearer YOUR_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -H "Accept: application/json, text/event-stream" \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
    },
  ];
}
