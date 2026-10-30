import { handleAdmin, readBody } from "@/lib/admin/http";
import { sendTestMessage } from "@/lib/admin/service";
import { parseTestMessageInput } from "@/lib/admin/testMessage";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleAdmin(request, true, async ({ actor }) => sendTestMessage(actor.userId, parseTestMessageInput(await readBody(request))));
}

export { adminMethodNotAllowed as GET, adminMethodNotAllowed as HEAD, adminMethodNotAllowed as PUT, adminMethodNotAllowed as PATCH, adminMethodNotAllowed as DELETE, adminMethodNotAllowed as OPTIONS } from "@/lib/admin/http";
