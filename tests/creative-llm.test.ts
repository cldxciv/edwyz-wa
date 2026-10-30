import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callClaude, generateJson } from "@/lib/creative/llm";
import { extractJson, parseAngles, parseCopy } from "@/lib/creative/schemas";

const angle = (n: number) => ({ hook: `hook ${n}`, audience: "a", cta: "Learn more", rationale: "r" });
const good = JSON.stringify({ angles: [angle(1), angle(2), angle(3)] });

describe("generateJson", () => {
  it("accepts fenced JSON", async () => {
    const ask = vi.fn().mockResolvedValue("Here you go:\n```json\n" + good + "\n```");
    expect(await generateJson("s", "u", parseAngles, ask)).toHaveLength(3);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("retries once with the validation error, then succeeds", async () => {
    const ask = vi.fn().mockResolvedValueOnce("not json at all").mockResolvedValueOnce(good);
    expect(await generateJson("s", "u", parseAngles, ask)).toHaveLength(3);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls[1][1]).toMatch(/rejected/);
  });

  it("retries on schema violation (too few angles) and fails after the second bad answer", async () => {
    const bad = JSON.stringify({ angles: [angle(1)] });
    const ask = vi.fn().mockResolvedValue(bad);
    await expect(generateJson("s", "u", parseAngles, ask)).rejects.toMatchObject({ status: 502 });
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("does not retry transport errors", async () => {
    const ask = vi.fn().mockRejectedValue(Object.assign(new Error("x"), { status: 502 }));
    await expect(generateJson("s", "u", parseAngles, ask)).rejects.toThrow();
    expect(ask).toHaveBeenCalledTimes(1);
  });
});

describe("schemas", () => {
  it("rejects non-string and oversize fields", () => {
    expect(() => parseAngles({ angles: [angle(1), angle(2), { ...angle(3), cta: 5 }] })).toThrow(/cta/);
    expect(() => parseAngles({ angles: [angle(1), angle(2), { ...angle(3), hook: "x".repeat(400) }] })).toThrow(/longer/);
  });
  it("extractJson handles garbage", () => {
    expect(() => extractJson("nothing")).toThrow();
    expect(() => extractJson("{broken")).toThrow();
  });
  it("copy requires every requested placement and drops extras", () => {
    const v = (placement: string) => ({ placement, headline: "h", primaryText: "p", description: "d" });
    expect(() => parseCopy({ variants: [v("feed")] }, ["feed", "story"])).toThrow(/story/);
    expect(parseCopy({ variants: [v("feed"), v("story")] }, ["feed"])).toHaveLength(1);
    expect(() => parseCopy({ variants: [v("tv")] }, ["feed"])).toThrow(/placement/);
  });
});

describe("callClaude", () => {
  const key = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.ANTHROPIC_API_KEY = key;
  });

  it("reports AI not configured without a key", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(callClaude("s", "u")).rejects.toMatchObject({ status: 503, message: "AI is not configured." });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("posts to the Anthropic endpoint with the key header", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ content: [{ type: "text", text: "hi" }] })));
    expect(await callClaude("s", "u")).toBe("hi");
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((init!.headers as Record<string, string>)["anthropic-version"]).toBe("2023-06-01");
  });
});
