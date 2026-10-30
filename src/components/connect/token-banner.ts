export type TokenView = { state: "none" | "ok" | "expiring" | "expired" | "rejected"; expiresAt: string | null; daysLeft: number | null; canReconnect?: boolean };
export type BannerContent = { tone: "warn" | "bad"; text: string; action: string | null };

/** Plain-language banner for the WhatsApp connection. Null when nothing needs the person's attention. */
export function tokenBannerContent(view: TokenView | null | undefined): BannerContent | null {
  if (!view || view.state === "none" || view.state === "ok") return null;
  const admin = view.canReconnect !== false;
  const askAdmin = " Ask an owner or admin to reconnect it in Settings.";
  if (view.state === "expiring") {
    const days = view.daysLeft ?? 0;
    const when = days <= 1 ? "tomorrow" : `in ${days} days`;
    return {
      tone: "warn",
      text: `Your WhatsApp connection expires ${when}. Reconnect before then so messages keep flowing; it takes about a minute and keeps your chats and templates.${admin ? "" : askAdmin}`,
      action: admin ? "Reconnect WhatsApp" : null,
    };
  }
  return {
    tone: "bad",
    text: `WhatsApp is disconnected, so messages cannot be sent right now. Messages you send now will show as failed and are not sent again by themselves, so send them again after you reconnect.${admin ? "" : askAdmin}`,
    action: admin ? "Reconnect now" : null,
  };
}

export const RECONNECT_PATH = "/app/settings/connect";
