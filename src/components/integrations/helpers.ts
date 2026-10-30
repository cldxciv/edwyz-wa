export const SCOPES = ["messages:write", "contacts:read", "contacts:write", "templates:read", "conversations:read", "conversations:write", "broadcasts:read", "webhooks:manage"] as const;

export type Scope = (typeof SCOPES)[number];

/** Plain-language names for API permissions. The raw scope stays available for developers under "Details". */
export const SCOPE_INFO: Record<Scope, { label: string; description: string }> = {
  "messages:write": { label: "Send messages", description: "Send WhatsApp messages and approved templates to your contacts." },
  "contacts:read": { label: "View contacts", description: "Read your contact list." },
  "contacts:write": { label: "Add and update contacts", description: "Create contacts and change their details and opt-in status." },
  "templates:read": { label: "View message templates", description: "Read your templates and whether Meta approved them." },
  "conversations:read": { label: "View conversations", description: "Read chats and the messages in them." },
  "conversations:write": { label: "Manage conversations", description: "Change a chat's status, assign it to a teammate and tag it. Also lets the key read chats and send text replies." },
  "broadcasts:read": { label: "View broadcasts", description: "Read your broadcasts and how they performed." },
  "webhooks:manage": { label: "Manage webhooks", description: "Create and change webhook endpoints through the API." },
};

export const scopeLabel = (scope: string): string => SCOPE_INFO[scope as Scope]?.label ?? scope;

export const DEFAULT_SCOPES: Scope[] = ["messages:write"];

const EVENT_LABELS: Record<string, { label: string; description: string }> = {
  "message.received": { label: "A customer sends a message", description: "Includes the message and who sent it." },
  "message.status": { label: "A message is delivered, read or fails", description: "Follow what happened to messages you sent." },
  "template.status": { label: "A template is approved or rejected", description: "Meta reviewed one of your message templates." },
  "broadcast.completed": { label: "A broadcast finishes", description: "All recipients have been processed." },
  "contact.opted_out": { label: "A contact opts out", description: "Someone asked to stop receiving messages." },
  "conversation.status_changed": { label: "A chat changes status", description: "A chat was opened, set to pending, solved or blocked." },
  "lead.created": { label: "A new lead arrives", description: "Someone filled in one of your Meta lead forms." },
  "webhook.test": { label: "Test event", description: "Sent by you to check the endpoint." },
};

export function eventLabel(event: string): string {
  return EVENT_LABELS[event]?.label ?? event.replace(/[._]/g, " ").replace(/^./, (c) => c.toUpperCase());
}

export const eventDescription = (event: string): string | undefined => EVENT_LABELS[event]?.description;

/** Kept for older callers. New code should render StatusPill, which uses the one status map. */
export function statusTone(status: string): "good" | "bad" | "warn" | "neutral" {
  if (status === "delivered") return "good";
  if (status === "failed") return "bad";
  if (status === "retrying") return "warn";
  return "neutral";
}

/**
 * Status key and label for a webhook delivery, in words a non-developer understands. The key is one the central status map
 * already knows, so the colour matches the rest of the app: queued is blue (waiting on the system), retry is amber.
 */
export function deliveryDisplay(status: string): { status: string; label: string } {
  switch (status) {
    case "delivered":
      return { status: "delivered", label: "Delivered" };
    case "failed":
      return { status: "failed", label: "Failed" };
    case "retrying":
      return { status: "retry", label: "Will retry" };
    case "pending":
      return { status: "queued", label: "Waiting to send" };
    default:
      return { status: "unknown", label: status ? status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, " ") : "Unknown" };
  }
}

/** True while any delivery is still waiting or will be retried, so the list should keep refreshing. */
export function hasUnsettledDeliveries(deliveries: readonly { status: string }[] | null | undefined): boolean {
  return !!deliveries?.some((d) => d.status === "pending" || d.status === "retrying");
}

/** One sentence for screen readers after the list refreshes. */
export function deliverySummary(deliveries: readonly { status: string }[]): string {
  if (deliveries.length === 0) return "No deliveries yet.";
  const waiting = deliveries.filter((d) => d.status === "pending" || d.status === "retrying").length;
  const noun = deliveries.length === 1 ? "delivery" : "deliveries";
  return waiting > 0 ? `${deliveries.length} ${noun}, ${waiting} still waiting.` : `${deliveries.length} ${noun}, all finished.`;
}

/** Why the endpoint was switched off, or null when it is working as intended. */
export function endpointNotice(ep: { enabled: boolean; failureCount: number }): string | null {
  if (!ep.enabled && ep.failureCount >= 20) return "Turned off automatically after repeated failures. Fix the receiving server, then switch it back on.";
  return null;
}

/** Inline error for the endpoint address field, or null when it looks fine. */
export function webhookUrlError(value: string): string | null {
  const v = value.trim();
  if (!v) return "Enter the address that should receive events.";
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return "Enter a full address, like https://example.com/webhooks/edwyz.";
  }
  if (url.protocol !== "https:") return "The address must start with https://. Plain http is not allowed.";
  if (url.port && url.port !== "443" && url.port !== "8443") return "Only port 443 or 8443 is allowed.";
  return null;
}

export function keyNameError(value: string): string | null {
  const v = value.trim();
  if (!v) return "Give the key a name so you can recognise it later.";
  if (v.length > 60) return "Use 60 characters or fewer.";
  return null;
}

const HOST = "https://wa.edwyz.com";

export const DOC_SNIPPETS: { title: string; code: string }[] = [
  {
    title: "Send a template message",
    code: `curl -X POST ${HOST}/api/v1/messages \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"to":"+CCXXXXXXXXXX","type":"template","template":{"name":"TEMPLATE_NAME","language":"en"}}'`,
  },
  {
    title: "Send a text message (only inside the 24-hour window)",
    code: `curl -X POST ${HOST}/api/v1/messages \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"to":"+CCXXXXXXXXXX","type":"text","text":"YOUR_MESSAGE"}'`,
  },
  {
    title: "Add or update a contact",
    code: `curl -X POST ${HOST}/api/v1/contacts \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"phone":"+CCXXXXXXXXXX","name":"NAME","optIn":true,"optInSource":"WHERE_THEY_AGREED"}'`,
  },
  {
    title: "List contacts and templates",
    code: `curl ${HOST}/api/v1/contacts -H "Authorization: Bearer YOUR_API_KEY"
curl ${HOST}/api/v1/templates -H "Authorization: Bearer YOUR_API_KEY"`,
  },
  {
    title: "Verify a webhook signature",
    code: `# X-Edwyz-Signature = "sha256=" + HMAC_SHA256(secret, X-Edwyz-Timestamp + "." + raw_body)
# Reject requests whose timestamp is more than 5 minutes old.`,
  },
];
