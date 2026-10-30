import { route } from "@/lib/compat/handlers";

export const dynamic = "force-dynamic";

export const GET = route("webhooks.get");
export const PUT = route("webhooks.update");
export const DELETE = route("webhooks.delete");
