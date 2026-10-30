import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Opts = {
  hostname: string;
  port: string | number;
  path: string;
  headers: Record<string, string>;
  timeout: number;
  lookup: (host: string, options: { all?: boolean }, cb: (...args: unknown[]) => void) => void;
};

const https = vi.hoisted(() => ({ calls: [] as { opts: Opts; call: { destroy: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> } & EventEmitter }[] }));

vi.mock("node:https", () => ({
  request: (opts: Opts) => {
    const call = Object.assign(new EventEmitter(), { destroy: vi.fn(function (this: EventEmitter, e?: Error) { if (e) this.emit("error", e); }), end: vi.fn() });
    https.calls.push({ opts, call });
    return call;
  },
}));

import { pinnedTransport } from "@/lib/creative/pinned";

const req = (over: Partial<Parameters<typeof pinnedTransport>[0]> = {}) => ({
  url: new URL("https://rebind.example.com/page?x=1"),
  address: "93.184.216.34",
  timeoutMs: 5000,
  maxBytes: 1000,
  userAgent: "EdwyzBot/1.0",
  ...over,
});

beforeEach(() => {
  https.calls.length = 0;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("pinnedTransport (P3-09)", () => {
  it("connects only to the validated address, whatever DNS would say now", () => {
    void pinnedTransport(req()).catch(() => undefined);
    const { opts } = https.calls[0];
    expect(opts.hostname).toBe("rebind.example.com");
    expect(opts.path).toBe("/page?x=1");
    const single = vi.fn();
    opts.lookup("rebind.example.com", {}, single);
    expect(single).toHaveBeenCalledWith(null, "93.184.216.34", 4);
    const all = vi.fn();
    opts.lookup("rebind.example.com", { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [{ address: "93.184.216.34", family: 4 }]);
  });

  it("pins IPv6 addresses with the right family", () => {
    void pinnedTransport(req({ address: "2606:4700::6810:84e5" })).catch(() => undefined);
    const cb = vi.fn();
    https.calls[0].opts.lookup("rebind.example.com", {}, cb);
    expect(cb).toHaveBeenCalledWith(null, "2606:4700::6810:84e5", 6);
  });

  it("lets a caller add headers but keeps the user agent", () => {
    void pinnedTransport(req({ headers: { "x-shopify-access-token": "t", accept: "application/json" } })).catch(() => undefined);
    expect(https.calls[0].opts.headers).toMatchObject({ "user-agent": "EdwyzBot/1.0", "x-shopify-access-token": "t", accept: "application/json" });
  });

  it("cuts off a server that drips bytes past the hard deadline, not only an idle one", async () => {
    const done = pinnedTransport(req({ timeoutMs: 5000 }));
    const settled = done.catch((e: Error) => e);
    vi.advanceTimersByTime(4999);
    expect(https.calls[0].call.destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(https.calls[0].call.destroy).toHaveBeenCalled();
    expect(((await settled) as Error).message).toBe("deadline");
  });

  it("clears the deadline timer once the connection closes", () => {
    void pinnedTransport(req()).catch(() => undefined);
    https.calls[0].call.emit("close");
    vi.advanceTimersByTime(60_000);
    expect(https.calls[0].call.destroy).not.toHaveBeenCalled();
  });
});
