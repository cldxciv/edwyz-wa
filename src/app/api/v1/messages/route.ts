import { v1 } from "@/lib/integrations/v1";
import { sendMessageV1 } from "@/lib/integrations/v1-service";

export const dynamic = "force-dynamic";

/**
 * POST { to, type: "text" | "template", text?, template?: { name, language, components? }, from?: <Meta phone_number_id> }
 * -> 202 { id, conversationId, status }. Text needs an open 24-hour window (409 otherwise); opted-out contacts get 422.
 * Auth: Authorization: Bearer wak_..., scope messages:write. 60 requests per minute per key.
 */
export function POST(request: Request) {
  return v1(request, "messages:write", true, async ({ actor, body }) => ({ status: 202, json: await sendMessageV1(actor, await body()) }));
}
