import { describe, expect, it } from "vitest";
import * as route from "@/app/api/[...rest]/route";

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

describe("unknown /api paths", () => {
  it("answer every method with the JSON 404 other API errors use, never the HTML site page", async () => {
    for (const method of METHODS) {
      const handler = route[method];
      expect(typeof handler, method).toBe("function");
      const res = await handler(new Request("https://wa.edwyz.com/api/this-does-not-exist", { method }));
      expect(res.status, method).toBe(404);
      expect(res.headers.get("content-type"), method).toContain("application/json");
      expect(res.headers.get("cache-control"), method).toBe("no-store");
      expect(await res.json(), method).toEqual({ error: "Not found." });
    }
  });

  it("is rendered per request, so it is never cached as a static page", () => {
    expect(route.dynamic).toBe("force-dynamic");
  });
});
