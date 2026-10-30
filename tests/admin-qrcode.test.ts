import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { QrCode } from "@/components/admin/QrCode";
import { otpauthUri } from "@/lib/admin/totp";

const render = (value: string, label = "QR code for your authenticator app") => renderToStaticMarkup(createElement(QrCode, { value, label }));

describe("QrCode", () => {
  it("draws the authenticator setup link as an inline SVG image with an accessible name", () => {
    const html = render(otpauthUri("JBSWY3DPEHPK3PXP", "admin@example.com"));
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="QR code for your authenticator app"');
    expect(html).toMatch(/<svg[^>]*viewBox/);
    expect(html).toContain("<path");
  });

  it("keeps the secret out of the markup text (it is encoded in the picture, not written as text)", () => {
    expect(render(otpauthUri("JBSWY3DPEHPK3PXP", "admin@example.com"), "QR")).not.toContain("JBSWY3DPEHPK3PXP");
  });

  it("is deterministic for the same input and different for another", () => {
    const a = render("otpauth://totp/a?secret=AAAA", "x");
    expect(render("otpauth://totp/a?secret=AAAA", "x")).toBe(a);
    expect(render("otpauth://totp/a?secret=BBBB", "x")).not.toBe(a);
  });
});
