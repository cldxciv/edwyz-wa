import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const jar = vi.hoisted(() => ({ cookies: [] as { name: string; value: string }[], throwOutsideRequest: false }));
vi.mock("next/headers", () => ({
  cookies: async () => {
    if (jar.throwOutsideRequest) throw new Error("`cookies` was called outside a request scope");
    return { getAll: () => jar.cookies };
  },
}));
const auth = vi.hoisted(() => ({ getActor: vi.fn() }));
vi.mock("@/lib/auth", () => auth);
const db = vi.hoisted(() => ({ user: { findUnique: vi.fn() } }));
vi.mock("@/lib/db", () => ({ prisma: db }));

import LoginPage from "@/app/(auth)/login/page";
import SignupPage from "@/app/(auth)/signup/page";
import ForgotPasswordPage from "@/app/(auth)/forgot-password/page";
import { SignedInNotice } from "@/components/site/signed-in-notice";
import { signedInUser } from "@/lib/auth/signed-in";
import { RESET_EMAIL_UNAVAILABLE, VERIFY_EMAIL_UNAVAILABLE, emailConfigured } from "@/lib/email/availability";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const login = async (next?: string) => html(await LoginPage({ searchParams: Promise.resolve({ next }) }));
const saved = { ...process.env };

function signedIn(email = "owner@shop.in") {
  jar.cookies = [{ name: "wa_access", value: "token" }];
  auth.getActor.mockResolvedValue({ userId: "u1", tenantId: "t1", role: "owner" });
  db.user.findUnique.mockResolvedValue({ email });
}

beforeEach(() => {
  jar.cookies = [];
  jar.throwOutsideRequest = false;
  auth.getActor.mockReset();
  db.user.findUnique.mockReset();
  process.env.SMTP_USER = "smtp-user";
});
afterEach(() => {
  process.env = { ...saved };
});

describe("who is signed in", () => {
  it("returns the email of the live session, found through the cookie header", async () => {
    signedIn("asha@shop.in");
    expect(await signedInUser()).toEqual({ email: "asha@shop.in" });
    const request = auth.getActor.mock.calls[0][0] as Request;
    expect(request.headers.get("cookie")).toBe("wa_access=token");
    expect(request.method).toBe("GET"); // a locked or unverified workspace still counts as signed in
    expect(db.user.findUnique).toHaveBeenCalledWith({ where: { id: "u1" }, select: { email: true } });
  });

  it("is null without cookies, with a stale session, and outside a request", async () => {
    expect(await signedInUser()).toBeNull();
    expect(auth.getActor).not.toHaveBeenCalled();

    jar.cookies = [{ name: "wa_access", value: "stale" }];
    auth.getActor.mockRejectedValue(new Error("Not signed in."));
    expect(await signedInUser()).toBeNull();

    jar.throwOutsideRequest = true;
    await expect(signedInUser()).resolves.toBeNull();
  });
});

describe("auth pages tell a signed-in person that they are signed in", () => {
  it("login shows who is signed in, a link to the workspace (honouring ?next=) and a sign-out, above the usual form", async () => {
    signedIn();
    const out = await login("/app/inbox");
    expect(out).toContain("You are already signed in as <strong");
    expect(out).toContain("owner@shop.in");
    expect(out).toMatch(/<a[^>]+href="\/app\/inbox"[^>]*>Go to your workspace</);
    expect(out).toMatch(/<button[^>]*>Sign out</);
    expect(out).toContain("<form");
    expect(out).toContain("Welcome back");
    expect(out.indexOf("already signed in")).toBeLessThan(out.indexOf("<form"));
  });

  it("login never sends ?next= off the signed-in areas", async () => {
    signedIn();
    expect(await login("https://evil.example/")).toMatch(/<a[^>]+href="\/app"[^>]*>Go to your workspace</);
  });

  it("signup and forgot password show the same notice", async () => {
    signedIn("asha@shop.in");
    const signup = html(await SignupPage());
    expect(signup).toContain("asha@shop.in");
    expect(signup).toMatch(/sign out first/);
    expect(signup).toContain("<form");
    const forgot = html(await ForgotPasswordPage());
    expect(forgot).toContain("asha@shop.in");
    expect(forgot).toContain("<form");
  });

  it("shows nothing extra to a visitor who is not signed in", async () => {
    for (const out of [await login(), html(await SignupPage()), html(await ForgotPasswordPage())]) {
      expect(out).not.toContain("already signed in");
      expect(out).not.toContain("Sign out");
      expect(out).toContain("<form");
    }
  });

  it("the notice is a client component that posts to the logout route", () => {
    const out = html(createElement(SignedInNotice, { email: "a@b.co", hint: "To use a different account, sign out first." }));
    expect(out).toContain('href="/app"');
    expect(out).toContain("a@b.co");
    expect(out).toContain('type="button"');
  });
});

describe("password reset while email is switched off", () => {
  it("knows when mail can be delivered", () => {
    expect(emailConfigured({ SMTP_USER: "u" })).toBe(true);
    expect(emailConfigured({})).toBe(false);
    expect(emailConfigured({ SMTP_USER: "" })).toBe(false);
  });

  it("says in plain words that reset by email is not available yet and how to get help, and shows no form", async () => {
    delete process.env.SMTP_USER;
    const out = html(await ForgotPasswordPage());
    expect(out).not.toContain("<form");
    expect(out).not.toMatch(/we will send you a link|Check your email/);
    expect(out).toContain("Password reset by email is not available yet.");
    expect(out).toMatch(/<a[^>]+href="mailto:hello@edwyz\.com[^"]*"[^>]*>hello@edwyz\.com</);
    expect(out).toContain("we will help you sign in again");
    expect(out).toMatch(/role="alert"/);
    expect(out.match(/<h1/g)).toHaveLength(1);
    expect(out).toContain('href="/login"');
  });

  it("offers the form with the usual promise once mail can be sent", async () => {
    const out = html(await ForgotPasswordPage());
    expect(out).toContain("<form");
    expect(out).toContain("we will send you a link");
    expect(out).not.toContain("not available yet");
  });

  it("keeps the API messages plain and consistent with the screen", () => {
    for (const text of [RESET_EMAIL_UNAVAILABLE, VERIFY_EMAIL_UNAVAILABLE]) {
      expect(text).toContain("hello@edwyz.com");
      expect(text).not.toMatch(/SMTP|server error|exception/i);
      expect(text).not.toMatch(/sent you|check your (inbox|email)/i);
    }
  });
});
