import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;

/*
 * The campaign wizard's read-only Meta pickers (src/lib/ads/pickers.ts): every call is a GET with the asset's own token,
 * another workspace's asset is refused before Meta is asked, lead forms are registered as LeadForm rows once, and Meta's
 * refusals come back in plain words.
 */

const store = vi.hoisted(() => ({ forms: [] as Row[], seq: 0 }));
const graph = vi.hoisted(() => ({ graphFetchAs: vi.fn() }));
const connect = vi.hoisted(() => ({ listAssets: vi.fn(), getAssetAccess: vi.fn() }));
const authMock = vi.hoisted(() => ({ getActor: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    leadForm: {
      findMany: async ({ where }: Row) => store.forms.filter((f) => f.tenantId === where.tenantId && where.metaFormId.in.includes(f.metaFormId)),
      findFirst: async ({ where }: Row) => store.forms.find((f) => f.tenantId === where.tenantId && f.metaFormId === where.metaFormId) ?? null,
      create: async ({ data }: Row) => {
        if (store.forms.some((f) => f.tenantId === data.tenantId && f.metaFormId === data.metaFormId)) throw Object.assign(new Error("unique"), { code: "P2002" });
        const row = { id: `lf${++store.seq}`, ...data };
        store.forms.push(row);
        return row;
      },
      updateMany: async ({ where, data }: Row) => {
        const rows = store.forms.filter((f) => f.id === where.id && f.tenantId === where.tenantId);
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      },
    },
  },
}));
vi.mock("@/lib/graph", async () => {
  const actual = await vi.importActual<typeof import("@/lib/graph")>("@/lib/graph");
  return { ...actual, graphFetchAs: graph.graphFetchAs };
});
vi.mock("@/lib/meta-connect", () => connect);
vi.mock("@/lib/auth", () => authMock);

import { GraphError } from "@/lib/graph";
import { listAllLeadForms, listInstagramMedia, listLeadForms, listPagePosts, searchCities, searchInterests, searchTerm } from "@/lib/ads/pickers";
import { GET } from "@/app/api/ads/pickers/route";

const ASSETS: Record<string, Row[]> = {
  page: [
    { id: "pg1", type: "page", externalId: "111", name: "Clinic", status: "active", meta: {} },
    { id: "pg2", type: "page", externalId: "222", name: "Old page", status: "active", meta: {} },
  ],
  instagram: [{ id: "ig1", type: "instagram", externalId: "1789", name: "clinic.ig", status: "active", meta: {} }],
  ad_account: [{ id: "acc1", type: "ad_account", externalId: "act_9", name: "Main", status: "active", meta: { currency: "INR" } }],
};

beforeEach(() => {
  store.forms = [];
  store.seq = 0;
  vi.clearAllMocks();
  connect.listAssets.mockImplementation(async (tenantId: string, type: string) => (tenantId === "t1" ? (ASSETS[type] ?? []) : []));
  connect.getAssetAccess.mockImplementation(async (_t: string, assetId: string) => ({ assetId, token: `tok-${assetId}` }));
});

describe("posts and Instagram media", () => {
  it("reads the Page's published posts with the Page's token and maps them", async () => {
    graph.graphFetchAs.mockResolvedValue({ data: [{ id: "111_5", message: "Free check-up this week", created_time: "2026-10-01T10:00:00+0000", full_picture: "https://cdn/x.jpg", permalink_url: "https://fb.com/p", is_eligible_for_promotion: false }, { message: "no id" }] });
    const items = await listPagePosts("t1", "pg1");
    expect(items).toEqual([{ id: "111_5", text: "Free check-up this week", createdAt: "2026-10-01T10:00:00+0000", picture: "https://cdn/x.jpg", link: "https://fb.com/p", eligible: false }]);
    const [token, req] = graph.graphFetchAs.mock.calls[0];
    expect(token).toBe("tok-pg1");
    expect(req).toMatchObject({ path: "111/published_posts", method: "GET" });
    expect(req.query.fields).toContain("is_eligible_for_promotion");
  });

  it("reads Instagram posts with a thumbnail for videos", async () => {
    graph.graphFetchAs.mockResolvedValue({ data: [{ id: "m1", caption: "Reel", media_type: "VIDEO", media_url: "https://cdn/v.mp4", thumbnail_url: "https://cdn/t.jpg", permalink: "https://ig/p", timestamp: "2026-10-02T00:00:00+0000" }] });
    expect(await listInstagramMedia("t1", "ig1")).toEqual([{ id: "m1", caption: "Reel", mediaType: "VIDEO", picture: "https://cdn/t.jpg", link: "https://ig/p", createdAt: "2026-10-02T00:00:00+0000" }]);
    expect(graph.graphFetchAs.mock.calls[0][1].path).toBe("1789/media");
  });

  it("refuses another workspace's asset, or none, before asking Meta", async () => {
    await expect(listPagePosts("t2", "pg1")).rejects.toMatchObject({ status: 404 });
    await expect(listPagePosts("t1", "")).rejects.toMatchObject({ status: 400 });
    await expect(listPagePosts("t1", "ig1")).rejects.toMatchObject({ status: 404 });
    expect(graph.graphFetchAs).not.toHaveBeenCalled();
  });

  it("says Meta's refusals in plain words", async () => {
    graph.graphFetchAs.mockRejectedValueOnce(new GraphError("Error validating access token", 400, 190));
    await expect(listPagePosts("t1", "pg1")).rejects.toThrow(/access token expired.*Reconnect/);
    graph.graphFetchAs.mockRejectedValueOnce(new GraphError("(#10) Requires pages_read_engagement", 403, 10));
    await expect(listPagePosts("t1", "pg1")).rejects.toThrow(/did not give this workspace permission/);
    graph.graphFetchAs.mockRejectedValueOnce(new GraphError("down", 500, 2, undefined, true));
    await expect(listPagePosts("t1", "pg1")).rejects.toMatchObject({ status: 503 });
  });
});

describe("lead forms", () => {
  it("registers each form once, fills a missing name, follows its status, and marks only active forms usable", async () => {
    store.forms.push({ id: "lf0", tenantId: "t1", pageAssetId: "pg1", metaFormId: "900", name: null, status: "active" });
    graph.graphFetchAs.mockResolvedValue({ data: [{ id: "900", name: "Check-up form", status: "ACTIVE" }, { id: "901", name: "Old form", status: "ARCHIVED" }, { id: "bad id!" }] });
    const items = await listLeadForms("t1", "pg1");
    expect(items).toEqual([
      { id: "lf0", metaFormId: "900", name: "Check-up form", status: "active", active: true, pageAssetId: "pg1", pageName: "Clinic" },
      { id: "lf1", metaFormId: "901", name: "Old form", status: "archived", active: false, pageAssetId: "pg1", pageName: "Clinic" },
    ]);
    expect(store.forms).toHaveLength(2);
    expect(store.forms[0].name).toBe("Check-up form");
    expect(store.forms[1]).toMatchObject({ tenantId: "t1", pageAssetId: "pg1", metaFormId: "901", status: "archived" });
    expect(graph.graphFetchAs.mock.calls[0][1].path).toBe("111/leadgen_forms");
    // Again: nothing new is written.
    await listLeadForms("t1", "pg1");
    expect(store.forms).toHaveLength(2);
  });

  it("reads every connected Page and reports a Page Meta refuses without failing the rest", async () => {
    graph.graphFetchAs.mockImplementation(async (_t: string, req: { path: string }) => {
      if (req.path.startsWith("222/")) throw new GraphError("(#200) Permissions error", 403, 200);
      return { data: [{ id: "950", name: "Form", status: "ACTIVE" }] };
    });
    const out = await listAllLeadForms("t1");
    expect(out.items.map((f) => f.metaFormId)).toEqual(["950"]);
    expect(out.problems).toHaveLength(1);
    expect(out.problems[0]).toMatch(/^Old page: Meta did not give this workspace permission/);
  });
});

describe("interest and city search", () => {
  it("searches interests with the ad account's login and keeps numeric ids only", async () => {
    graph.graphFetchAs.mockResolvedValue({ data: [{ id: "6003139266461", name: "Yoga", audience_size_lower_bound: 1000, audience_size_upper_bound: 2000, path: ["Fitness", "Yoga"] }, { id: "x", name: "bad" }] });
    expect(await searchInterests("t1", "acc1", " yoga ")).toEqual([{ id: "6003139266461", name: "Yoga", audienceLow: 1000, audienceHigh: 2000, path: ["Fitness", "Yoga"] }]);
    expect(graph.graphFetchAs.mock.calls[0][0]).toBe("tok-acc1");
    expect(graph.graphFetchAs.mock.calls[0][1]).toMatchObject({ path: "search", method: "GET", query: { type: "adinterest", q: "yoga" } });
  });

  it("searches cities, optionally in one country", async () => {
    graph.graphFetchAs.mockResolvedValue({ data: [{ key: 1035921, name: "Pune", type: "city", region: "Maharashtra", country_code: "IN" }, { key: "x", name: "Maharashtra", type: "region" }] });
    expect(await searchCities("t1", "acc1", "pune", "in")).toEqual([{ key: "1035921", name: "Pune", region: "Maharashtra", countryCode: "IN" }]);
    const query = graph.graphFetchAs.mock.calls[0][1].query;
    expect(query).toMatchObject({ type: "adgeolocation", q: "pune", country_code: "IN" });
    expect(JSON.parse(query.location_types)).toEqual(["city"]);
    await searchCities("t1", "acc1", "pune", "India");
    expect(graph.graphFetchAs.mock.calls[1][1].query).not.toHaveProperty("country_code");
  });

  it("needs two letters to search", async () => {
    expect(() => searchTerm(" a ")).toThrow(/at least two letters/);
    expect(searchTerm("  ab ")).toBe("ab");
    await expect(searchInterests("t1", "acc1", "y")).rejects.toMatchObject({ status: 400 });
    expect(graph.graphFetchAs).not.toHaveBeenCalled();
  });
});

describe("the pickers route", () => {
  const get = (qs: string) => GET(new Request(`https://wa.edwyz.com/api/ads/pickers?${qs}`));

  it("is for owners and admins, and names the kinds it knows", async () => {
    authMock.getActor.mockResolvedValue({ userId: "u3", tenantId: "t1", role: "agent" });
    expect((await get("kind=posts&page=pg1")).status).toBe(403);
    authMock.getActor.mockResolvedValue({ userId: "u1", tenantId: "t1", role: "admin" });
    expect((await get("kind=everything")).status).toBe(400);
  });

  it("answers each kind, and lead forms of every Page without a page", async () => {
    authMock.getActor.mockResolvedValue({ userId: "u1", tenantId: "t1", role: "admin" });
    graph.graphFetchAs.mockResolvedValue({ data: [] });
    const posts = await get("kind=posts&page=pg1");
    expect(posts.status).toBe(200);
    expect(posts.headers.get("cache-control")).toBe("no-store");
    expect(await posts.json()).toEqual({ items: [] });
    expect(await (await get("kind=lead_forms")).json()).toEqual({ items: [], problems: [] });
    expect(await (await get("kind=lead_forms&page=pg1")).json()).toEqual({ items: [], problems: [] });
    expect((await get("kind=interests&account=acc1&q=yo")).status).toBe(200);
    expect((await get("kind=cities&account=acc1&q=pu&country=IN")).status).toBe(200);
    expect((await get("kind=instagram_media&instagram=ig1")).status).toBe(200);
  });
});
