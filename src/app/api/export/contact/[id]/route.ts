import { exportContact, contactExportCsv } from "@/lib/lifecycle/export-contact";
import { adminActor } from "@/lib/reports/http";
import { download } from "@/lib/reports/export";
import { errorResponse } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

const encoder = new TextEncoder();
const once = (text: string) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });

/**
 * Personal-data export for one contact (owner or admin). ?format=json (default) is the full record; ?format=csv is the message history.
 * The filename carries the contact id, never the phone number or name.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await adminActor(request);
    const id = (await params).id;
    const format = new URL(request.url).searchParams.get("format") === "csv" ? "csv" : "json";
    const data = await exportContact(actor, id, format);
    return format === "csv"
      ? download(once(contactExportCsv(data)), `contact-${data.contact.id}.csv`, "text/csv; charset=utf-8")
      : download(once(JSON.stringify(data)), `contact-${data.contact.id}.json`, "application/json; charset=utf-8");
  } catch (e) {
    return errorResponse(e);
  }
}
