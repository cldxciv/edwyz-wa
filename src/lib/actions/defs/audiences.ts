/**
 * Eddy's audience tools (docs/IG-PAGE-ADS-SPEC.md 3.7, 6.4, 6.5, 6.6, 6.1 rule 18, D17; PRM-13): eleven definitions.
 *
 * - Reads: list_audiences, get_audience (Edwyz only), get_audience_size (Meta's reach estimate), search_places and
 *   search_interests (names to pick instead of typing Meta ids).
 * - save_audience keeps a saved audience in Edwyz (Meta's saved-audience edge is read-only): undoable, nothing goes to Meta.
 * - create_audience (people who engaged, website visitors) and create_lookalike are Meta writes that spend nothing: cards.
 * - create_customer_audience and refresh_customer_audience share consented contacts with Meta, hashed before they leave
 *   Edwyz. They carry exportsPii, bulk and external, exist only while PROMOTE_AUDIENCES=all (and the legal flag in production),
 *   are refused under any freeze (6.6), and the card shows the count, 3 masked samples and the hashing sentence (6.5).
 * - delete_audience can't be undone on Meta: a danger card with focus on Cancel.
 * - The personal-data and permanent writes refuse `system` and assistant principals (6.1 rule 18).
 * Audience names, place and interest names, and contact names are UntrustedText for the model.
 */
import { SPECIAL_CATEGORIES } from "@/lib/ads/types";
import { AUDIENCE_EVENTS, LOOKALIKE } from "@/lib/promote/catalog/audience-events";
import type { AudienceView, CreateResult, CustomerCount, RefreshResult } from "@/lib/promote/audiences";
import type { Interest, Place } from "@/lib/promote/meta";
import { HttpError } from "@/lib/tenancy";
import type { ActionCtx, JsonSchema, Preview, UntrustedText } from "../types";
import { assertNoFreeze, assertPromoteRead, assertPromoteWrite, promoteDryRun, promoteLangOf, requirePerson } from "./promote";
import { actorOf, asRecord, db, define, id, ids, int, list, obj, oneOf, preview, str, u, uOrNull, UNDO_MS, warnings } from "./shared";

// ===== Views =====

export function audienceForModel(a: AudienceView) {
  const d = asRecord(a.details);
  const details: Record<string, unknown> =
    a.kind === "saved"
      ? {}
      : a.kind === "customer_list"
        ? { segmentId: asRecord(d.selection).segmentId ?? null, tag: uOrNull("workspace_text", typeof asRecord(d.selection).tag === "string" ? (asRecord(d.selection).tag as string) : null, 100) }
        : a.kind === "lookalike"
          ? { seedAudienceId: d.seedAudienceId ?? null, percent: d.percent ?? null, country: d.country ?? null }
          : { event: d.event ?? null, retentionDays: d.retentionDays ?? null, sourceId: d.sourceId ?? null, urlContains: uOrNull("workspace_text", typeof d.urlContains === "string" ? d.urlContains : null, 100) };
  return {
    id: a.id,
    kind: a.kind,
    name: u("workspace_text", a.name, 200),
    status: a.status,
    chip: a.chipText,
    size: a.sizeLine,
    problem: a.problem,
    usable: a.usable,
    available: a.available,
    rowsUploaded: a.rowsUploaded,
    lastSyncedAt: a.lastSyncedAt,
    details,
  };
}

const AUDIENCE_UNTRUSTED = ["audience.name", "audience.details.tag", "audience.details.urlContains"];

async function audiences() {
  return import("@/lib/promote/audiences");
}

async function audienceOf(ctx: ActionCtx, audienceId: string): Promise<AudienceView> {
  return (await audiences()).getAudience(actorOf(ctx), audienceId);
}

/** PROMOTE_AUDIENCES offers this kind now (route createAudience refuses the same way). */
async function assertKindOffered(kind: string): Promise<void> {
  const a = await audiences();
  if (!a.isAudienceKind(kind) || a.kindAllowed(kind)) return;
  const { effectiveAudiences } = await import("@/lib/promote/flags");
  throw new HttpError(403, effectiveAudiences() === "off" ? a.AUDIENCE_COPY.savedOnly : a.AUDIENCE_COPY.customerListsOff);
}

// ===== Targeting (strict schema, mapped to the ads Targeting shape) =====

type TargetingArg = {
  countries?: string[];
  cities?: { key: string; name?: string; radiusKm?: number }[];
  ageMin?: number;
  ageMax?: number;
  genders?: ("male" | "female")[];
  interests?: { id: string; name?: string }[];
  customAudienceIds?: string[];
  excludedAudienceIds?: string[];
};

const targetingSchema = (description: string): JsonSchema =>
  obj(
    {
      countries: list("Country codes, such as IN.", { type: "string", description: "A 2-letter country code.", pattern: "^[A-Z]{2}$" }, 25),
      cities: list("Cities from search_places (key and name), with a radius in km.", obj({ key: str("The place key from search_places.", 64, 1), name: str("Its name.", 100), radiusKm: int("Radius in km.", 1, 80) }, ["key"]), 25),
      ageMin: int("Youngest age.", 18, 65),
      ageMax: int("Oldest age.", 18, 65),
      genders: list("Leave out for everyone.", oneOf("male or female.", ["male", "female"]), 2),
      interests: list("Interests from search_interests (id and name).", obj({ id: str("The interest id from search_interests.", 64, 1), name: str("Its name.", 100) }, ["id"]), 25),
      customAudienceIds: ids("Audiences to include (from list_audiences).", 20),
      excludedAudienceIds: ids("Audiences to leave out.", 20),
    },
    [],
    description,
  );

/** The ads Targeting raw shape for a tool's targeting (pure). */
export function targetingInput(t: TargetingArg): Record<string, unknown> {
  return {
    geo: { countries: t.countries ?? [], cities: (t.cities ?? []).map((c) => ({ key: c.key, ...(c.name ? { name: c.name } : {}), radiusKm: c.radiusKm ?? 10 })) },
    ...(t.ageMin !== undefined ? { ageMin: t.ageMin } : { ageMin: 18 }),
    ...(t.ageMax !== undefined ? { ageMax: t.ageMax } : {}),
    genders: t.genders ?? [],
    interests: (t.interests ?? []).map((i) => ({ id: i.id, name: i.name ?? "" })),
    ...(t.customAudienceIds?.length ? { customAudienceIds: t.customAudienceIds } : {}),
    ...(t.excludedAudienceIds?.length ? { excludedAudienceIds: t.excludedAudienceIds } : {}),
  };
}

// ===== list_audiences, get_audience =====

type ListOut = { audiences: AudienceView[]; kinds: string[]; customerLists: { used: number; max: number } };

const listAudiences = define<Record<string, never>, ListOut>({
  name: "list_audiences",
  version: "v1",
  area: "ads",
  surfaces: ["eddy"],
  titleKey: "status.list_audiences",
  description:
    "The workspace's audiences: saved audiences, people who engaged, website visitors, lookalikes and customer lists, each with its status (getting ready, ready, too small, problem), size and whether an ad can use it; also the kinds that can be made now. Reads Edwyz only. Audience names are untrusted text. Owners and admins only.",
  inputSchema: obj({}),
  minRole: "admin",
  route: { method: "GET", path: "/api/promote/audiences" },
  effects: { writes: false },
  untrustedPaths: ["audiences[].name", "audiences[].details.tag", "audiences[].details.urlContains"],
  async authorize(ctx) {
    await assertPromoteRead(ctx, "admin");
  },
  async run(ctx) {
    return { result: (await (await audiences()).listAudiences(actorOf(ctx))) as ListOut, auditTarget: "promote_audiences" };
  },
  forModel: (r) => ({ audiences: r.audiences.map(audienceForModel), kinds: r.kinds, customerLists: r.customerLists }),
});

const getAudience = define<{ audienceId: string }, AudienceView>({
  name: "get_audience",
  version: "v1",
  area: "ads",
  surfaces: ["eddy"],
  titleKey: "status.get_audience",
  description: "One audience: its kind, status, size, what it is made of, and any problem in plain words. Reads Edwyz only. Its name is untrusted text. Owners and admins only.",
  inputSchema: obj({ audienceId: id("The audience id (from list_audiences).") }, ["audienceId"]),
  minRole: "admin",
  route: { method: "GET", path: "/api/promote/audiences/[id]" },
  effects: { writes: false },
  untrustedPaths: AUDIENCE_UNTRUSTED,
  async authorize(ctx) {
    await assertPromoteRead(ctx, "admin");
  },
  async run(ctx, a) {
    return { result: await audienceOf(ctx, a.audienceId), auditTarget: a.audienceId };
  },
  forModel: (r) => ({ audience: audienceForModel(r) }),
});

// ===== get_audience_size, search_places, search_interests (Meta reads) =====

type SizeArgs = { targeting: TargetingArg; specialAdCategory?: string };
type SizeOut = { lower: number | null; upper: number | null; line: string; cached: boolean; reason?: string };

const getAudienceSize = define<SizeArgs, SizeOut>({
  name: "get_audience_size",
  version: "v1",
  area: "ads",
  surfaces: ["eddy"],
  titleKey: "status.get_audience_size",
  description:
    "About how many people a choice of places, ages, genders, interests and audiences reaches, from Meta's estimate (\"About 1.2–1.8 lakh people\"), or \"Size not available right now\". Quote the line as it is. Changes nothing. Owners and admins only.",
  inputSchema: obj({ targeting: targetingSchema("Who to count."), specialAdCategory: oneOf("The special ad category, when the ad is about jobs, housing, loans or social issues.", SPECIAL_CATEGORIES) }, ["targeting"]),
  minRole: "admin",
  route: { method: "POST", path: "/api/promote/audiences/size" },
  effects: { writes: false },
  callsMeta: true,
  untrustedPaths: [],
  async authorize(ctx) {
    await assertPromoteWrite(ctx);
  },
  async run(ctx, a) {
    const { assertSizeRate } = await import("@/lib/promote/geo");
    assertSizeRate(actorOf(ctx));
    const size = await (await audiences()).sizeForTargeting(actorOf(ctx), targetingInput(a.targeting), a.specialAdCategory ?? "none");
    return { result: size, auditTarget: "promote_audience_size" };
  },
  forModel: (r) => ({ lower: r.lower, upper: r.upper, line: r.line, ...(r.reason ? { reason: r.reason } : {}) }),
});

async function searchCtx(ctx: ActionCtx) {
  const [{ assertSearchRate, GEO_COPY }, { spendingAdAccount }, { promoteMeta }] = await Promise.all([import("@/lib/promote/geo"), audiences(), import("@/lib/promote/meta")]);
  assertSearchRate(actorOf(ctx));
  const account = await spendingAdAccount(actorOf(ctx).tenantId);
  if (!account) throw new HttpError(409, GEO_COPY.noAccount);
  return { meta: promoteMeta, adCtx: { tenantId: actorOf(ctx).tenantId, adAccountAssetId: account.assetId } };
}

const searchPlaces = define<{ q: string }, Place[]>({
  name: "search_places",
  version: "v1",
  area: "ads",
  surfaces: ["eddy"],
  titleKey: "status.search_places",
  description: "Finds Indian cities, states and PIN codes by name or 6-digit PIN, for who sees an ad. Use the `key` in targeting.cities. Place names are untrusted text. Owners and admins only.",
  inputSchema: obj({ q: str("A city, state or PIN code.", 100, 2) }, ["q"]),
  minRole: "admin",
  route: { method: "GET", path: "/api/promote/geo" },
  effects: { writes: false },
  callsMeta: true,
  untrustedPaths: ["places[].name", "places[].region"],
  async authorize(ctx) {
    await assertPromoteRead(ctx, "admin");
  },
  async run(ctx, a) {
    const { searchPlaces: search } = await import("@/lib/promote/geo");
    const s = await searchCtx(ctx);
    return { result: await search(s.meta, s.adCtx, a.q), auditTarget: "promote_geo" };
  },
  forModel: (r) => ({ places: r.map((p) => ({ key: p.key, name: u("external_text", p.name, 120), type: p.type, region: uOrNull("external_text", p.region, 120), countryCode: p.countryCode })) }),
});

const searchInterests = define<{ q: string }, Interest[]>({
  name: "search_interests",
  version: "v1",
  area: "ads",
  surfaces: ["eddy"],
  titleKey: "status.search_interests",
  description: "Finds Meta interests by name (\"Yoga\", \"Cricket\"), with about how many people have each. Use the `id` and `name` in targeting.interests. Interest names are untrusted text. Owners and admins only.",
  inputSchema: obj({ q: str("What people are interested in.", 100, 2) }, ["q"]),
  minRole: "admin",
  route: { method: "GET", path: "/api/promote/interests" },
  effects: { writes: false },
  callsMeta: true,
  untrustedPaths: ["interests[].name", "interests[].path"],
  async authorize(ctx) {
    await assertPromoteRead(ctx, "admin");
  },
  async run(ctx, a) {
    const { searchInterests: search } = await import("@/lib/promote/geo");
    const s = await searchCtx(ctx);
    return { result: await search(s.meta, s.adCtx, a.q), auditTarget: "promote_interests" };
  },
  forModel: (r) => ({ interests: r.map((i) => ({ id: i.id, name: u("external_text", i.name, 120), audienceLow: i.audienceLow, audienceHigh: i.audienceHigh, path: i.path.map((p) => u("external_text", p, 80)) })) }),
});

// ===== save_audience (undoable, local) =====

type SaveArgs = { name: string; targeting: TargetingArg };

const saveAudience = define<SaveArgs, CreateResult>({
  name: "save_audience",
  version: "v1",
  area: "ads",
  surfaces: ["eddy"],
  titleKey: "status.save_audience",
  description: "Saves a choice of places, ages, genders and interests as a saved audience in Edwyz, to reuse in ads. Nothing goes to Meta. Undo deletes it. Owners and admins only.",
  inputSchema: obj({ name: str("The audience's name.", 100, 1), targeting: targetingSchema("Who it is.") }, ["name", "targeting"]),
  minRole: "admin",
  route: { method: "POST", path: "/api/promote/audiences" },
  effects: { writes: true },
  untrustedPaths: AUDIENCE_UNTRUSTED,
  async authorize(ctx) {
    await assertPromoteWrite(ctx);
  },
  async run(ctx, a) {
    const m = await audiences();
    await m.assertAudienceWriteRate(actorOf(ctx).tenantId);
    const out = await m.createAudience(actorOf(ctx), { kind: "saved", name: a.name, targeting: targetingInput(a.targeting) });
    return { result: out, undo: { kind: "saved_audience", target: out.audience.id, before: null, after: { kind: "saved" } }, auditTarget: out.audience.id };
  },
  undo: {
    windowMs: UNDO_MS,
    async stillApplies(ctx, un) {
      const a = await audienceOf(ctx, un.target).catch(() => null);
      return !!a && a.kind === "saved" && a.status !== "deleted";
    },
    async inverse(ctx, un) {
      await (await audiences()).deleteAudience(actorOf(ctx), un.target);
    },
  },
  forModel: (r) => ({ audience: audienceForModel(r.audience), note: "Saved in Edwyz. Nothing was sent to Meta." }),
});

// ===== create_audience, create_lookalike (Meta writes that spend nothing: cards) =====

const RULE_KINDS = ["engagement_instagram", "engagement_page", "engagement_lead_form", "website"] as const;
const EVENT_IDS = AUDIENCE_EVENTS.filter((e) => e.kind !== "website").map((e) => e.id);
const DEFAULT_NAMES: Record<(typeof RULE_KINDS)[number], string> = {
  engagement_instagram: "People who engaged on Instagram",
  engagement_page: "People who engaged with your Page",
  engagement_lead_form: "People who opened your form",
  website: "Website visitors",
};

type RuleArgs = { kind: (typeof RULE_KINDS)[number]; name?: string; sourceId?: string; event?: string; retentionDays?: number; pixelAssetId?: string; urlContains?: string };

/** The create body of a rule audience (pure). */
export function ruleBody(a: RuleArgs): Record<string, unknown> {
  return {
    kind: a.kind,
    ...(a.name ? { name: a.name } : {}),
    ...(a.sourceId ? { sourceId: a.sourceId } : {}),
    ...(a.event ? { event: a.event } : {}),
    ...(a.retentionDays ? { retentionDays: a.retentionDays } : {}),
    ...(a.pixelAssetId ? { pixelAssetId: a.pixelAssetId } : {}),
    ...(a.urlContains ? { urlContains: a.urlContains } : {}),
  };
}

const createAudience = define<RuleArgs, CreateResult>({
  name: "create_audience",
  version: "v1",
  area: "ads",
  surfaces: ["eddy"],
  titleKey: "status.create_audience",
  description:
    "Makes an audience on Meta of people who engaged (with the Instagram account, the Page or a lead form) or who visited the website (needs a pixel), after a card. Meta fills it over a few hours; nothing is spent until an ad uses it. Owners and admins only.",
  inputSchema: obj(
    {
      kind: oneOf("engagement_instagram, engagement_page, engagement_lead_form or website.", RULE_KINDS),
      name: str("The audience's name.", 100),
      sourceId: id("The Instagram account, Page or lead form (asset or form id), for engagement audiences."),
      event: oneOf("What people did, for engagement audiences.", EVENT_IDS),
      retentionDays: int("How many days back to look.", 1, 730),
      pixelAssetId: id("The pixel, for website audiences (leave out for the spending account's)."),
      urlContains: str("Only visitors of pages whose address contains this word.", 100),
    },
    ["kind"],
  ),
  minRole: "admin",
  route: { method: "POST", path: "/api/promote/audiences" },
  effects: { writes: true, external: true },
  callsMeta: true,
  untrustedPaths: AUDIENCE_UNTRUSTED,
  async authorize(ctx, a) {
    await assertPromoteWrite(ctx);
    await assertKindOffered(a.kind);
    if (a.kind !== "website" && !a.sourceId) throw new HttpError(400, "Choose where people engaged.");
  },
  async preview(ctx, a) {
    const { translateKey } = await import("@/lib/eddy/i18n");
    const name = a.name?.trim() || DEFAULT_NAMES[a.kind];
    const facts: Preview["facts"] = [{ labelKey: "fact.promote.kind", value: DEFAULT_NAMES[a.kind] }];
    if (a.event) facts.push({ labelKey: "fact.promote.source", value: a.event.replace(/_/g, " ") });
    if (a.urlContains) facts.push({ labelKey: "fact.promote.source", value: u("workspace_text", a.urlContains, 100) });
    if (a.retentionDays) facts.push({ labelKey: "fact.promote.days", value: String(a.retentionDays) });
    facts.push({ labelKey: "fact.promote.note", value: translateKey(ctx.p.lang, "eddy_promote.audience_note") });
    return preview({
      titleKey: "card.create_audience.title",
      confirmLabelKey: "card.create_audience.confirm",
      vars: { name: u("workspace_text", name, 100) },
      facts,
      warnings: warnings("external_meta"),
      material: { kind: a.kind, name, sourceId: a.sourceId ?? "", event: a.event ?? "", days: a.retentionDays ?? 0, pixel: a.pixelAssetId ?? "", url: a.urlContains ?? "" },
    });
  },
  async run(ctx, a) {
    const m = await audiences();
    await m.assertAudienceWriteRate(actorOf(ctx).tenantId);
    const out = await m.createAudience(actorOf(ctx), ruleBody(a), { dryRun: await promoteDryRun() });
    return { result: out, auditTarget: out.audience.id };
  },
  forModel: (r) => ({ audience: audienceForModel(r.audience), notice: r.notice ?? null }),
});

type LookalikeArgs = { seedAudienceId: string; percent: number; name?: string };

const createLookalike = define<LookalikeArgs, CreateResult>({
  name: "create_lookalike",
  version: "v1",
  area: "ads",
  surfaces: ["eddy"],
  titleKey: "status.create_lookalike",
  description:
    "Makes a lookalike audience on Meta: people in India like those in a ready audience of at least 100 people (1% is most similar, 10% reaches most), after a card. Not offered for ads about jobs, housing, loans or social issues. Nothing is spent until an ad uses it. Owners and admins only.",
  inputSchema: obj({ seedAudienceId: id("The audience to find people like (list_audiences)."), percent: int("How similar: 1 (closest) to 10 (widest).", LOOKALIKE.minPercent, LOOKALIKE.maxPercent), name: str("The audience's name.", 100) }, ["seedAudienceId", "percent"]),
  minRole: "admin",
  route: { method: "POST", path: "/api/promote/audiences" },
  effects: { writes: true, external: true },
  callsMeta: true,
  untrustedPaths: AUDIENCE_UNTRUSTED,
  async authorize(ctx) {
    await assertPromoteWrite(ctx);
    await assertKindOffered("lookalike");
  },
  async preview(ctx, a) {
    const seed = await audienceOf(ctx, a.seedAudienceId);
    const { translateKey } = await import("@/lib/eddy/i18n");
    return preview({
      titleKey: "card.create_lookalike.title",
      confirmLabelKey: "card.create_lookalike.confirm",
      vars: { percent: a.percent, seed: u("workspace_text", seed.name, 100) },
      facts: [
        { labelKey: "fact.promote.seed", value: u("workspace_text", seed.name, 100) },
        { labelKey: "fact.promote.percent", value: `${a.percent}%` },
        ...(seed.sizeLine ? [{ labelKey: "fact.promote.audience", value: seed.sizeLine }] : []),
        { labelKey: "fact.promote.note", value: translateKey(ctx.p.lang, "eddy_promote.audience_note") },
      ],
      warnings: warnings("external_meta"),
      material: { seedAudienceId: seed.id, seedStatus: seed.status, percent: a.percent, name: a.name ?? "" },
    });
  },
  async run(ctx, a) {
    const m = await audiences();
    await m.assertAudienceWriteRate(actorOf(ctx).tenantId);
    const out = await m.createAudience(actorOf(ctx), { kind: "lookalike", seedAudienceId: a.seedAudienceId, percent: a.percent, ...(a.name ? { name: a.name } : {}) }, { dryRun: await promoteDryRun() });
    return { result: out, auditTarget: out.audience.id };
  },
  forModel: (r) => ({ audience: audienceForModel(r.audience), notice: r.notice ?? null }),
});

// ===== Customer lists (X, P, B; PROMOTE_AUDIENCES=all; no card under a freeze; people only) =====

type Selection = { segmentId?: string; tag?: string };
type Sample = { name: UntrustedText | null; phoneMasked: string };

/** Up to 3 consented contacts of the selection, masked (6.5): the name as the contact wrote it, the phone with its middle hidden. */
export async function maskedSamples(ctx: ActionCtx, sel: Selection): Promise<Sample[]> {
  const prisma = await db();
  const tenantId = actorOf(ctx).tenantId;
  let idsIn: string[] | null = null;
  if (sel.segmentId) {
    const { matchingContactIds, resolveFilters } = await import("@/lib/segments/service");
    const filters = await resolveFilters(tenantId, { segmentId: sel.segmentId });
    idsIn = (await matchingContactIds(tenantId, { tenantId, ...(sel.tag ? { tags: { has: sel.tag } } : {}) }, filters)).sort().slice(0, 200);
  }
  const rows = (await prisma.contact.findMany({
    where: { tenantId, optIn: true, optedOutAt: null, phone: { not: null }, ...(idsIn ? { id: { in: idsIn } } : {}), ...(sel.tag ? { tags: { has: sel.tag } } : {}) },
    select: { id: true, name: true, phone: true },
    orderBy: { id: "asc" },
    take: 3,
  })) as { id: string; name: string | null; phone: string | null }[];
  const { maskPhone } = await import("@/lib/teams/visibility");
  return rows.filter((r) => r.phone).map((r) => ({ name: uOrNull("contact_name", r.name, 80), phoneMasked: maskPhone(r.phone as string) }));
}

/** The customer-list card (6.5): "Share {count} contacts with Meta?", the count, 3 masked samples, hashing and who is included. */
export async function customerListPreview(ctx: ActionCtx, sel: Selection, count: CustomerCount, opts: { titleKey: string; confirmLabelKey: string; name: string; material: Record<string, string | number> }): Promise<Preview> {
  const [{ translateKey }, { promoteText, formatCount }] = await Promise.all([import("@/lib/eddy/i18n"), import("@/lib/promote/copy")]);
  const lang = promoteLangOf(ctx);
  const shown = formatCount(count.included);
  return preview({
    titleKey: opts.titleKey,
    confirmLabelKey: opts.confirmLabelKey,
    vars: { count: shown, name: u("workspace_text", opts.name, 100) },
    facts: [
      { labelKey: "fact.promote.audience", value: u("workspace_text", opts.name, 100) },
      { labelKey: "fact.promote.count", value: count.line },
      { labelKey: "fact.promote.hashing", value: promoteText("audience.upload", { count: shown }, lang) },
      { labelKey: "fact.promote.basis", value: translateKey(ctx.p.lang, "eddy_promote.basis") },
    ],
    recipients: { count: count.included, sample: await maskedSamples(ctx, sel) },
    warnings: warnings("external_meta", count.included > 1000 && "large_audience"),
    material: { included: count.included, total: count.total, ...opts.material },
  });
}

/** Everything a customer-list card needs before it is shown: a person, an admin, the flag at `all`, and no freeze (6.6). */
async function assertCustomerListAllowed(ctx: ActionCtx): Promise<void> {
  requirePerson(ctx);
  await assertPromoteWrite(ctx);
  await assertKindOffered("customer_list");
  await assertNoFreeze(ctx);
}

const tooSmall = async () => new HttpError(409, (await import("@/lib/promote/copy")).promoteText("audience.too_small"));

type CustomerArgs = { name?: string; segmentId?: string; tag?: string };

const createCustomerAudience = define<CustomerArgs, CreateResult>({
  name: "create_customer_audience",
  version: "v1",
  area: "ads",
  surfaces: ["eddy"],
  titleKey: "status.create_customer_audience",
  description:
    "Shares the contacts of a segment or tag who agreed to get marketing messages with Meta as a customer list, to find them (or people like them) on Facebook and Instagram, after a card with the count and 3 masked samples. Phone numbers and emails are hashed before they leave Edwyz. Not offered while spending is stopped. Owners and admins only.",
  inputSchema: obj({ name: str("The list's name.", 100), segmentId: id("The segment (from list_segments)."), tag: str("A contact tag.", 100, 1) }),
  minRole: "admin",
  route: { method: "POST", path: "/api/promote/audiences" },
  effects: { writes: true, external: true, exportsPii: true, bulk: true },
  callsMeta: true,
  untrustedPaths: AUDIENCE_UNTRUSTED,
  async authorize(ctx, a) {
    if (!a.segmentId && !a.tag) throw new HttpError(400, "Choose a segment or a tag.");
    await assertCustomerListAllowed(ctx);
  },
  async preview(ctx, a) {
    const sel: Selection = { ...(a.segmentId ? { segmentId: a.segmentId } : {}), ...(a.tag ? { tag: a.tag } : {}) };
    const count = await (await audiences()).previewCustomerList(actorOf(ctx), sel);
    if (count.tooSmall) throw await tooSmall();
    const name = a.name?.trim() || "Past customers";
    return customerListPreview(ctx, sel, count, { titleKey: "card.create_customer_audience.title", confirmLabelKey: "card.create_customer_audience.confirm", name, material: { segmentId: a.segmentId ?? "", tag: a.tag ?? "", name } });
  },
  async run(ctx, a) {
    const m = await audiences();
    await m.assertAudienceWriteRate(actorOf(ctx).tenantId);
    const out = await m.createAudience(actorOf(ctx), { kind: "customer_list", ...(a.name ? { name: a.name } : {}), ...(a.segmentId ? { segmentId: a.segmentId } : {}), ...(a.tag ? { tag: a.tag } : {}) }, { dryRun: await promoteDryRun() });
    return { result: out, auditTarget: out.audience.id };
  },
  forModel: (r) => ({ audience: audienceForModel(r.audience), count: r.count?.line ?? null, notice: r.notice ?? null }),
  piiItems: (r) => Math.min(3, r.count?.included ?? 0),
});

const refreshCustomerAudience = define<{ audienceId: string }, RefreshResult>({
  name: "refresh_customer_audience",
  version: "v1",
  area: "ads",
  surfaces: ["eddy"],
  titleKey: "status.refresh_customer_audience",
  description:
    "Updates a customer list on Meta with the contacts who agree to marketing now (people who opted out are removed), after a card with the count and 3 masked samples. Hashed before it leaves Edwyz. Not offered while spending is stopped. Owners and admins only.",
  inputSchema: obj({ audienceId: id("The customer list (from list_audiences).") }, ["audienceId"]),
  minRole: "admin",
  route: { method: "POST", path: "/api/promote/audiences/[id]/refresh" },
  effects: { writes: true, external: true, exportsPii: true, bulk: true },
  callsMeta: true,
  untrustedPaths: AUDIENCE_UNTRUSTED,
  async authorize(ctx, a) {
    await assertCustomerListAllowed(ctx);
    const audience = await audienceOf(ctx, a.audienceId);
    if (audience.kind !== "customer_list") throw new HttpError(400, "Only customer lists are updated this way.");
  },
  async preview(ctx, a) {
    const audience = await audienceOf(ctx, a.audienceId);
    const sel = asRecord(asRecord(audience.details).selection) as Selection;
    const count = await (await audiences()).previewCustomerList(actorOf(ctx), sel);
    if (count.tooSmall) throw await tooSmall();
    return customerListPreview(ctx, sel, count, { titleKey: "card.refresh_customer_audience.title", confirmLabelKey: "card.refresh_customer_audience.confirm", name: audience.name, material: { audienceId: audience.id, status: audience.status } });
  },
  async run(ctx, a) {
    const m = await audiences();
    await m.assertAudienceWriteRate(actorOf(ctx).tenantId);
    const out = await m.refreshAudience(actorOf(ctx), a.audienceId, { dryRun: await promoteDryRun() });
    return { result: out, auditTarget: a.audienceId };
  },
  forModel: (r) => ({ audience: audienceForModel(r.audience), count: r.count?.line ?? null, notice: r.notice ?? null }),
  piiItems: (r) => Math.min(3, r.count?.included ?? 0),
});

// ===== delete_audience (D, X, I: a danger card) =====

const deleteAudience = define<{ audienceId: string }, { deleted: boolean; dryRun: boolean; audienceId: string }>({
  name: "delete_audience",
  version: "v1",
  area: "ads",
  surfaces: ["eddy"],
  titleKey: "status.delete_audience",
  description: "Deletes an audience, on Meta too, after a danger card. Meta can't bring it back, and ads that use it stop reaching those people. Owners and admins only.",
  inputSchema: obj({ audienceId: id("The audience (from list_audiences).") }, ["audienceId"]),
  minRole: "admin",
  route: { method: "DELETE", path: "/api/promote/audiences/[id]" },
  effects: { writes: true, deletes: true, external: true, irreversible: true },
  callsMeta: true,
  untrustedPaths: [],
  async authorize(ctx, a) {
    requirePerson(ctx);
    await assertPromoteWrite(ctx);
    await audienceOf(ctx, a.audienceId);
  },
  async preview(ctx, a) {
    const audience = await audienceOf(ctx, a.audienceId);
    const { translateKey } = await import("@/lib/eddy/i18n");
    return preview({
      titleKey: "card.delete_audience.title",
      confirmLabelKey: "card.delete_audience.confirm",
      vars: { name: u("workspace_text", audience.name, 100) },
      facts: [
        { labelKey: "fact.promote.audience", value: u("workspace_text", audience.name, 100) },
        { labelKey: "fact.promote.kind", value: audience.kind.replace(/_/g, " ") },
        ...(audience.sizeLine ? [{ labelKey: "fact.promote.count", value: audience.sizeLine }] : []),
        { labelKey: "fact.promote.note", value: translateKey(ctx.p.lang, "eddy_promote.audience_delete_note") },
      ],
      warnings: warnings("irreversible", "external_meta"),
      danger: true,
      material: { audienceId: audience.id, status: audience.status },
    });
  },
  async run(ctx, a) {
    const out = await (await audiences()).deleteAudience(actorOf(ctx), a.audienceId, { dryRun: await promoteDryRun() });
    return { result: { ...out, audienceId: a.audienceId }, auditTarget: a.audienceId };
  },
  forModel: (r) => ({ audienceId: r.audienceId, deleted: r.deleted, note: "Deleted. Meta can't bring it back." }),
});

/** Eddy's audience tools, sorted by name. */
export const AUDIENCE_DEFS = [
  createAudience,
  createCustomerAudience,
  createLookalike,
  deleteAudience,
  getAudience,
  getAudienceSize,
  listAudiences,
  refreshCustomerAudience,
  saveAudience,
  searchInterests,
  searchPlaces,
];
