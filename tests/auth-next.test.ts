import { describe, expect, it } from "vitest";
import { safeNext } from "@/lib/auth/next";

describe("safeNext", () => {
  it("keeps signed-in area paths", () => {
    expect(safeNext("/app")).toBe("/app");
    expect(safeNext("/app/inbox?filter=mine")).toBe("/app/inbox?filter=mine");
    expect(safeNext("/admin")).toBe("/admin");
  });
  it("falls back for anything that could leave the site or the app", () => {
    const bad = ["https://evil.example", "//evil.example", "/\\evil.example", "/login", "app/inbox", "/app//x", "/app/../x", "/apple", "javascript:alert(1)", "/app\n/x", "", null, undefined];
    for (const value of bad) expect(safeNext(value)).toBe("/app");
  });
  it("rejects very long values", () => {
    expect(safeNext(`/app/${"a".repeat(400)}`)).toBe("/app");
  });
});
