/**
 * WhatsApp connection notices (docs/EDDY-SPEC.md 6.7): token_expiring (heads-up, "expires in {days} days") and
 * token_expired (action needed; also a token Meta refused) with [Reconnect]. Reads getWhatsAppTokenHealth, no Meta call.
 * Skipped in the demo workspace, which has no token by design (6.14). When the connection is fine again, or there is none
 * (the setup step covers that), both resolve.
 */
import { getWhatsAppTokenHealth, type TokenHealth } from "@/lib/onboarding/token-health";
import { act, dedupe } from "../kinds";
import type { NoticeProducer } from "../scan";

export type TokenHealthReader = (tenantId: string, now: Date) => Promise<TokenHealth>;
let read: TokenHealthReader = getWhatsAppTokenHealth;
/** Test seam. */
export function setTokenHealthReader(fn: TokenHealthReader | null): void {
  read = fn ?? getWhatsAppTokenHealth;
}

export const producer: NoticeProducer = {
  name: "token",
  kinds: ["token_expiring", "token_expired"],
  skipDemo: true,
  async run(ctx) {
    const health = await read(ctx.tenantId, ctx.now);
    const keep: string[] = [];
    let published = 0;
    if (health.state === "expiring" || health.state === "expired" || health.state === "rejected") {
      const expiring = health.state === "expiring";
      const key = dedupe.token(expiring ? "expiring" : "expired");
      keep.push(key);
      const r = await ctx.publish({
        kind: expiring ? "token_expiring" : "token_expired",
        severity: expiring ? "heads_up" : "action_needed",
        dedupeKey: key,
        audience: { minRole: "admin" },
        payload: { state: health.state, daysLeft: health.daysLeft ?? null },
        actions: [act.go("/app/settings/connect", "btn.reconnect")],
      });
      if (r.outcome === "created" || r.outcome === "reopened" || r.outcome === "updated") published++;
    }
    const resolved = await ctx.resolve({ kinds: ["token_expiring", "token_expired"], except: keep });
    return { published, resolved };
  },
};
