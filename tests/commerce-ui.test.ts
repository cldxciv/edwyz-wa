import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StoreSection } from "@/components/commerce/StoreSection";
import {
  DEFAULT_GAPS_MIN,
  WEBHOOKS,
  accessTokenError,
  cartStatusView,
  formatMinutes,
  friendlyError,
  gapErrors,
  lateReminders,
  maskPhone,
  money,
  needsAccessToken,
  parseGap,
  parseShopDomain,
  scheduleRows,
  secretError,
  shopDomainError,
  stageLabel,
  storeAnnouncement,
  storeView,
} from "@/components/commerce/helpers";
import { normalizeShopDomain } from "@/lib/commerce/shop";

describe("webhook guide", () => {
  it("lists exactly the three topics the server handles", () => {
    expect(WEBHOOKS.map((w) => w.topic)).toEqual(["checkouts/create", "checkouts/update", "orders/create"]);
    expect(WEBHOOKS.map((w) => w.event)).toEqual(["Checkout creation", "Checkout update", "Order creation"]);
  });
});

describe("store address", () => {
  it("accepts what people paste and agrees with the server", () => {
    for (const input of ["my-store.myshopify.com", "  My-Store.myshopify.com ", "https://my-store.myshopify.com/admin/settings", "http://my-store.myshopify.com?x=1"]) {
      const parsed = parseShopDomain(input);
      expect(parsed).toBe("my-store.myshopify.com");
      expect(normalizeShopDomain(parsed)).toBe(parsed);
    }
  });
  it("rejects anything else with a helpful message", () => {
    expect(parseShopDomain("shop.example.com")).toBeNull();
    expect(parseShopDomain("")).toBeNull();
    expect(shopDomainError("")).toMatch(/enter your store address/i);
    expect(shopDomainError("shop.example.com")).toMatch(/myshopify\.com/);
    expect(shopDomainError("my-store.myshopify.com")).toBeNull();
  });
});

describe("store address from the current Shopify admin link", () => {
  it("turns admin.shopify.com/store/<handle> links into the myshopify.com address", () => {
    for (const input of ["https://admin.shopify.com/store/my-store", "https://admin.shopify.com/store/My-Store/settings/notifications", "admin.shopify.com/store/my-store?foo=1", "  http://admin.shopify.com/store/my-store#x "]) {
      const parsed = parseShopDomain(input);
      expect(parsed).toBe("my-store.myshopify.com");
      expect(normalizeShopDomain(parsed)).toBe(parsed);
    }
    expect(shopDomainError("https://admin.shopify.com/store/my-store/products")).toBeNull();
  });
  it("still rejects admin links without a store and other hosts", () => {
    expect(parseShopDomain("https://admin.shopify.com")).toBeNull();
    expect(parseShopDomain("https://admin.shopify.com/store/")).toBeNull();
    expect(parseShopDomain("https://admin.shopify.com.evil.com/store/my-store")).toBeNull();
  });
});

describe("signing secret", () => {
  it("mirrors the server rules", () => {
    expect(secretError("")).toMatch(/paste/i);
    expect(secretError("abc def ghij")).toMatch(/spaces/i);
    expect(secretError("short")).toMatch(/too short/i);
    expect(secretError("x".repeat(301))).toMatch(/too long/i);
    expect(secretError("  abcdefgh12345678  ")).toBeNull();
  });
});

describe("store status", () => {
  it("explains verification in words", () => {
    expect(storeView({ status: "active", verified: true })).toMatchObject({ label: "Verified", tone: "good", pending: false });
    expect(storeView({ status: "pending_verification", verified: false })).toMatchObject({ label: "Waiting for Shopify", tone: "warn", pending: true });
    expect(storeView({ status: "disabled" })).toMatchObject({ label: "Paused", tone: "neutral", pending: false });
  });
});

describe("store status announcements", () => {
  it("says what changed in a sentence a screen reader can read", () => {
    expect(storeAnnouncement("a.myshopify.com", storeView({ status: "active", verified: true }))).toBe("a.myshopify.com is verified");
    expect(storeAnnouncement("a.myshopify.com", storeView({ status: "disabled" }))).toBe("a.myshopify.com is paused");
    expect(storeAnnouncement("a.myshopify.com", storeView({ status: "pending_verification" }))).toBe("a.myshopify.com is waiting for Shopify to confirm the connection");
  });
});

describe("reminder schedule", () => {
  it("formats minutes in words", () => {
    expect(formatMinutes(30)).toBe("30 minutes");
    expect(formatMinutes(60)).toBe("1 hour");
    expect(formatMinutes(390)).toBe("6 hours 30 minutes");
    expect(formatMinutes(1440)).toBe("1 day");
  });
  it("counts each gap from the previous reminder, like the server does", () => {
    const rows = scheduleRows(DEFAULT_GAPS_MIN.cart);
    expect(rows.map((r) => r.total)).toEqual([30, 390, 1830]);
    expect(rows[0].gapLabel).toBe("30 minutes after");
    expect(rows[1].gapLabel).toBe("6 hours later");
    expect(rows.some((r) => r.late)).toBe(false);
  });
  it("warns about reminders that would land after carts expire", () => {
    expect(lateReminders([4320, 2000, 1])).toEqual([2, 3]);
    expect(lateReminders(DEFAULT_GAPS_MIN.checkout)).toEqual([]);
  });
  it("validates gaps like the server (whole minutes, 1 to 4320)", () => {
    expect(gapErrors([30, 360, 1440])).toEqual([null, null, null]);
    const [zero, big, ok] = gapErrors([0, 4321, 5]);
    expect(zero).toMatch(/at least 1 minute/i);
    expect(big).toMatch(/3 days/);
    expect(ok).toBeNull();
    expect(parseGap("")).toBe(0);
    expect(parseGap("45.9")).toBe(45);
  });
});

describe("cart display", () => {
  it("maps outcomes to human wording", () => {
    expect(cartStatusView("opted_out").label).toBe("Not opted in");
    expect(cartStatusView("recovered")).toMatchObject({ label: "Recovered", tone: "good" });
    expect(cartStatusView("mystery_state").label).toBe("Mystery state");
    expect(stageLabel("cart")).toBe("Added to cart");
    expect(stageLabel("checkout")).toBe("Started checkout");
  });
  it("hides most of a phone number and handles missing values", () => {
    expect(maskPhone("+919876543210")).toBe("+919******210");
    expect(maskPhone(null)).toBe("Not shared");
    expect(money(null, "INR")).toBe("Not shown");
    expect(money(123456, "INR")).toMatch(/^INR\s/);
  });
});

describe("friendlyError", () => {
  it("keeps server messages and rewrites network failures", () => {
    expect(friendlyError(new Error("This store is already connected."))).toBe("This store is already connected.");
    expect(friendlyError(new TypeError("Failed to fetch"))).toMatch(/check your connection/i);
  });
});

describe("Admin API access token", () => {
  it("accepts what the server accepts and explains the rest", () => {
    expect(accessTokenError("shpat_0123456789abcdef")).toBeNull();
    expect(accessTokenError("  shpat_0123456789abcdef  ")).toBeNull();
    expect(accessTokenError("")).toMatch(/paste the admin api access token/i);
    expect(accessTokenError("shpat 0123456789")).toMatch(/no spaces/i);
    expect(accessTokenError("short")).toMatch(/does not look like/i);
    expect(accessTokenError("a".repeat(201))).toMatch(/does not look like/i);
  });

  it("recognises the server refusing a change for want of a token", () => {
    expect(needsAccessToken(new Error("Paste the store's Admin API access token to verify it."))).toBe(true);
    expect(needsAccessToken(new Error("Another workspace is verifying this store right now."))).toBe(false);
    expect(needsAccessToken("nope")).toBe(false);
  });
});

describe("Shopify connect form", () => {
  it("keeps password managers out: no saved login lands in the store address or the secrets", () => {
    const html = renderToStaticMarkup(createElement(StoreSection, { stores: [], editable: true, webhookUrl: "https://wa.example.com/api/commerce/shopify/webhook", onSelect: () => {}, onChange: () => {} }));
    const inputs = [...html.matchAll(/<input[^>]*>/g)].map((m) => m[0]);
    const store = inputs.find((i) => i.includes('name="shopify-store"'));
    const secrets = inputs.filter((i) => i.includes('type="password"'));
    expect(store).toBeDefined();
    expect(store).toMatch(/autoComplete="off"|autocomplete="off"/i);
    expect(store).toContain('data-1p-ignore=""');
    expect(secrets).toHaveLength(2);
    for (const input of secrets) {
      expect(input).toMatch(/autocomplete="new-password"/i);
      expect(input).toContain('data-1p-ignore=""');
      expect(input).toContain('data-lpignore="true"');
    }
  });
});
