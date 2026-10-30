import { v1 } from "@/lib/integrations/v1";
import { listContactsV1, upsertContactV1 } from "@/lib/integrations/v1-service";

export const dynamic = "force-dynamic";

/** GET ?q=&tag=&cursor=&limit= -> { contacts, nextCursor }. Scope contacts:read. */
export function GET(request: Request) {
  return v1(request, "contacts:read", false, async ({ actor }) => ({ json: await listContactsV1(actor, new URL(request.url).searchParams) }));
}

/** POST { phone, name?, tags?, attributes?, optIn?, optInSource? } upsert -> 201 or 200 { created, contact }. Scope contacts:write. */
export function POST(request: Request) {
  return v1(request, "contacts:write", true, async ({ actor, body }) => {
    const result = await upsertContactV1(actor, await body());
    return { status: result.created ? 201 : 200, json: result };
  });
}
