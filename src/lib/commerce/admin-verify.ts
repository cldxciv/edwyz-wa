import { pinnedTransport, type PinnedTransport } from "@/lib/creative/pinned";
import { assertPublicUrl, defaultResolver, type Resolver } from "@/lib/integrations/ssrf";
import { HttpError } from "@/lib/tenancy";

const TIMEOUT_MS = 8_000;
const MAX_BYTES = 64 * 1024;
const TOKEN = /^[A-Za-z0-9_-]{8,200}$/;

/** Exactly a lowercase shop handle on myshopify.com: no port, userinfo, path, IP address or extra labels. */
export const SHOP_HOST = /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/;
const apiVersion = () => (/^\d{4}-\d{2}$/.test(process.env.SHOPIFY_ADMIN_API_VERSION ?? "") ? process.env.SHOPIFY_ADMIN_API_VERSION! : "2024-10");

/** Every failure of the ownership check is a 422 with a message the store owner can act on. */
const fail = (message: string) => new HttpError(422, message);

export const isAdminToken = (value: unknown): value is string => typeof value === "string" && TOKEN.test(value.trim());

const DNS_TIMEOUT_MS = 3_000;
const MAX_ATTEMPTS = 2;
const TRUNCATED_AT = MAX_BYTES - 3;

const UNREACHABLE = "Could not reach Shopify to verify the store. Try again in a moment.";

/** Name resolution gets its own limit, so a slow resolver cannot hang the request before the 8 s HTTPS limit even starts. */
function withDnsTimeout(resolve: Resolver): Resolver {
  return (hostname) =>
    new Promise<string[]>((done, reject) => {
      const timer = setTimeout(() => reject(new Error("dns timeout")), DNS_TIMEOUT_MS);
      timer.unref?.();
      resolve(hostname).then(
        (value) => {
          clearTimeout(timer);
          done(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
}

/** IPv4 first: a host without a working IPv6 route would otherwise lose its attempt on a leading AAAA record. */
const preferV4 = (addresses: string[]) => [...addresses.filter((a) => !a.includes(":")), ...addresses.filter((a) => a.includes(":"))];

/**
 * Proof that the caller controls the shop. A webhook signature made with a secret the caller chose proves nothing, but an Admin API token
 * is only accepted by the shop it was issued for, so Shopify answering shop.json with this domain is real evidence. The request goes to
 * the shop's own host through the pinned transport (https only, port 443, address validated, no redirects, 8 s in total, 64 KB). When a
 * connection to one validated address fails outright the next one is tried inside the same 8 s; an HTTP answer is never retried. The token
 * is sent only in that request header and never logged; callers store it sealed and never return it.
 */
export async function verifyShopOwnership(
  shopDomain: string,
  accessToken: string,
  deps: { transport?: PinnedTransport; resolve?: Resolver } = {},
): Promise<void> {
  if (typeof shopDomain !== "string" || !SHOP_HOST.test(shopDomain)) throw fail("Enter the store's myshopify.com address, for example my-store.myshopify.com.");
  const token = typeof accessToken === "string" ? accessToken.trim() : "";
  if (!TOKEN.test(token)) throw fail("The Admin API access token looks invalid. Copy it again from the custom app in your Shopify admin.");
  const transport = deps.transport ?? pinnedTransport;
  let res: { status: number; body: string } | null = null;
  try {
    const safe = await assertPublicUrl(`https://${shopDomain}/admin/api/${apiVersion()}/shop.json`, withDnsTimeout(deps.resolve ?? defaultResolver));
    const started = Date.now();
    let attempts = 0;
    for (const address of preferV4(safe.addresses).slice(0, MAX_ATTEMPTS)) {
      const remaining = TIMEOUT_MS - (Date.now() - started);
      if (attempts > 0 && remaining < 1_000) break;
      attempts += 1;
      try {
        res = await transport({
          url: safe.url,
          address,
          timeoutMs: attempts === 1 ? TIMEOUT_MS : remaining,
          maxBytes: MAX_BYTES,
          userAgent: "EdwyzWA/1.0 (+https://wa.edwyz.com)",
          headers: { accept: "application/json", "x-shopify-access-token": token },
        });
        break;
      } catch {
        // try the next validated address while time remains
      }
    }
  } catch {
    throw fail(UNREACHABLE);
  }
  if (!res) throw fail(UNREACHABLE);
  const { status, body } = res;
  if (status === 401 || status === 403) throw fail("Shopify rejected the access token for this store. Check that it belongs to this shop and has not been revoked.");
  if (status < 200 || status >= 300) throw fail("Shopify could not verify the store right now. Try again in a moment.");
  if (Buffer.byteLength(body, "utf8") >= TRUNCATED_AT) throw fail(UNREACHABLE);
  let reported: unknown;
  try {
    reported = (JSON.parse(body) as { shop?: { myshopify_domain?: unknown } }).shop?.myshopify_domain;
  } catch {
    throw fail("Shopify sent an answer that could not be read, so the store could not be verified. Try again in a moment.");
  }
  if (typeof reported !== "string" || reported.trim().toLowerCase() !== shopDomain) throw fail("Shopify says this token belongs to a different store, so the domain does not match. Use the token from the store you are connecting.");
}
