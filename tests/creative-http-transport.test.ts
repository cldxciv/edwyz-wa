import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const https = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("node:https", () => https);

import { isIncompleteBody, pinnedImageTransport } from "@/lib/creative/http-image";

type Plan = { headers: Record<string, string>; chunks: Buffer[]; complete: boolean };

/** A fake HTTPS exchange: the answer streams `chunks`, then ends cleanly (complete) or drops (close without end). */
function serve(plan: Plan) {
  https.request.mockImplementation((_opts: unknown, onResponse: (res: EventEmitter) => void) => {
    const call = Object.assign(new EventEmitter(), { destroy: vi.fn(), end: vi.fn(() => {
      const res = Object.assign(new EventEmitter(), { statusCode: 200, headers: plan.headers, complete: false, destroy: vi.fn() });
      onResponse(res);
      for (const c of plan.chunks) res.emit("data", c);
      if (plan.complete) {
        res.complete = true;
        res.emit("end");
      }
      res.emit("close");
    }) });
    return call;
  });
}

const req = { url: new URL("https://images.example.com/a.png"), address: "93.184.216.34", method: "GET" as const, headers: {}, timeoutMs: 1000, maxBytes: 1000 };

describe("isIncompleteBody", () => {
  it("is true when the connection dropped or fewer bytes arrived than announced", () => {
    expect(isIncompleteBody({ complete: false, declared: undefined, received: 10 })).toBe(true);
    expect(isIncompleteBody({ complete: true, declared: "100", received: 40 })).toBe(true);
    expect(isIncompleteBody({ complete: true, declared: "40", received: 40 })).toBe(false);
    expect(isIncompleteBody({ complete: true, declared: undefined, received: 40 })).toBe(false);
    expect(isIncompleteBody({ complete: true, declared: "abc", received: 40 })).toBe(false);
  });
});

describe("pinnedImageTransport", () => {
  it("reports a download that dropped part-way as truncated, so a corrupt image is never stored", async () => {
    serve({ headers: { "content-length": "100" }, chunks: [Buffer.alloc(40, 1)], complete: false });
    expect((await pinnedImageTransport(req)).truncated).toBe(true);
  });

  it("reports a body shorter than Content-Length as truncated even when it ended cleanly", async () => {
    serve({ headers: { "content-length": "100" }, chunks: [Buffer.alloc(40, 1)], complete: true });
    expect((await pinnedImageTransport(req)).truncated).toBe(true);
  });

  it("accepts a complete body", async () => {
    serve({ headers: { "content-length": "40" }, chunks: [Buffer.alloc(40, 1)], complete: true });
    const res = await pinnedImageTransport(req);
    expect(res.truncated).toBe(false);
    expect(res.body.length).toBe(40);
  });
});
