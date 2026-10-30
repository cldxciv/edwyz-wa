import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger, getRequestId, log, redact, requestLogger, setErrorReporter, setLogSink } from "@/lib/log";

const lines: { level: string; entry: Record<string, unknown> }[] = [];

beforeEach(() => {
  lines.length = 0;
  delete process.env.LOG_LEVEL;
  setLogSink((level, line) => lines.push({ level, entry: JSON.parse(line) }));
});
afterEach(() => {
  setLogSink(null);
  setErrorReporter(null);
});

describe("logger", () => {
  it("writes one JSON line with time, level and message", () => {
    log.info("hello", { jobs: 3 });
    expect(lines).toHaveLength(1);
    expect(lines[0].entry).toMatchObject({ level: "info", msg: "hello", jobs: 3 });
    expect(new Date(String(lines[0].entry.t)).toISOString()).toBe(lines[0].entry.t);
  });

  it("honours LOG_LEVEL", () => {
    process.env.LOG_LEVEL = "warn";
    log.info("quiet");
    log.debug("quiet");
    log.warn("loud");
    expect(lines.map((l) => l.entry.msg)).toEqual(["loud"]);
  });

  it("routes child bindings into every line", () => {
    createLogger({ svc: "worker" }).child({ queue: "send" }).info("tick");
    expect(lines[0].entry).toMatchObject({ svc: "worker", queue: "send" });
  });

  it("cannot be tricked into overwriting level, time or message by fields", () => {
    log.info("x", { level: "debug", t: "yesterday", msg: "other" });
    expect(lines[0].entry.level).toBe("info");
    expect(lines[0].entry.msg).toBe("x");
    expect(lines[0].entry.t).not.toBe("yesterday");
  });
});

describe("redaction", () => {
  it("replaces sensitive keys at any depth", () => {
    const out = redact({
      token: "abc", accessToken: "abc", secret: "s", password: "p", Authorization: "Bearer x", cookie: "c",
      phone: "+919876543210", contactEmail: "a@b.co", nested: { clientSecret: "x", ok: 1 }, list: [{ password: "p" }],
    }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toMatch(/abc|919876543210|a@b\.co|"p"/);
    expect(out.token).toBe("[redacted]");
    expect((out.nested as Record<string, unknown>).ok).toBe(1);
  });

  it("never logs message bodies", () => {
    const out = redact({ body: "hi there", text: "t", content: "c", message: "m", payload: { a: 1 }, conversationId: "c1" }) as Record<string, unknown>;
    expect(out).toEqual({ body: "[redacted]", text: "[redacted]", content: "[redacted]", message: "[redacted]", payload: "[redacted]", conversationId: "c1" });
  });

  it("scrubs emails, phone numbers and tokens that appear inside plain strings", () => {
    const out = redact({ note: "mail jo@example.com or call +91 98765 43210, Bearer abc.def-ghi, EAAGm0PX4ZCpsBAKexampletoken1234" }) as { note: string };
    expect(out.note).not.toMatch(/example\.com|98765|abc\.def|EAAGm0/);
    expect(out.note).toContain("[email]");
    expect(out.note).toContain("[number]");
  });

  it("leaves ids that contain digits alone", () => {
    const out = redact({ id: "123e4567-e89b-12d3-a456-426614174000", queue: "send" }) as Record<string, string>;
    expect(out.id).toBe("123e4567-e89b-12d3-a456-426614174000");
  });

  it("serializes errors without stack, and without the message for Prisma errors", () => {
    class PrismaClientKnownRequestError extends Error {
      code = "P2002";
    }
    const prisma = redact({ err: new PrismaClientKnownRequestError('Unique failed on phone "919876543210"') }) as { err: Record<string, string> };
    expect(JSON.stringify(prisma)).not.toContain("919876543210");
    expect(prisma.err.kind).toContain("P2002");
    const plain = redact({ err: new Error("boom for jo@example.com") }) as { err: Record<string, string> };
    expect(plain.err.message).toBe("boom for [email]");
    expect(JSON.stringify(plain)).not.toContain("stack");
  });

  it("bounds depth, array length and string length", () => {
    const deep = { a: { b: { c: { d: { e: 1 } } } } };
    expect(JSON.stringify(redact(deep))).toContain("[truncated]");
    expect((redact({ rows: Array.from({ length: 100 }, (_, i) => i) }) as { rows: number[] }).rows).toHaveLength(20);
    expect((redact({ s: "x".repeat(5000) }) as { s: string }).s.length).toBeLessThan(600);
  });

  it("redacts inside emitted lines, not only in the helper", () => {
    log.info("send failed to jo@example.com", { phone: "+919876543210", status: 400 });
    expect(JSON.stringify(lines[0].entry)).not.toMatch(/example\.com|919876543210/);
    expect(lines[0].entry.status).toBe(400);
  });
});

describe("error reporter hook", () => {
  it("receives scrubbed data on error lines that carry err", () => {
    const reporter = vi.fn();
    setErrorReporter(reporter);
    log.error("job failed", { err: new Error("bad 919876543210"), queue: "send", token: "t", reqId: "abcdef123456" });
    expect(reporter).toHaveBeenCalledTimes(1);
    const report = reporter.mock.calls[0][0];
    expect(JSON.stringify(report)).not.toMatch(/919876543210|"t"/);
    expect(report.context).toMatchObject({ queue: "send" });
    expect(report.requestId).toBe("abcdef123456");
  });

  it("is not called for warnings or for errors without err, and cannot break logging", () => {
    const reporter = vi.fn(() => {
      throw new Error("down");
    });
    setErrorReporter(reporter);
    log.warn("w", { err: new Error("x") });
    log.error("no err field");
    log.error("with", { err: new Error("x") });
    expect(reporter).toHaveBeenCalledTimes(1);
    expect(lines).toHaveLength(3);
  });
});

describe("request id", () => {
  it("reuses a well formed inbound id and replaces a malformed one", () => {
    expect(getRequestId(new Request("http://x", { headers: { "x-request-id": "req_12345678" } }))).toBe("req_12345678");
    const minted = getRequestId(new Request("http://x", { headers: { "x-request-id": "bad id with spaces" } }));
    expect(minted).toMatch(/^[0-9a-f]{16}$/);
    expect(getRequestId(new Headers())).toMatch(/^[0-9a-f]{16}$/);
  });

  it("binds the id to a child logger", () => {
    const { id, log: scoped } = requestLogger(new Headers({ "x-request-id": "abcdef123456" }), { route: "tick" });
    scoped.info("run");
    expect(id).toBe("abcdef123456");
    expect(lines[0].entry).toMatchObject({ reqId: "abcdef123456", route: "tick" });
  });
});
