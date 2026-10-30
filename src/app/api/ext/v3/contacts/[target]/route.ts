import { route } from "@/lib/compat/handlers";

export const dynamic = "force-dynamic";

export const GET = route("contacts.get");
export const PUT = route("contacts.update");
export const DELETE = route("contacts.delete");
