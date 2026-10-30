import { route } from "@/lib/compat/handlers";

export const dynamic = "force-dynamic";

export const GET = route("webhooks.list");
export const POST = route("webhooks.create");
