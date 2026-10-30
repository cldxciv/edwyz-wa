import { route } from "@/lib/compat/handlers";

export const dynamic = "force-dynamic";

export const GET = route("contacts.list");
export const POST = route("contacts.create");
