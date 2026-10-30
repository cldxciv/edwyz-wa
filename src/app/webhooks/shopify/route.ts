import { prisma } from "@/lib/db";
import { readTextLimited } from "@/lib/http/body";
import { checkoutIdsFromOrder, ingestCheckout, markRecovered, parseCheckout } from "@/lib/commerce/cart";
import { normalizeShopDomain, verifyShopifyHmac } from "@/lib/commerce/shop";
import { storeWebhookSecret } from "@/lib/commerce/stores";
import { bodyDigest, forgetDelivery, isRecentlyMissing, isStaleEvent, parseWebhookId, purgeOldWebhookIds, recordDelivery, rememberMissing } from "@/lib/commerce/webhook-guard";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 512 * 1024;
const HANDLED_TOPICS = new Set(["checkouts/create", "checkouts/update", "orders/create"]);
const noStore = { "Cache-Control": "no-store" };
const reply = (body: string, status: number) => new Response(body, { status, headers: noStore });

export async function POST(request: Request) {
  let rawBody: string;
  try {
    rawBody = await readTextLimited(request, MAX_BODY_BYTES);
  } catch {
    return reply("Payload too large", 413);
  }

  const shopDomain = normalizeShopDomain(request.headers.get("x-shopify-shop-domain"));
  if (!shopDomain) return reply("Unauthorized", 401);

  if (isRecentlyMissing(shopDomain)) return reply("Unauthorized", 401);
  const candidates = await prisma.shopifyStore.findMany({
    where: { shopDomain, status: "active" },
    orderBy: { createdAt: "asc" },
    select: { id: true, tenantId: true, webhookSecretEnc: true },
    take: 20,
  });
  if (candidates.length === 0) {
    rememberMissing(shopDomain);
    return reply("Unauthorized", 401);
  }
  const signature = request.headers.get("x-shopify-hmac-sha256");
  const store = candidates.find((s) => verifyShopifyHmac(rawBody, signature, storeWebhookSecret(s)));
  if (!store) {
    console.warn("[shopify] rejected a webhook with a missing or invalid signature");
    return reply("Unauthorized", 401);
  }

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return reply("Bad request", 400);
    body = parsed as Record<string, unknown>;
  } catch {
    return reply("Bad request", 400);
  }

  if (isStaleEvent(body)) return reply("OK", 200);
  // The topic header is not signed. Topics the app does not act on are acknowledged before the replay guard, so they never use up the
  // digest of a body that a handled delivery may carry later (that one would be dropped as a duplicate and a recovered cart missed).
  const topic = request.headers.get("x-shopify-topic");
  if (!topic || !HANDLED_TOPICS.has(topic)) return reply("OK", 200);
  const delivery = { digest: bodyDigest(rawBody), webhookId: parseWebhookId(request.headers.get("x-shopify-webhook-id")) };
  void purgeOldWebhookIds();
  if ((await recordDelivery(store.id, delivery)) === "duplicate") return reply("OK", 200);

  const scope = { tenantId: store.tenantId, storeId: store.id };
  try {
    if (topic === "checkouts/create" || topic === "checkouts/update") {
      const cart = parseCheckout(body);
      if (cart) await ingestCheckout(scope, cart);
    } else if (topic === "orders/create") {
      await markRecovered(scope, checkoutIdsFromOrder(body));
    }
  } catch {
    console.error("[shopify] processing failed, asking Shopify to retry");
    await forgetDelivery(store.id, delivery).catch(() => undefined);
    return reply("Temporarily unavailable", 500);
  }
  return reply("OK", 200);
}
