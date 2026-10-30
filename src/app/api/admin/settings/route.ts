import { handleAdmin, readBody } from "@/lib/admin/http";
import { saveSettings } from "@/lib/admin/settings";
import { getSettings } from "@/lib/platform-settings";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleAdmin(request, false, async () => ({ settings: await getSettings() }), "admin.api.view_settings");
}

export async function PUT(request: Request) {
  return handleAdmin(request, true, async ({ actor }) => ({ settings: await saveSettings(actor.userId, await readBody(request)) }));
}

export { adminMethodNotAllowed as POST, adminMethodNotAllowed as PATCH, adminMethodNotAllowed as DELETE, adminMethodNotAllowed as OPTIONS } from "@/lib/admin/http";
