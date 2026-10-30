import { v1 } from "@/lib/integrations/v1";
import { listTemplatesV1 } from "@/lib/integrations/v1-service";

export const dynamic = "force-dynamic";

/** GET ?status= -> { templates: [{ name, language, category, status, components }] }. Scope templates:read. */
export function GET(request: Request) {
  return v1(request, "templates:read", false, async ({ actor }) => ({ json: await listTemplatesV1(actor, new URL(request.url).searchParams) }));
}
