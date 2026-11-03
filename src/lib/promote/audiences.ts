/**
 * Audiences for Instagram and Facebook Page ads (docs/IG-PAGE-ADS-SPEC.md 3.7, D17, 4.2 A1 to A6, 4.8, 4.10, 5.1, 5.5, 6.5,
 * 11.1a decision 3, PRM-11).
 *
 * Kinds, and the flag level that offers each (PROMOTE_AUDIENCES, read through flags.effectiveAudiences):
 * - off: saved audiences only. A saved audience is local: a name and a targeting, validated by ads/targeting.ts and sent
 *   inline at launch (Meta's saved-audience edge is read-only).
 * - engagement: also people who engaged with the Instagram account or the Page (365 days by default, up to 730), with a lead
 *   form (opened or submitted, up to 90 days), website visitors from a pixel (30 days by default, up to 180, optionally only
 *   pages whose address contains a word), and lookalikes (India, 1% to 10%, from a seed of at least 100 people, never for a
 *   special ad category). All with prefill, so people from before the audience existed count.
 * - all: also customer lists, and in production only with LEGAL_DPDP_AUDIENCES_OK=1 (the lawyer review).
 *
 * Customer lists (D17, 11.1a decision 3):
 * - Only contacts with a recorded marketing opt-in who have not opted out are included: the consent rule is contacts/opt-out.ts
 *   mayReceive(contact, "marketing"), imported, never copied. An erased contact no longer exists, so it can't be included.
 *   consentBasis is always 'marketing_opt_in'. The count line reads "1,240 of 1,610 contacts can be included."
 * - Under 100 people the audience is too_small and nothing is sent to Meta (not even a read).
 * - Then Meta's Custom Audience terms are read (C4); when they are not accepted, nothing is created and the answer carries
 *   the custom_audience_tos fix (Opens Meta).
 * - A1 creates the audience inside the request, which then only opens an upload (AdAudienceUpload, queued) and answers 202.
 *   The people are sent by the promote.audiences.uploads task (every 2 minutes, at most 30 seconds of sending a run,
 *   sendQueuedUploads), so a big list never holds a request past the proxy's 60 seconds, and a retried request can't make a
 *   second list on Meta. A2 sends the people in one session, at most 10,000 rows a request, batch_seq 1, 2, 3 and
 *   last_batch_flag on the last. AdAudienceUpload holds counts only (no hashes, no ids). Progress is stored after every batch,
 *   so the next run resumes at the next batch_seq of the same session and never sends a batch Meta acknowledged again. Uploads
 *   run at throttle priority 4: when Meta's usage headers say it is busy, the upload pauses and the next run resumes it. The
 *   contacts are chosen again on every run, so a person who withdrew in between is never sent.
 * - Every run checks the flags before it reads a contact: when customer lists are switched off (PROMOTE_AUDIENCES below all,
 *   or production without LEGAL_DPDP_AUDIENCES_OK=1), an open upload is closed as failed and nothing more is sent.
 * - A refresh replaces the people (A3 usersreplace, which keeps the ad delivery's learning) with the contacts who are
 *   consented now, through the same upload task. People who withdraw in between are removed by forget.ts (A4).
 * - At most 50 customer lists per workspace (5.5).
 *
 * Delete calls Meta first (A6) and only then sets deletedAt. Meta's errors 2655 and 1870090 (audience terms) and 471/1713232
 * (a flagged audience) are told in the 4.10 copy; every other Meta error in plain words too (plainAudienceError). Every Meta
 * call goes through promote/meta.ts (not_spend; the user token of the workspace's spending ad account). Under SPEND_DRY_RUN
 * Meta-backed audiences answer with fake ids and nothing is stored. Nothing here logs a contact, an email, a phone number or a
 * hash.
 */
import { randomInt } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { parseTargeting, toMetaTargeting, validateTargeting } from "@/lib/ads/targeting";
import { SPECIAL_CATEGORIES, type SpecialAdCategory, type Targeting } from "@/lib/ads/types";
import { mayReceive } from "@/lib/contacts/opt-out";
import { GraphError } from "@/lib/graph";
import { opensMetaLink } from "@/lib/meta-connect/meta-screens";
import { createLimiter } from "@/lib/ratelimit";
import { type Actor, HttpError } from "@/lib/tenancy";
import { AUDIENCE_EVENTS, LOOKALIKE, lookalikeRatio, MAX_CUSTOMER_LISTS, MAX_UPLOAD_ROWS, MIN_AUDIENCE_PEOPLE, retentionBounds, type AudienceEventKind, type AudienceEventRow } from "./catalog/audience-events";
import { promoteText } from "./copy";
import { effectiveAudiences, type PromoteAudiences } from "./flags";
import { audienceSize, type AudienceSize, sizeCache, sizeLine } from "./geo";
import { contactEmail, CUSTOMER_SCHEMA, customerRow, identityRow } from "./hashing";
import type { AdCtx, AudienceInfo, AudienceSpec as MetaAudienceSpec, PromoteMeta } from "./meta";
import { classifyMetaError, metaErrorText } from "./review-reasons";
import { PromoteThrottledError } from "./throttle";

type Env = Record<string, string | undefined>;

// =====================================================================================================================
// Kinds, levels and limits
// =====================================================================================================================

export const AUDIENCE_KINDS = ["saved", "customer_list", "engagement_instagram", "engagement_page", "engagement_lead_form", "website", "lookalike"] as const;
export type AudienceKind = (typeof AUDIENCE_KINDS)[number];
export const isAudienceKind = (v: unknown): v is AudienceKind => typeof v === "string" && (AUDIENCE_KINDS as readonly string[]).includes(v);

export const AUDIENCE_STATUSES = ["draft", "creating", "populating", "ready", "too_small", "error", "deleted"] as const;
export type AudienceStatus = (typeof AUDIENCE_STATUSES)[number];

/** The Eddy action (6.4) each kind is made by: one POST /api/promote/audiences, the body's kind choosing. */
export type AudienceAction = "save_audience" | "create_audience" | "create_customer_audience" | "create_lookalike";
export const AUDIENCE_ACTION: Readonly<Record<AudienceKind, AudienceAction>> = Object.freeze({
  saved: "save_audience",
  customer_list: "create_customer_audience",
  engagement_instagram: "create_audience",
  engagement_page: "create_audience",
  engagement_lead_form: "create_audience",
  website: "create_audience",
  lookalike: "create_lookalike",
});

/** What each PROMOTE_AUDIENCES level offers (1.4, D17). */
export const KINDS_BY_LEVEL: Readonly<Record<PromoteAudiences, readonly AudienceKind[]>> = Object.freeze({
  off: ["saved"],
  engagement: ["saved", "engagement_instagram", "engagement_page", "engagement_lead_form", "website", "lookalike"],
  all: AUDIENCE_KINDS,
});

/** The kinds offered now: customer lists only with PROMOTE_AUDIENCES=all, and in production only with LEGAL_DPDP_AUDIENCES_OK=1. */
export function allowedKinds(env: Env = process.env): AudienceKind[] {
  return [...KINDS_BY_LEVEL[effectiveAudiences(env)]];
}

export const kindAllowed = (kind: AudienceKind, env: Env = process.env): boolean => allowedKinds(env).includes(kind);

/**
 * Whether an audience of this stored kind may be used now: a known kind the flags offer. ads/service.ts (loadAudiences) asks it
 * at launch, so lowering PROMOTE_AUDIENCES, or production losing LEGAL_DPDP_AUDIENCES_OK, stops existing customer lists (and,
 * at off, every Meta audience) from going into new ad sets.
 */
export const audienceKindOffered = (kind: unknown, env: Env = process.env): boolean => isAudienceKind(kind) && kindAllowed(kind, env);

/** The only lawful basis used for now (11.1a decision 3). */
export const CONSENT_BASIS = "marketing_opt_in";
/** A customer list reads at most this many contacts (the segment scan's own bound). */
export const MAX_LIST_CONTACTS = 200_000;
/** Audience creates and refreshes per workspace an hour (4.8). */
export const AUDIENCE_WRITES_PER_HOUR = 10;
/** The 6-hourly sync reads an audience again once its last read is this old, and at most this many per run. */
export const SYNC_STALE_MS = 5 * 3_600_000;
export const SYNC_BATCH = 200;
/** A replace session lasts 90 minutes on Meta; one older than this starts again. Add sessions start again after a day. */
export const REPLACE_SESSION_MS = 80 * 60_000;
export const ADD_SESSION_MS = 24 * 3_600_000;
/**
 * The upload task (promote.audiences.uploads, every 2 minutes) starts no new batch after this long, so a run, even with one
 * slow batch (60 seconds at most), ends before the next one may start. It looks at this many open uploads a run.
 */
export const UPLOAD_RUN_MS = 30_000;
export const UPLOAD_BATCH = 50;

const NAME_MAX = 100;
const URL_WORD_MAX = 100;
const TAG_MAX = 100;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export const AUDIENCE_COPY = {
  json: "Send the audience as JSON.",
  chooseKind: "Choose what kind of audience to make.",
  savedOnly: "Only saved audiences are available for now.",
  customerListsOff: "Customer lists aren't available yet. Use people who engaged or website visitors for now.",
  noAccount: "Choose a spending ad account in Settings > Spending limits first. Audiences are made on that account.",
  otherAccount: "This audience is on another ad account. Make a new one on your spending ad account.",
  tooManyLists: `You can have up to ${MAX_CUSTOMER_LISTS} customer lists. Delete one you no longer use, then try again.`,
  tooManyWrites: `You can make or refresh up to ${AUDIENCE_WRITES_PER_HOUR} audiences an hour. Try again later.`,
  notFound: "Audience not found.",
  name: `Give the audience a name of up to ${NAME_MAX} characters.`,
  tag: `Choose a tag of up to ${TAG_MAX} characters.`,
  segment: "Choose a valid segment.",
  tooBig: "A customer list can hold up to 2,00,000 contacts. Pick a smaller segment or tag.",
  chooseSource: "Choose where people engaged.",
  chooseEvent: "Choose what people did.",
  noPixel: "Set up a website pixel first. You can create one from the readiness list.",
  urlWord: `The address word can be up to ${URL_WORD_MAX} characters.`,
  chooseSeed: "Choose the audience to find people like.",
  seedNotReady: "That audience isn't ready yet. Wait until it shows Ready, then try again.",
  seedTooSmall: "Lookalikes need a source audience of at least 100 people. Pick a bigger audience.",
  seedCustomerList: "Customer lists aren't available yet. Pick people who engaged or website visitors.",
  special: "Meta doesn't allow lookalike audiences for ads about jobs, housing, loans or social issues.",
  percent: `Pick ${LOOKALIKE.minPercent}% to ${LOOKALIKE.maxPercent}%.`,
  category: "Choose a special ad category, or none.",
  savedNoRefresh: "Saved audiences are kept in Edwyz and don't need refreshing.",
  gone: "This audience is gone from Meta. Delete it here too.",
  failed: "Meta couldn't build this audience. Delete it and make a new one.",
  uploadFailed: "We couldn't send the whole list to Meta. Tap Refresh to try again.",
  busy: "Meta is busy. We'll keep sending your list and finish it later.",
  sending: "We're sending your list to Meta. It takes a few minutes.",
  stillSending: "We're still sending this list to Meta. Check again in a few minutes.",
  listsOff: "Customer lists are switched off, so we stopped sending this list to Meta.",
  uploadDeleted: "This audience was deleted, so we stopped sending it.",
  uploadReplaced: "A newer refresh of this list took over.",
  targeting: "Choose who should see the ad.",
  reconnect: "Your Facebook connection needs a refresh. Reconnect Facebook in Settings, then try again.",
  noPermission: "Meta didn't let Edwyz manage audiences on this ad account. Reconnect Facebook and allow ads access, then try again.",
  maybeMade: "Meta didn't confirm this in time. It may already be made. Check your audiences before you try again.",
  noAnswer: "Meta didn't answer in time. Try again in a minute.",
  metaDown: "Meta isn't answering right now. Try again in a few minutes.",
  refused: "Meta didn't accept this audience. Check its settings, then try again.",
  refusedDelete: "Meta didn't delete this audience. If an ad set or a lookalike uses it, remove it there first, then try again.",
  readFailed: "Meta couldn't read this audience right now. Try again later.",
} as const;

export const retentionCopy = (maxDays: number): string => `Choose between 1 and ${maxDays} days.`;

// =====================================================================================================================
// Errors (4.10)
// =====================================================================================================================

export type AudienceProblemKind = "custom_audience_tos" | "audience_flagged";
export type AudienceFix = { kind: "opens_meta"; key: "custom_audience_tos"; labelKey: string; href: string | null };

/**
 * An answer that carries a fix: Meta's audience terms are missing (409, the custom_audience_tos Opens Meta link), or Meta flagged
 * the audience (422, no fix). The routes send it as {error, kind, fix}.
 */
export class AudienceFixError extends HttpError {
  readonly kind: AudienceProblemKind;
  readonly fix: AudienceFix | null;
  constructor(kind: AudienceProblemKind, fix: AudienceFix | null) {
    super(kind === "custom_audience_tos" ? 409 : 422, metaErrorText(kind));
    this.name = "AudienceFixError";
    this.kind = kind;
    this.fix = fix;
  }

  response(): Response {
    return Response.json({ error: this.message, kind: this.kind, fix: this.fix }, { status: this.status, headers: { "cache-control": "no-store" } });
  }
}

/** Which 4.10 audience row Meta's error is: 2655 or 100/1870090 (terms), 471 or subcode 1713232 (flagged); else null. */
export function audienceErrorKind(error: unknown): AudienceProblemKind | null {
  if (!(error instanceof GraphError)) return null;
  if (error.code === 471 || error.status === 471) return "audience_flagged";
  const kind = classifyMetaError({ code: error.code ?? null, subcode: error.subcode ?? null, status: error.status });
  return kind === "custom_audience_tos" || kind === "audience_flagged" ? kind : null;
}

/** The terms fix for the ad account (its "Opens Meta" link; null href when the account id is unknown). */
export function termsFix(act: string | null | undefined): AudienceFix {
  const link = opensMetaLink("custom_audience_tos", { act: act ?? null });
  return { kind: "opens_meta", key: "custom_audience_tos", labelKey: link?.labelKey ?? "error.custom_audience_tos", href: link?.href ?? null };
}

/** Meta's error as the 4.10 answer, or the error itself when it is none of those rows. */
export function toAudienceError(error: unknown, act: string | null | undefined): unknown {
  const kind = audienceErrorKind(error);
  if (kind === "custom_audience_tos") return new AudienceFixError(kind, termsFix(act));
  if (kind === "audience_flagged") return new AudienceFixError(kind, null);
  return error;
}

/** What the call was doing, for the plain words of a refusal. */
export type AudienceStep = "create" | "read" | "delete";

/**
 * Meta's error in plain words, so no Graph error reaches a route as "Something went wrong.": the 4.10 rows first
 * (toAudienceError), then 190 (the token was revoked: reconnect, 409), 10 or 200 to 299 (no ads permission on the ad account:
 * reconnect and allow it, 403), a write that may have landed (504: check before trying again; a delete can simply be tried
 * again, since one Meta no longer has counts as deleted), Meta down (503), and anything else as Meta refusing this, with what to
 * do (502). HttpErrors (busy, timeouts, our own refusals) pass through. Meta's own text is never shown.
 */
export function plainAudienceError(error: unknown, act: string | null | undefined, step: AudienceStep): unknown {
  const mapped = toAudienceError(error, act);
  if (!(mapped instanceof GraphError)) return mapped;
  if (step === "read" && isGone(mapped)) return new HttpError(409, AUDIENCE_COPY.gone);
  if (mapped.ambiguous) return new HttpError(504, step === "create" ? AUDIENCE_COPY.maybeMade : AUDIENCE_COPY.noAnswer);
  const code = mapped.code;
  if (code === 190) return new HttpError(409, AUDIENCE_COPY.reconnect);
  if (code === 10 || (typeof code === "number" && code >= 200 && code < 300)) return new HttpError(403, AUDIENCE_COPY.noPermission);
  if (mapped.status >= 500 || mapped.retryable || classifyMetaError({ code: code ?? null, subcode: mapped.subcode ?? null }) === "meta_busy") return new HttpError(503, AUDIENCE_COPY.metaDown);
  return new HttpError(502, step === "delete" ? AUDIENCE_COPY.refusedDelete : step === "read" ? AUDIENCE_COPY.readFailed : AUDIENCE_COPY.refused);
}

/** Meta no longer has the object (error 100, subcode 33). */
const isGone = (error: unknown): boolean => error instanceof GraphError && error.code === 100 && error.subcode === 33;

/** A failure that a later try of the same batch can fix: Meta busy, no answer in time, or a server error. */
function isResumable(error: unknown): boolean {
  if (error instanceof PromoteThrottledError) return true;
  if (error instanceof HttpError && (error as { name?: string }).name === "PromoteMetaError") return true;
  return error instanceof GraphError && (error.status >= 500 || error.retryable || error.ambiguous);
}

// =====================================================================================================================
// Records and dependencies
// =====================================================================================================================

export type AudienceRecord = {
  id: string;
  tenantId: string;
  adAccountAssetId: string | null;
  kind: AudienceKind;
  name: string;
  metaAudienceId: string | null;
  spec: Record<string, unknown>;
  status: AudienceStatus;
  sizeLower: number | null;
  sizeUpper: number | null;
  deliveryStatus: string | null;
  consentBasis: string | null;
  rowsUploaded: number;
  lastSyncedAt: Date | null;
  lastError: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  deletedAt: Date | null;
};

export type NewAudience = Pick<AudienceRecord, "tenantId" | "adAccountAssetId" | "kind" | "name" | "metaAudienceId" | "spec" | "status" | "consentBasis" | "createdByUserId"> & {
  lastError?: string | null;
};
export type AudiencePatch = Partial<Pick<AudienceRecord, "metaAudienceId" | "status" | "sizeLower" | "sizeUpper" | "deliveryStatus" | "rowsUploaded" | "lastSyncedAt" | "lastError" | "deletedAt">>;

export type UploadMode = "add" | "replace" | "remove";
export type UploadStatus = "queued" | "running" | "done" | "failed";
/** One upload session: counts only, no hashes and no contact ids (5.1). */
export type UploadRecord = {
  id: string;
  tenantId: string;
  audienceId: string;
  sessionId: number;
  mode: UploadMode;
  totalRows: number;
  sentRows: number;
  /** The last batch_seq Meta acknowledged; 0 before the first. */
  batchSeq: number;
  status: UploadStatus;
  startedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
};
export type NewUpload = Omit<UploadRecord, "id" | "finishedAt" | "error"> & { requestedByUserId: string | null };
export type UploadPatch = Partial<Pick<UploadRecord, "sentRows" | "batchSeq" | "status" | "startedAt" | "finishedAt" | "error">>;

export type AudienceStore = {
  /** The workspace's audiences that are not deleted, newest first. */
  list(tenantId: string): Promise<AudienceRecord[]>;
  get(tenantId: string, id: string): Promise<AudienceRecord | null>;
  /** Customer lists that are not deleted. */
  countCustomerLists(tenantId: string): Promise<number>;
  create(data: NewAudience): Promise<AudienceRecord>;
  update(tenantId: string, id: string, patch: AudiencePatch): Promise<void>;
  /** Meta-backed audiences of every workspace not read since `before`, oldest read first. */
  dueForSync(before: Date, limit: number): Promise<AudienceRecord[]>;
  /** The upload of this audience that has not finished (queued or running), if any: the newest. */
  openUpload(tenantId: string, audienceId: string): Promise<UploadRecord | null>;
  /**
   * Unfinished uploads (queued or running) of every workspace, for the upload task: the ones whose audience changed longest ago
   * first (every try writes to the audience), so an upload that keeps pausing goes behind the others.
   */
  openUploads(limit: number): Promise<UploadRecord[]>;
  createUpload(data: NewUpload): Promise<UploadRecord>;
  updateUpload(id: string, patch: UploadPatch): Promise<void>;
};

/** A segment of the workspace, a tag, both (people in the segment with the tag), or neither (every contact). */
export type CustomerSelection = { segmentId?: string; tag?: string };

/** What a customer list needs to know about a contact. The email is Contact.attributes.email. */
export type CustomerContact = { id: string; phone: string | null; email: string | null; name: string | null; optIn: boolean; optedOutAt: Date | string | null };

export type CustomerContacts = {
  /** Every contact of the selection, whatever their consent, in id order. Consent is judged here, not by the source. */
  scan(tenantId: string, selection: CustomerSelection): Promise<CustomerContact[]>;
};

export type SpendingAccount = { assetId: string; externalId: string };

export type AudienceWorkspace = {
  /** The Phase 0 spending ad account (D3), active, or null. Audiences are made on it. */
  spendingAccount(tenantId: string): Promise<SpendingAccount | null>;
  /** The Meta id of one of the workspace's event sources: a Page or Instagram asset, or a lead form. Null when it has none. */
  source(tenantId: string, type: "page" | "instagram" | "lead_form", id: string): Promise<{ metaId: string; name: string | null } | null>;
  /** The given pixel (a dataset asset) of the workspace, else the spending account's first one. */
  pixel(tenantId: string, account: SpendingAccount, pixelAssetId: string | null): Promise<{ assetId: string; metaId: string } | null>;
  /** The brand kit's special ad category, or none. */
  specialCategory(tenantId: string): Promise<SpecialAdCategory>;
};

export type AudienceMeta = Pick<PromoteMeta, "createCustomAudience" | "addAudienceUsers" | "replaceAudienceUsers" | "getAudience" | "deleteAudience" | "getAdAccountHealth" | "estimateReach">;

export type AudienceDeps = {
  store: AudienceStore;
  contacts: CustomerContacts;
  workspace: AudienceWorkspace;
  meta: AudienceMeta;
  audit: (entry: { tenantId: string; userId: string | null; action: string; target?: string; meta?: Record<string, string | number | boolean | null> }) => Promise<void>;
  env: Env;
  now: () => number;
  /** A new upload session id (Meta wants a 64-bit number; a random safe integer). */
  sessionId: () => number;
  /** SPEND_DRY_RUN: Meta answers with fake ids, and nothing Meta-backed is stored. */
  dryRun: boolean;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const numOrNull = (v: unknown): number | null => (typeof v === "bigint" ? Number(v) : typeof v === "number" && Number.isFinite(v) ? v : null);
const actNumber = (externalId: string) => externalId.replace(/^act_/, "");

type AdAudienceRow = {
  id: string;
  tenantId: string;
  adAccountAssetId: string | null;
  kind: string;
  name: string;
  metaAudienceId: string | null;
  spec: unknown;
  status: string;
  sizeLower: bigint | number | null;
  sizeUpper: bigint | number | null;
  deliveryStatus: string | null;
  consentBasis: string | null;
  rowsUploaded: number;
  lastSyncedAt: Date | null;
  lastError: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  deletedAt: Date | null;
};

function toRecord(r: AdAudienceRow): AudienceRecord {
  return {
    id: r.id,
    tenantId: r.tenantId,
    adAccountAssetId: r.adAccountAssetId,
    kind: (isAudienceKind(r.kind) ? r.kind : "saved") as AudienceKind,
    name: r.name,
    metaAudienceId: r.metaAudienceId,
    spec: isObject(r.spec) ? r.spec : {},
    status: ((AUDIENCE_STATUSES as readonly string[]).includes(r.status) ? r.status : "error") as AudienceStatus,
    sizeLower: numOrNull(r.sizeLower),
    sizeUpper: numOrNull(r.sizeUpper),
    deliveryStatus: r.deliveryStatus,
    consentBasis: r.consentBasis,
    rowsUploaded: r.rowsUploaded ?? 0,
    lastSyncedAt: r.lastSyncedAt ?? null,
    lastError: r.lastError ?? null,
    createdByUserId: r.createdByUserId ?? null,
    createdAt: r.createdAt,
    deletedAt: r.deletedAt ?? null,
  };
}

type UploadRow = Omit<UploadRecord, "sessionId" | "mode" | "status"> & { sessionId: bigint | number; mode: string; status: string };

const toUpload = (r: UploadRow): UploadRecord => ({ ...r, sessionId: Number(r.sessionId), mode: r.mode as UploadMode, status: r.status as UploadStatus });

const bigOrNull = (v: number | null | undefined) => (v === undefined ? undefined : v === null ? null : BigInt(Math.max(0, Math.round(v))));

type DefaultModules = [typeof import("@/lib/db"), typeof import("./meta"), typeof import("@/lib/auth/audit")];
let defaultModules: Promise<DefaultModules> | null = null;

/**
 * The database, the Meta client and the audit writer, loaded on first use and shared: the worker starts the 6-hourly sync and
 * the upload task in the same pass, and one load serves both (a failed load is tried again next time).
 */
function loadDefaultModules(): Promise<DefaultModules> {
  defaultModules ??= Promise.all([import("@/lib/db"), import("./meta"), import("@/lib/auth/audit")]).catch((error: unknown) => {
    defaultModules = null;
    throw error;
  });
  return defaultModules;
}

async function defaultDeps(): Promise<Omit<AudienceDeps, "dryRun">> {
  const [{ prisma }, { promoteMeta }, { audit }] = await loadDefaultModules();
  const store: AudienceStore = {
    list: async (tenantId) =>
      ((await prisma.adAudience.findMany({ where: { tenantId, deletedAt: null }, orderBy: { createdAt: "desc" }, take: 500 })) as AdAudienceRow[]).map(toRecord),
    get: async (tenantId, id) => {
      const row = (await prisma.adAudience.findFirst({ where: { id, tenantId } })) as AdAudienceRow | null;
      return row ? toRecord(row) : null;
    },
    countCustomerLists: (tenantId) => prisma.adAudience.count({ where: { tenantId, kind: "customer_list", deletedAt: null } }),
    create: async (data) =>
      toRecord(
        (await prisma.adAudience.create({
          data: {
            tenantId: data.tenantId,
            adAccountAssetId: data.adAccountAssetId,
            kind: data.kind,
            name: data.name,
            metaAudienceId: data.metaAudienceId,
            spec: data.spec as Prisma.InputJsonObject,
            status: data.status,
            consentBasis: data.consentBasis,
            createdByUserId: data.createdByUserId,
            lastError: data.lastError ?? null,
          },
        })) as AdAudienceRow,
      ),
    update: async (tenantId, id, patch) => {
      const { sizeLower, sizeUpper, ...rest } = patch;
      await prisma.adAudience.updateMany({ where: { id, tenantId }, data: { ...rest, ...(sizeLower !== undefined ? { sizeLower: bigOrNull(sizeLower) } : {}), ...(sizeUpper !== undefined ? { sizeUpper: bigOrNull(sizeUpper) } : {}) } });
    },
    dueForSync: async (before, limit) =>
      (
        (await prisma.adAudience.findMany({
          where: { deletedAt: null, kind: { not: "saved" }, metaAudienceId: { not: null }, adAccountAssetId: { not: null }, OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: before } }] },
          orderBy: { lastSyncedAt: { sort: "asc", nulls: "first" } },
          take: limit,
        })) as AdAudienceRow[]
      ).map(toRecord),
    openUpload: async (tenantId, audienceId) => {
      const row = await prisma.adAudienceUpload.findFirst({ where: { tenantId, audienceId, status: { in: ["queued", "running"] } }, orderBy: { createdAt: "desc" } });
      return row ? toUpload(row as UploadRow) : null;
    },
    openUploads: async (limit) =>
      (
        (await prisma.adAudienceUpload.findMany({
          where: { status: { in: ["queued", "running"] } },
          orderBy: [{ audience: { updatedAt: "asc" } }, { createdAt: "asc" }],
          take: limit,
        })) as UploadRow[]
      ).map(toUpload),
    createUpload: async (data) =>
      toUpload(
        (await prisma.adAudienceUpload.create({
          data: { ...data, sessionId: BigInt(data.sessionId) },
        })) as UploadRow,
      ),
    updateUpload: async (id, patch) => {
      await prisma.adAudienceUpload.update({ where: { id }, data: patch });
    },
  };
  const contacts: CustomerContacts = {
    scan: async (tenantId, selection) => {
      const { matchingContactIds, resolveFilters } = await import("@/lib/segments/service");
      const filters = selection.segmentId ? await resolveFilters(tenantId, { segmentId: selection.segmentId }) : [];
      const base: Prisma.ContactWhereInput = { tenantId, ...(selection.tag ? { tags: { has: selection.tag } } : {}) };
      const ids = [...new Set(await matchingContactIds(tenantId, base, filters))];
      if (ids.length > MAX_LIST_CONTACTS) throw new HttpError(422, AUDIENCE_COPY.tooBig);
      ids.sort();
      const out: CustomerContact[] = [];
      for (let i = 0; i < ids.length; i += 5_000) {
        const rows = await prisma.contact.findMany({
          where: { tenantId, id: { in: ids.slice(i, i + 5_000) } },
          select: { id: true, phone: true, name: true, attributes: true, optIn: true, optedOutAt: true },
        });
        for (const r of rows) out.push({ id: r.id, phone: r.phone, name: r.name, email: contactEmail(r.attributes), optIn: r.optIn, optedOutAt: r.optedOutAt });
      }
      return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },
  };
  const workspace: AudienceWorkspace = {
    spendingAccount: async (tenantId) => {
      const control = await prisma.spendControl.findUnique({ where: { tenantId }, select: { spendingAdAccountAssetId: true } });
      if (!control?.spendingAdAccountAssetId) return null;
      const a = await prisma.metaAsset.findFirst({ where: { id: control.spendingAdAccountAssetId, tenantId, type: "ad_account", status: "active" }, select: { id: true, externalId: true } });
      return a ? { assetId: a.id, externalId: a.externalId } : null;
    },
    source: async (tenantId, type, id) => {
      if (type === "lead_form") {
        const form = await prisma.leadForm.findFirst({ where: { id, tenantId, hiddenAt: null }, select: { metaFormId: true, name: true } });
        return form ? { metaId: form.metaFormId, name: form.name } : null;
      }
      const asset = await prisma.metaAsset.findFirst({ where: { id, tenantId, type, status: "active" }, select: { externalId: true, name: true } });
      return asset ? { metaId: asset.externalId, name: asset.name } : null;
    },
    pixel: async (tenantId, account, pixelAssetId) => {
      const rows = (await prisma.metaAsset.findMany({
        where: { tenantId, type: "dataset", status: "active", ...(pixelAssetId ? { id: pixelAssetId } : {}) },
        select: { id: true, externalId: true, meta: true },
        orderBy: { createdAt: "asc" },
        take: 200,
      })) as { id: string; externalId: string; meta: unknown }[];
      if (pixelAssetId) return rows[0] ? { assetId: rows[0].id, metaId: rows[0].externalId } : null;
      const want = actNumber(account.externalId);
      const own = rows.find((r) => {
        const owner = isObject(r.meta) ? r.meta.adAccountId : null;
        return typeof owner === "string" && actNumber(owner) === want;
      });
      return own ? { assetId: own.id, metaId: own.externalId } : null;
    },
    specialCategory: async (tenantId) => {
      const brand = await prisma.brand.findFirst({ where: { tenantId, specialAdCategory: { not: "none" } }, select: { specialAdCategory: true } });
      const c = brand?.specialAdCategory;
      return (SPECIAL_CATEGORIES as readonly string[]).includes(c ?? "") ? (c as SpecialAdCategory) : "none";
    },
  };
  return {
    store,
    contacts,
    workspace,
    meta: promoteMeta,
    audit: (entry) => audit(entry),
    env: process.env,
    now: Date.now,
    sessionId: () => randomInt(1, 2 ** 47),
  };
}

const DEP_KEYS = ["store", "contacts", "workspace", "meta", "audit", "env", "now", "sessionId"] as const;

async function resolveDeps(overrides: Partial<AudienceDeps>): Promise<AudienceDeps> {
  const base = DEP_KEYS.every((k) => overrides[k] !== undefined) ? ({} as Omit<AudienceDeps, "dryRun">) : await defaultDeps();
  return { ...base, dryRun: false, ...overrides } as AudienceDeps;
}

// =====================================================================================================================
// Views
// =====================================================================================================================

export type AudienceChip = "getting_ready" | "ready" | "too_small" | "problem";

export type AudienceView = {
  id: string;
  kind: AudienceKind;
  name: string;
  action: AudienceAction;
  status: AudienceStatus;
  chip: AudienceChip;
  /** "Getting ready", "Ready", "Too small" or "Problem". */
  chipText: string;
  sizeLower: number | null;
  sizeUpper: number | null;
  /** "About 1.2–1.8 lakh people" once Meta has given a size. */
  sizeLine: string | null;
  /** What is wrong and what to do, in plain words; null when nothing is. */
  problem: string | null;
  consentBasis: string | null;
  rowsUploaded: number;
  /** Ready to use in an ad (saved audiences always are). */
  usable: boolean;
  /** Its kind is offered at the current PROMOTE_AUDIENCES level (an existing one can always be deleted). */
  available: boolean;
  details: Record<string, unknown>;
  lastSyncedAt: string | null;
  createdAt: string;
};

export function chipOf(status: AudienceStatus): AudienceChip {
  if (status === "ready") return "ready";
  if (status === "too_small") return "too_small";
  if (status === "error" || status === "deleted") return "problem";
  return "getting_ready";
}

/** The spec as shown: no Meta ids, nothing personal (there is none to begin with). */
function detailsOf(r: AudienceRecord): Record<string, unknown> {
  const s = r.spec;
  switch (r.kind) {
    case "saved":
      return { targeting: s.targeting ?? null };
    case "customer_list":
      return { selection: isObject(s.selection) ? s.selection : {} };
    case "lookalike":
      return { seedAudienceId: s.seedAudienceId ?? null, percent: s.percent ?? null, country: s.country ?? LOOKALIKE.country };
    case "website":
      return { event: s.event ?? null, pixelAssetId: s.pixelAssetId ?? null, retentionDays: s.retentionDays ?? null, urlContains: s.urlContains ?? null };
    default:
      return { event: s.event ?? null, sourceId: s.sourceId ?? null, retentionDays: s.retentionDays ?? null };
  }
}

export function audienceView(r: AudienceRecord, env: Env = process.env): AudienceView {
  const chip = chipOf(r.status);
  const known = r.sizeLower !== null && r.sizeUpper !== null && r.sizeLower > 0;
  const problem = r.status === "too_small" ? promoteText("audience.too_small") : r.status === "error" ? (r.lastError ?? AUDIENCE_COPY.failed) : r.lastError;
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    action: AUDIENCE_ACTION[r.kind],
    status: r.status,
    chip,
    chipText: promoteText(`audience.status.${chip}`),
    sizeLower: r.sizeLower,
    sizeUpper: r.sizeUpper,
    sizeLine: r.kind !== "saved" && known ? sizeLine(r.sizeLower, r.sizeUpper) : null,
    problem: problem ?? null,
    consentBasis: r.consentBasis,
    rowsUploaded: r.rowsUploaded,
    usable: r.kind === "saved" ? r.deletedAt === null : r.status === "ready" && r.metaAudienceId !== null && r.deletedAt === null,
    available: kindAllowed(r.kind, env),
    details: detailsOf(r),
    lastSyncedAt: r.lastSyncedAt ? r.lastSyncedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  };
}

/** A record that was never stored (a dry run), for its view. */
function draftRecord(tenantId: string, kind: AudienceKind, name: string, spec: Record<string, unknown>, now: number, metaId: string | null = null): AudienceRecord {
  return {
    id: metaId ?? "dryrun",
    tenantId,
    adAccountAssetId: null,
    kind,
    name,
    metaAudienceId: metaId,
    spec,
    status: "populating",
    sizeLower: null,
    sizeUpper: null,
    deliveryStatus: null,
    consentBasis: kind === "customer_list" ? CONSENT_BASIS : null,
    rowsUploaded: 0,
    lastSyncedAt: null,
    lastError: null,
    createdByUserId: null,
    createdAt: new Date(now),
    deletedAt: null,
  };
}

/** A view for a dry run, where nothing was stored: the fake Meta id stands in for the row id. */
function dryRunView(tenantId: string, kind: AudienceKind, name: string, metaId: string, spec: Record<string, unknown>, now: number, env: Env): AudienceView {
  return audienceView(draftRecord(tenantId, kind, name, spec, now, metaId), env);
}

/** What A5 says, as a status (5.1) and a problem in plain words. Meta's own texts are never shown. */
export function statusFromMeta(info: Pick<AudienceInfo, "operationStatus" | "deliveryStatus">): { status: AudienceStatus; problem: string | null } {
  const op = info.operationStatus?.code ?? null;
  const delivery = info.deliveryStatus?.code ?? null;
  // 471: Meta flagged the audience or its seed (4.10).
  if (op === 471) return { status: "error", problem: metaErrorText("audience_flagged") };
  // 300: too small to deliver.
  if (delivery === 300) return { status: "too_small", problem: null };
  // 200: ready to deliver, even with a warning about the match rate.
  if (delivery === 200) return { status: "ready", problem: null };
  // 441: still finding people (up to 24 hours); 0: no status yet.
  if (op === 441 || op === 0 || (op === null && delivery === null)) return { status: "populating", problem: null };
  if (op === 200 && delivery === null) return { status: "ready", problem: null };
  // Errors: no pixel, pixel not firing, a lookalike that could not be built, a failed update, or an unusable audience.
  if ((op !== null && [421, 422, 423, 431, 432, 433, 450, 470].includes(op)) || (delivery !== null && delivery >= 400)) return { status: "error", problem: AUDIENCE_COPY.failed };
  return { status: "populating", problem: null };
}

const sizeOf = (n: number | null): number | null => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : null);

// =====================================================================================================================
// Input
// =====================================================================================================================

function nameOf(v: unknown, fallback: string): string {
  if (v === undefined || v === null || (typeof v === "string" && !v.trim())) return fallback.slice(0, NAME_MAX);
  if (typeof v !== "string" || v.trim().length > NAME_MAX) throw new HttpError(400, AUDIENCE_COPY.name);
  return v.trim();
}

const idOf = (v: unknown): string | null => (typeof v === "string" && ID.test(v) ? v : null);

/** Days to look back for this kind: the default when unset, refused outside 1 to its maximum. */
export function retentionDaysOf(kind: AudienceEventKind, v: unknown): number {
  const { defaultDays, maxDays } = retentionBounds(kind);
  if (v === undefined || v === null || v === "") return defaultDays;
  const d = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isInteger(d) || d < 1 || d > maxDays) throw new HttpError(400, retentionCopy(maxDays));
  return d;
}

function eventOf(kind: Exclude<AudienceEventKind, "website">, v: unknown): AudienceEventRow {
  const rows = AUDIENCE_EVENTS.filter((e) => e.kind === kind);
  if (v === undefined || v === null || v === "") return rows[0];
  const row = rows.find((e) => e.id === v);
  if (!row) throw new HttpError(400, AUDIENCE_COPY.chooseEvent);
  return row;
}

export function selectionOf(input: Record<string, unknown>): CustomerSelection {
  const selection: CustomerSelection = {};
  if (input.segmentId !== undefined && input.segmentId !== null && input.segmentId !== "") {
    const id = idOf(input.segmentId);
    if (!id) throw new HttpError(400, AUDIENCE_COPY.segment);
    selection.segmentId = id;
  }
  if (input.tag !== undefined && input.tag !== null && input.tag !== "") {
    if (typeof input.tag !== "string" || !input.tag.trim() || input.tag.trim().length > TAG_MAX) throw new HttpError(400, AUDIENCE_COPY.tag);
    selection.tag = input.tag.trim();
  }
  return selection;
}

function urlWordOf(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const word = Array.isArray(v) && v.length === 1 ? v[0] : v;
  if (typeof word !== "string" || word.trim().length > URL_WORD_MAX) throw new HttpError(400, AUDIENCE_COPY.urlWord);
  return word.trim() || null;
}

function categoryOf(v: unknown): SpecialAdCategory {
  if (v === undefined || v === null || v === "") return "none";
  if (typeof v !== "string" || !(SPECIAL_CATEGORIES as readonly string[]).includes(v)) throw new HttpError(400, AUDIENCE_COPY.category);
  return v as SpecialAdCategory;
}

/** 403 in plain words when the flags don't offer this kind: only saved audiences (off), or no customer lists yet (engagement). */
function assertKindAllowed(kind: AudienceKind, env: Env): void {
  if (kindAllowed(kind, env)) return;
  throw new HttpError(403, effectiveAudiences(env) === "off" ? AUDIENCE_COPY.savedOnly : AUDIENCE_COPY.customerListsOff);
}

async function requireAccount(deps: AudienceDeps, tenantId: string): Promise<SpendingAccount> {
  const account = await deps.workspace.spendingAccount(tenantId);
  if (!account) throw new HttpError(409, AUDIENCE_COPY.noAccount);
  return account;
}

// =====================================================================================================================
// Customer lists: who can be included
// =====================================================================================================================

/**
 * A contact a customer list may include: a recorded marketing opt-in, no opt-out (contacts/opt-out.ts: an opt-out blocks
 * marketing), and an email or phone Meta can match.
 */
export function includable(c: CustomerContact): boolean {
  return c.optIn === true && mayReceive(c, "marketing") && identityRow({ email: c.email, phone: c.phone }) !== null;
}

export type CustomerCount = { total: number; included: number; line: string; tooSmall: boolean };

export function countView(total: number, included: number): CustomerCount {
  return { total, included, line: promoteText("audience.can_include", { included, total }), tooSmall: included < MIN_AUDIENCE_PEOPLE };
}

async function selectCustomers(deps: AudienceDeps, tenantId: string, selection: CustomerSelection): Promise<{ total: number; included: CustomerContact[] }> {
  const all = await deps.contacts.scan(tenantId, selection);
  const included = all.filter(includable).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { total: all.length, included };
}

const selectionFromSpec = (spec: Record<string, unknown>): CustomerSelection => {
  const s = isObject(spec.selection) ? spec.selection : {};
  return { ...(typeof s.segmentId === "string" ? { segmentId: s.segmentId } : {}), ...(typeof s.tag === "string" ? { tag: s.tag } : {}) };
};

const ctxFor = (tenantId: string, adAccountAssetId: string): AdCtx => ({ tenantId, adAccountAssetId });

/**
 * C4: Meta's Custom Audience terms, accepted for the ad account and by the person (the readiness row reads them the same way,
 * prereqs.ts). Not accepted: the custom_audience_tos fix, and nothing is created. A failed read lets A1 answer instead (its
 * 2655 maps to the same fix).
 */
async function assertTerms(deps: AudienceDeps, tenantId: string, account: SpendingAccount): Promise<void> {
  let health: Awaited<ReturnType<AudienceMeta["getAdAccountHealth"]>>;
  try {
    health = await deps.meta.getAdAccountHealth(ctxFor(tenantId, account.assetId));
  } catch (error) {
    const mapped = toAudienceError(error, account.externalId);
    if (mapped instanceof AudienceFixError) throw mapped;
    return;
  }
  const accepted = health.tosAccepted.custom_audience_tos === 1 && health.userTosAccepted.custom_audience_tos === 1;
  if (!accepted) throw new AudienceFixError("custom_audience_tos", termsFix(account.externalId));
}

async function createOnMeta(deps: AudienceDeps, ctx: AdCtx, act: string | null, spec: MetaAudienceSpec): Promise<{ id: string }> {
  try {
    return await deps.meta.createCustomAudience(ctx, spec);
  } catch (error) {
    throw plainAudienceError(error, act, "create");
  }
}

// =====================================================================================================================
// Uploads (A2, A3)
// =====================================================================================================================

/**
 * How an upload stands: queued (waiting for the upload task, or part sent and the rest coming on its next run), paused (Meta
 * was busy or did not answer; the next run tries the same batch again), done (every batch sent), or failed (problem says why).
 */
export type UploadOutcome = { state: "queued" | "done" | "paused" | "failed"; mode: UploadMode; sentRows: number; totalRows: number; batches: number; problem: string | null };

const batchesFor = (rows: number): number => Math.max(1, Math.ceil(rows / MAX_UPLOAD_ROWS));

function sessionExpired(upload: UploadRecord, now: number): boolean {
  const started = upload.startedAt ? upload.startedAt.getTime() : now;
  return now - started > (upload.mode === "replace" ? REPLACE_SESSION_MS : ADD_SESSION_MS);
}

/**
 * Opens an upload session for the upload task to send: nothing goes to Meta here, so the request answers at once. The count is
 * the contacts included now; the task chooses them again when it sends.
 */
async function queueUpload(deps: AudienceDeps, audience: AudienceRecord, mode: "add" | "replace", total: number, userId: string | null): Promise<UploadOutcome> {
  await deps.store.createUpload({
    tenantId: audience.tenantId,
    audienceId: audience.id,
    sessionId: deps.sessionId(),
    mode,
    totalRows: total,
    sentRows: 0,
    batchSeq: 0,
    status: "queued",
    startedAt: null,
    requestedByUserId: userId,
  });
  await deps.store.update(audience.tenantId, audience.id, { status: "populating", lastError: null });
  return { state: "queued", mode, sentRows: 0, totalRows: total, batches: batchesFor(total), problem: null };
}

/** An open upload as it stands, for a refresh that finds one. */
const openOutcome = (upload: UploadRecord): UploadOutcome => ({
  state: "queued",
  mode: upload.mode,
  sentRows: upload.sentRows,
  totalRows: upload.totalRows,
  batches: batchesFor(upload.totalRows),
  problem: null,
});

/** Closes an open upload without sending anything more; the audience shows why. */
async function closeUpload(deps: AudienceDeps, audience: AudienceRecord | null, upload: UploadRecord, problem: string): Promise<UploadOutcome> {
  await deps.store.updateUpload(upload.id, { status: "failed", finishedAt: new Date(deps.now()), error: problem });
  if (audience && !audience.deletedAt) await deps.store.update(audience.tenantId, audience.id, { lastError: problem });
  return { state: "failed", mode: upload.mode, sentRows: upload.sentRows, totalRows: upload.totalRows, batches: batchesFor(upload.totalRows), problem };
}

/**
 * Sends the batches of one session from the one after the last Meta acknowledged: batch k holds people (k-1)*10,000 to
 * k*10,000 in id order, so a retry sends the same batch under the same batch_seq. Progress is stored after every batch. Once
 * `deadline` has passed no new batch starts (the first of the call always does): the upload stays queued for the next run.
 */
async function sendBatches(deps: AudienceDeps, audience: AudienceRecord, upload: UploadRecord, people: CustomerContact[], deadline: number): Promise<UploadOutcome> {
  const metaId = audience.metaAudienceId;
  const accountId = audience.adAccountAssetId;
  const batches = batchesFor(people.length);
  let { batchSeq, sentRows } = upload;
  const outcome = (state: UploadOutcome["state"], problem: string | null): UploadOutcome => ({ state, mode: upload.mode, sentRows, totalRows: people.length, batches, problem });
  if (!metaId || !accountId) return outcome("failed", AUDIENCE_COPY.uploadFailed);
  const ctx = ctxFor(audience.tenantId, accountId);
  const send = upload.mode === "replace" ? deps.meta.replaceAudienceUsers : deps.meta.addAudienceUsers;
  const first = upload.batchSeq + 1;
  try {
    for (let seq = first; seq <= batches; seq++) {
      if (seq > first && deps.now() >= deadline) {
        // This run's time is up: the next run sends the rest of the same session.
        await deps.store.update(audience.tenantId, audience.id, { status: "populating", rowsUploaded: sentRows, lastError: null });
        return outcome("queued", null);
      }
      const rows = people
        .slice((seq - 1) * MAX_UPLOAD_ROWS, seq * MAX_UPLOAD_ROWS)
        .map((c) => customerRow({ email: c.email, phone: c.phone, name: c.name }))
        .filter((r): r is string[] => r !== null);
      const last = seq === batches;
      if (rows.length > 0) {
        await send(ctx, metaId, { schema: [...CUSTOMER_SCHEMA], rows }, { id: upload.sessionId, batchSeq: seq, last, estimatedTotal: people.length });
      }
      batchSeq = seq;
      sentRows += rows.length;
      await deps.store.updateUpload(upload.id, { batchSeq, sentRows, status: last ? "done" : "running", ...(last ? { finishedAt: new Date(deps.now()) } : {}) });
    }
  } catch (error) {
    if (isResumable(error)) {
      await deps.store.update(audience.tenantId, audience.id, { status: "populating", lastError: AUDIENCE_COPY.busy });
      return outcome("paused", AUDIENCE_COPY.busy);
    }
    const mapped = toAudienceError(error, null);
    const problem = mapped instanceof AudienceFixError ? mapped.message : AUDIENCE_COPY.uploadFailed;
    await deps.store.updateUpload(upload.id, { status: "failed", finishedAt: new Date(deps.now()), error: problem });
    await deps.store.update(audience.tenantId, audience.id, { status: "error", lastError: problem, rowsUploaded: sentRows });
    return outcome("failed", problem);
  }
  if (batchSeq >= batches && upload.status !== "done") {
    // Nothing was left to send (a resume after the last batch): close the session row.
    await deps.store.updateUpload(upload.id, { status: "done", finishedAt: new Date(deps.now()) });
  }
  await deps.store.update(audience.tenantId, audience.id, { status: "populating", rowsUploaded: sentRows, lastError: null });
  return outcome("done", null);
}

/**
 * Continues this audience's unfinished upload (a queued one, a pause while Meta was busy, a lost answer, a stopped process) from
 * the next batch_seq of the same session, in this process and without a time limit. Null when nothing is unfinished. Like the
 * upload task, it closes the upload instead when customer lists are switched off.
 */
export async function resumeUpload(tenantId: string, audienceId: string, overrides: Partial<AudienceDeps> = {}): Promise<UploadOutcome | null> {
  const deps = await resolveDeps(overrides);
  const audience = await deps.store.get(tenantId, audienceId);
  if (!audience || audience.deletedAt || audience.kind !== "customer_list" || !audience.metaAudienceId) return null;
  const upload = await deps.store.openUpload(tenantId, audienceId);
  if (!upload) return null;
  return continueUpload(deps, audience, upload, Number.POSITIVE_INFINITY);
}

/**
 * One step of an open upload. The flags come first: with customer lists switched off (PROMOTE_AUDIENCES below all, or production
 * without LEGAL_DPDP_AUDIENCES_OK=1) the upload is closed and no contact is even read (acceptance 2). Then the contacts are chosen
 * again (a person who withdrew since is never sent), a session past Meta's window starts again, and a queued one starts now.
 */
async function continueUpload(deps: AudienceDeps, audience: AudienceRecord, upload: UploadRecord, deadline: number): Promise<UploadOutcome> {
  if (!kindAllowed("customer_list", deps.env)) return closeUpload(deps, audience, upload, AUDIENCE_COPY.listsOff);
  const people = (await selectCustomers(deps, audience.tenantId, selectionFromSpec(audience.spec))).included;
  if (people.length < MIN_AUDIENCE_PEOPLE) {
    await deps.store.updateUpload(upload.id, { status: "failed", finishedAt: new Date(deps.now()), error: promoteText("audience.too_small") });
    await deps.store.update(audience.tenantId, audience.id, { status: "too_small", lastError: null });
    return { state: "failed", mode: upload.mode, sentRows: upload.sentRows, totalRows: people.length, batches: 0, problem: promoteText("audience.too_small") };
  }
  const startedAt = new Date(deps.now());
  if (sessionExpired(upload, deps.now())) {
    await deps.store.updateUpload(upload.id, { status: "failed", finishedAt: startedAt, error: "The upload session ran out. A new one started." });
    const fresh = await deps.store.createUpload({
      tenantId: audience.tenantId,
      audienceId: audience.id,
      sessionId: deps.sessionId(),
      mode: upload.mode === "replace" ? "replace" : "add",
      totalRows: people.length,
      sentRows: 0,
      batchSeq: 0,
      status: "running",
      startedAt,
      requestedByUserId: null,
    });
    return sendBatches(deps, audience, fresh, people, deadline);
  }
  if (upload.status === "queued" || !upload.startedAt) {
    // The session starts with its first batch.
    await deps.store.updateUpload(upload.id, { status: "running", startedAt });
    return sendBatches(deps, audience, { ...upload, status: "running", startedAt }, people, deadline);
  }
  return sendBatches(deps, audience, upload, people, deadline);
}

export type UploadRunResult = { uploads: number; done: number; waiting: number; failed: number };

/**
 * The promote.audiences.uploads task (every 2 minutes; the worker skips it while PROMOTE_ENABLED=off): sends the open uploads,
 * the ones whose audience changed longest ago first. No new batch starts after UPLOAD_RUN_MS, so a run ends before the next one
 * may start. With customer lists switched off every open upload is closed and nothing is sent. An ad account Meta called busy
 * (or that did not answer) is left for the next run without holding up the other accounts. Only the newest open upload of an
 * audience is sent (two refreshes in a row); an older one is closed.
 */
export async function sendQueuedUploads(overrides: Partial<AudienceDeps> = {}): Promise<UploadRunResult> {
  const deps = await resolveDeps(overrides);
  const open = await deps.store.openUploads(UPLOAD_BATCH);
  const deadline = deps.now() + UPLOAD_RUN_MS;
  const listsOn = kindAllowed("customer_list", deps.env);
  const busy = new Set<string>();
  let done = 0;
  let waiting = 0;
  let failed = 0;
  for (const upload of open) {
    const audience = await deps.store.get(upload.tenantId, upload.audienceId);
    if (!audience || audience.deletedAt || audience.kind !== "customer_list" || !audience.metaAudienceId || !audience.adAccountAssetId) {
      await closeUpload(deps, null, upload, AUDIENCE_COPY.uploadDeleted);
      failed++;
      continue;
    }
    if (!listsOn) {
      await closeUpload(deps, audience, upload, AUDIENCE_COPY.listsOff);
      failed++;
      continue;
    }
    const newest = await deps.store.openUpload(upload.tenantId, upload.audienceId);
    if (newest && newest.id !== upload.id) {
      await deps.store.updateUpload(upload.id, { status: "failed", finishedAt: new Date(deps.now()), error: AUDIENCE_COPY.uploadReplaced });
      failed++;
      continue;
    }
    if (busy.has(audience.adAccountAssetId) || deps.now() >= deadline) {
      waiting++;
      continue;
    }
    try {
      const out = await continueUpload(deps, audience, upload, deadline);
      if (out.state === "done") done++;
      else if (out.state === "failed") failed++;
      else {
        waiting++;
        if (out.state === "paused") busy.add(audience.adAccountAssetId);
      }
    } catch (error) {
      // Choosing the contacts failed (the selection grew past 2,00,000, or the database). Closed, so it can't loop: Refresh
      // starts it again.
      failed++;
      const problem = error instanceof HttpError ? error.message : AUDIENCE_COPY.uploadFailed;
      await deps.store.updateUpload(upload.id, { status: "failed", finishedAt: new Date(deps.now()), error: problem }).catch(() => undefined);
      await deps.store.update(audience.tenantId, audience.id, { status: "error", lastError: problem }).catch(() => undefined);
    }
  }
  return { uploads: open.length, done, waiting, failed };
}

// =====================================================================================================================
// Reads
// =====================================================================================================================

export type AudienceList = { audiences: AudienceView[]; kinds: AudienceKind[]; customerLists: { used: number; max: number } };

/** GET /api/promote/audiences (list_audiences). */
export async function listAudiences(actor: Pick<Actor, "tenantId">, overrides: Partial<AudienceDeps> = {}): Promise<AudienceList> {
  const deps = await resolveDeps(overrides);
  const rows = await deps.store.list(actor.tenantId);
  return {
    audiences: rows.filter((r) => r.deletedAt === null).map((r) => audienceView(r, deps.env)),
    kinds: allowedKinds(deps.env),
    customerLists: { used: rows.filter((r) => r.kind === "customer_list" && r.deletedAt === null).length, max: MAX_CUSTOMER_LISTS },
  };
}

/** GET /api/promote/audiences/[id] (get_audience). 404 for another workspace's or a deleted audience. */
export async function getAudience(actor: Pick<Actor, "tenantId">, id: string, overrides: Partial<AudienceDeps> = {}): Promise<AudienceView> {
  const deps = await resolveDeps(overrides);
  const row = ID.test(id) ? await deps.store.get(actor.tenantId, id) : null;
  if (!row || row.deletedAt) throw new HttpError(404, AUDIENCE_COPY.notFound);
  return audienceView(row, deps.env);
}

/**
 * How many contacts of a selection a customer list would include ("1,240 of 1,610 contacts can be included."), for the confirm
 * card. Reads the database only; nothing goes to Meta.
 */
export async function previewCustomerList(actor: Pick<Actor, "tenantId">, input: Record<string, unknown>, overrides: Partial<AudienceDeps> = {}): Promise<CustomerCount> {
  const deps = await resolveDeps(overrides);
  assertKindAllowed("customer_list", deps.env);
  const people = await selectCustomers(deps, actor.tenantId, selectionOf(input));
  return countView(people.total, people.included.length);
}

/**
 * AdAudience id -> Meta audience id for the workspace's audiences an ad may use now: ready, on the spending ad account, and of
 * a kind the flags offer. Saved audiences and the size route validate against it. At launch ads/service.ts (loadAudiences)
 * builds its own map, for the campaign's ad account, and applies the same kind rule through audienceKindOffered (5.4).
 */
export async function usableAudienceMetaIds(tenantId: string, overrides: Partial<AudienceDeps> = {}): Promise<Record<string, string>> {
  const deps = await resolveDeps(overrides);
  const account = await deps.workspace.spendingAccount(tenantId);
  if (!account) return {};
  const out: Record<string, string> = {};
  for (const r of await deps.store.list(tenantId)) {
    if (r.kind === "saved" || r.deletedAt || r.status !== "ready" || !r.metaAudienceId || r.adAccountAssetId !== account.assetId || !kindAllowed(r.kind, deps.env)) continue;
    out[r.id] = r.metaAudienceId;
  }
  return out;
}

/** The workspace's spending ad account, for the search routes (A7, A8 use its user token). */
export async function spendingAdAccount(tenantId: string, overrides: Partial<AudienceDeps> = {}): Promise<SpendingAccount | null> {
  return (await resolveDeps(overrides)).workspace.spendingAccount(tenantId);
}

/**
 * POST /api/promote/audiences/size (get_audience_size): the reach of a targeting (our Targeting shape) through A9, cached for
 * 10 minutes. Audiences in it must be ready ones of the workspace. Without a spending account the size reads "Size not
 * available right now" with what to do.
 */
export async function sizeForTargeting(actor: Pick<Actor, "tenantId">, raw: unknown, category: unknown, overrides: Partial<AudienceDeps> = {}): Promise<AudienceSize & { reason?: string }> {
  if (!isObject(raw)) throw new HttpError(400, AUDIENCE_COPY.targeting);
  const deps = await resolveDeps(overrides);
  const special = categoryOf(category);
  const account = await deps.workspace.spendingAccount(actor.tenantId);
  if (!account) return { lower: null, upper: null, line: sizeLine(null, null), cached: false, reason: AUDIENCE_COPY.noAccount };
  const targeting: Targeting = parseTargeting(raw);
  const audienceMetaIds = await usableAudienceMetaIds(actor.tenantId, deps);
  const check = validateTargeting(targeting, special, { audienceMetaIds, allowUnverifiedPlacements: true });
  if (!check.ok) throw new HttpError(400, check.errors[0]);
  let spec: Record<string, unknown>;
  try {
    spec = toMetaTargeting(targeting, special, { audienceMetaIds });
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : AUDIENCE_COPY.targeting);
  }
  return audienceSize(ctxFor(actor.tenantId, account.assetId), spec, { meta: deps.meta, now: deps.now, cache: sizeCache });
}

// =====================================================================================================================
// Writes
// =====================================================================================================================

// The name is a literal: tests/ratelimit-migration.test.ts reads every createLimiter() call for a stable, unique name.
export const audienceWriteLimiter = createLimiter(AUDIENCE_WRITES_PER_HOUR, 3_600_000, "promote-audience-write");

/** Audience creates and refreshes: 10 an hour per workspace (4.8). Throws 429. */
export async function assertAudienceWriteRate(tenantId: string): Promise<void> {
  if (!(await audienceWriteLimiter.consumeShared(`tenant:${tenantId}`))) throw new HttpError(429, AUDIENCE_COPY.tooManyWrites);
}

export type CreateResult = {
  audience: AudienceView;
  action: AudienceAction;
  dryRun: boolean;
  /** Customer lists: who could be included. */
  count?: CustomerCount;
  /** Customer lists: the upload, queued for the upload task (the route answers 202). */
  upload?: UploadOutcome;
  /** A plain note, such as "Too small: Meta needs at least 100 people." or "We're sending your list to Meta." */
  notice?: string;
};

type Who = Pick<Actor, "tenantId" | "userId">;

/**
 * POST /api/promote/audiences {kind, …}. kind chooses the action: saved (save_audience); engagement_instagram,
 * engagement_page, engagement_lead_form and website (create_audience); customer_list (create_customer_audience); lookalike
 * (create_lookalike). Refused (403) when the flags don't offer the kind.
 */
export async function createAudience(actor: Who, body: unknown, overrides: Partial<AudienceDeps> = {}): Promise<CreateResult> {
  const deps = await resolveDeps(overrides);
  if (!isObject(body)) throw new HttpError(400, AUDIENCE_COPY.json);
  if (!isAudienceKind(body.kind)) throw new HttpError(400, AUDIENCE_COPY.chooseKind);
  const kind = body.kind;
  assertKindAllowed(kind, deps.env);
  switch (kind) {
    case "saved":
      return createSaved(deps, actor, body);
    case "customer_list":
      return createCustomerList(deps, actor, body);
    case "lookalike":
      return createLookalike(deps, actor, body);
    default:
      return createRuleAudience(deps, actor, kind, body);
  }
}

async function createSaved(deps: AudienceDeps, actor: Who, body: Record<string, unknown>): Promise<CreateResult> {
  const name = nameOf(body.name, "Saved audience");
  if (!isObject(body.targeting)) throw new HttpError(400, AUDIENCE_COPY.targeting);
  const targeting = parseTargeting(body.targeting);
  const check = validateTargeting(targeting, "none", { audienceMetaIds: await usableAudienceMetaIds(actor.tenantId, deps), allowUnverifiedPlacements: true });
  if (!check.ok) throw new HttpError(400, check.errors[0]);
  const row = await deps.store.create({ tenantId: actor.tenantId, adAccountAssetId: null, kind: "saved", name, metaAudienceId: null, spec: { targeting }, status: "ready", consentBasis: null, createdByUserId: actor.userId });
  await deps.audit({ tenantId: actor.tenantId, userId: actor.userId, action: "promote.audience_created", target: row.id, meta: { kind: "saved" } });
  return { audience: audienceView(row, deps.env), action: "save_audience", dryRun: false };
}

const ENGAGEMENT_SOURCE = { engagement_instagram: "instagram", engagement_page: "page", engagement_lead_form: "lead_form" } as const;
const LIST_DESCRIPTION = "Contacts who agreed to get marketing messages, shared from Edwyz.";
const DEFAULT_NAMES: Record<AudienceEventKind, string> = {
  engagement_instagram: "People who engaged on Instagram",
  engagement_page: "People who engaged with your Page",
  engagement_lead_form: "People who opened your form",
  website: "Website visitors",
};

async function createRuleAudience(deps: AudienceDeps, actor: Who, kind: AudienceEventKind, body: Record<string, unknown>): Promise<CreateResult> {
  const days = retentionDaysOf(kind, body.retentionDays);
  let spec: MetaAudienceSpec;
  let stored: Record<string, unknown>;
  let name: string;
  const account = await requireAccount(deps, actor.tenantId);
  if (kind === "website") {
    const word = urlWordOf(body.urlContains);
    const pixel = await deps.workspace.pixel(actor.tenantId, account, idOf(body.pixelAssetId));
    if (!pixel) throw new HttpError(409, AUDIENCE_COPY.noPixel);
    name = nameOf(body.name, `${DEFAULT_NAMES.website} · ${days} days`);
    spec = { kind: "website", name, pixelId: pixel.metaId, retentionDays: days, ...(word ? { urlContains: [word] } : {}) };
    stored = { event: word ? "website_url" : "website_all", pixelAssetId: pixel.assetId, retentionDays: days, urlContains: word };
  } else {
    const event = eventOf(kind, body.event);
    const sourceId = idOf(body.sourceId);
    if (!sourceId) throw new HttpError(400, AUDIENCE_COPY.chooseSource);
    const source = await deps.workspace.source(actor.tenantId, ENGAGEMENT_SOURCE[kind], sourceId);
    if (!source) throw new HttpError(404, AUDIENCE_COPY.chooseSource);
    const fallback = kind === "engagement_lead_form" && event.id === "lead_submitted" ? "People who sent your form" : DEFAULT_NAMES[kind];
    name = nameOf(body.name, `${fallback} · ${days} days`);
    spec = { kind: "engagement", name, sources: [{ id: source.metaId, type: event.sourceType as "ig_business" | "page" | "lead" }], event: event.event as string, retentionDays: days };
    stored = { event: event.id, sourceId, retentionDays: days };
  }
  const created = await createOnMeta(deps, ctxFor(actor.tenantId, account.assetId), account.externalId, spec);
  if (deps.dryRun) return { audience: dryRunView(actor.tenantId, kind, name, created.id, stored, deps.now(), deps.env), action: "create_audience", dryRun: true };
  const row = await deps.store.create({ tenantId: actor.tenantId, adAccountAssetId: account.assetId, kind, name, metaAudienceId: created.id, spec: stored, status: "populating", consentBasis: null, createdByUserId: actor.userId });
  await deps.audit({ tenantId: actor.tenantId, userId: actor.userId, action: "promote.audience_created", target: row.id, meta: { kind, retentionDays: days } });
  return { audience: audienceView(row, deps.env), action: "create_audience", dryRun: false };
}

async function createCustomerList(deps: AudienceDeps, actor: Who, body: Record<string, unknown>): Promise<CreateResult> {
  const selection = selectionOf(body);
  const name = nameOf(body.name, "Past customers");
  const account = await requireAccount(deps, actor.tenantId);
  if ((await deps.store.countCustomerLists(actor.tenantId)) >= MAX_CUSTOMER_LISTS) throw new HttpError(409, AUDIENCE_COPY.tooManyLists);
  const people = await selectCustomers(deps, actor.tenantId, selection);
  const count = countView(people.total, people.included.length);
  const stored = { selection, schema: [...CUSTOMER_SCHEMA] };
  if (count.tooSmall) {
    // Under 100 people nothing goes to Meta, not even the terms read (D17).
    const notice = promoteText("audience.too_small");
    if (deps.dryRun) {
      const view = audienceView({ ...draftRecord(actor.tenantId, "customer_list", name, stored, deps.now()), status: "too_small" }, deps.env);
      return { audience: view, action: "create_customer_audience", dryRun: true, count, notice };
    }
    const row = await deps.store.create({ tenantId: actor.tenantId, adAccountAssetId: account.assetId, kind: "customer_list", name, metaAudienceId: null, spec: stored, status: "too_small", consentBasis: CONSENT_BASIS, createdByUserId: actor.userId });
    await deps.audit({ tenantId: actor.tenantId, userId: actor.userId, action: "promote.audience_created", target: row.id, meta: { kind: "customer_list", rows: 0, tooSmall: true } });
    return { audience: audienceView(row, deps.env), action: "create_customer_audience", dryRun: false, count, notice };
  }
  await assertTerms(deps, actor.tenantId, account);
  const created = await createOnMeta(deps, ctxFor(actor.tenantId, account.assetId), account.externalId, { kind: "customer_list", name, description: LIST_DESCRIPTION });
  if (deps.dryRun) return { audience: dryRunView(actor.tenantId, "customer_list", name, created.id, stored, deps.now(), deps.env), action: "create_customer_audience", dryRun: true, count };
  const row = await deps.store.create({ tenantId: actor.tenantId, adAccountAssetId: account.assetId, kind: "customer_list", name, metaAudienceId: created.id, spec: stored, status: "populating", consentBasis: CONSENT_BASIS, createdByUserId: actor.userId });
  // The people go from the upload task, not from this request (a big list would outlast the proxy's 60 seconds).
  const upload = await queueUpload(deps, row, "add", people.included.length, actor.userId);
  await deps.audit({ tenantId: actor.tenantId, userId: actor.userId, action: "promote.audience_created", target: row.id, meta: { kind: "customer_list", rows: people.included.length, upload: upload.state } });
  const fresh = (await deps.store.get(actor.tenantId, row.id)) ?? row;
  return { audience: audienceView(fresh, deps.env), action: "create_customer_audience", dryRun: false, count, upload, notice: AUDIENCE_COPY.sending };
}

async function createLookalike(deps: AudienceDeps, actor: Who, body: Record<string, unknown>): Promise<CreateResult> {
  // Never for a special ad category (D17): the brand kit's, or the one the ad declares.
  const declared = categoryOf(body.specialAdCategory);
  if (declared !== "none" || (await deps.workspace.specialCategory(actor.tenantId)) !== "none") throw new HttpError(403, AUDIENCE_COPY.special);
  const percent = typeof body.percent === "number" ? body.percent : typeof body.percent === "string" && /^\d+$/.test(body.percent) ? Number(body.percent) : NaN;
  if (!Number.isInteger(percent) || percent < LOOKALIKE.minPercent || percent > LOOKALIKE.maxPercent) throw new HttpError(400, AUDIENCE_COPY.percent);
  const seedId = idOf(body.seedAudienceId);
  if (!seedId) throw new HttpError(400, AUDIENCE_COPY.chooseSeed);
  const seed = await deps.store.get(actor.tenantId, seedId);
  if (!seed || seed.deletedAt || seed.kind === "saved" || seed.kind === "lookalike") throw new HttpError(400, AUDIENCE_COPY.chooseSeed);
  if (!kindAllowed(seed.kind, deps.env)) throw new HttpError(403, AUDIENCE_COPY.seedCustomerList);
  if (!seed.metaAudienceId || !seed.adAccountAssetId) throw new HttpError(409, AUDIENCE_COPY.seedNotReady);
  const account = await requireAccount(deps, actor.tenantId);
  if (seed.adAccountAssetId !== account.assetId) throw new HttpError(409, AUDIENCE_COPY.otherAccount);
  const ctx = ctxFor(actor.tenantId, account.assetId);
  let lower = seed.sizeLower;
  if (lower === null || lower < LOOKALIKE.minSeed) {
    // The stored size may be old: ask Meta once (A5) before refusing. A read that fails is told as it is, not as "too small".
    try {
      const info = await deps.meta.getAudience(ctx, seed.metaAudienceId);
      lower = sizeOf(info.lower);
      if (!deps.dryRun) await deps.store.update(actor.tenantId, seed.id, { sizeLower: lower, sizeUpper: sizeOf(info.upper), lastSyncedAt: new Date(deps.now()) });
    } catch (error) {
      throw plainAudienceError(error, account.externalId, "read");
    }
  }
  if (lower === null || lower < LOOKALIKE.minSeed) throw new HttpError(409, AUDIENCE_COPY.seedTooSmall);
  const name = nameOf(body.name, `${percent}% like ${seed.name}`);
  const stored = { seedAudienceId: seed.id, percent, country: LOOKALIKE.country };
  const created = await createOnMeta(deps, ctx, account.externalId, { kind: "lookalike", name, originAudienceId: seed.metaAudienceId, ratio: lookalikeRatio(percent), country: LOOKALIKE.country });
  if (deps.dryRun) return { audience: dryRunView(actor.tenantId, "lookalike", name, created.id, stored, deps.now(), deps.env), action: "create_lookalike", dryRun: true };
  const row = await deps.store.create({ tenantId: actor.tenantId, adAccountAssetId: account.assetId, kind: "lookalike", name, metaAudienceId: created.id, spec: stored, status: "populating", consentBasis: null, createdByUserId: actor.userId });
  await deps.audit({ tenantId: actor.tenantId, userId: actor.userId, action: "promote.audience_created", target: row.id, meta: { kind: "lookalike", percent } });
  return { audience: audienceView(row, deps.env), action: "create_lookalike", dryRun: false };
}

export type RefreshResult = { audience: AudienceView; dryRun: boolean; count?: CustomerCount; upload?: UploadOutcome; notice?: string };

/**
 * POST /api/promote/audiences/[id]/refresh (refresh_customer_audience). A customer list whose upload is still open answers how
 * far it got and starts nothing. Otherwise its people are replaced with the contacts consented now (A3 through the upload task;
 * a list still under 100 sends nothing; one never sent is created first, after the terms, then filled with A2). Any other Meta
 * audience reads its status and size again (A5). Meta's refusals come in plain words.
 */
export async function refreshAudience(actor: Who, id: string, overrides: Partial<AudienceDeps> = {}): Promise<RefreshResult> {
  const deps = await resolveDeps(overrides);
  const row = ID.test(id) ? await deps.store.get(actor.tenantId, id) : null;
  if (!row || row.deletedAt) throw new HttpError(404, AUDIENCE_COPY.notFound);
  if (row.kind === "saved") throw new HttpError(400, AUDIENCE_COPY.savedNoRefresh);
  assertKindAllowed(row.kind, deps.env);
  if (row.kind !== "customer_list") {
    if (!row.metaAudienceId || !row.adAccountAssetId) throw new HttpError(409, AUDIENCE_COPY.failed);
    if (!deps.dryRun) {
      try {
        await readFromMeta(deps, row);
      } catch (error) {
        if (!isGone(error)) throw plainAudienceError(error, null, "read");
        await deps.store.update(actor.tenantId, row.id, { status: "error", lastError: AUDIENCE_COPY.gone, lastSyncedAt: new Date(deps.now()) });
      }
    }
    return { audience: audienceView((await deps.store.get(actor.tenantId, id)) ?? row, deps.env), dryRun: deps.dryRun };
  }
  const open = row.metaAudienceId ? await deps.store.openUpload(actor.tenantId, row.id) : null;
  if (open) {
    // The upload task is still sending it: nothing new starts, so the session in progress is never cut short.
    return { audience: audienceView(row, deps.env), dryRun: deps.dryRun, upload: openOutcome(open), notice: AUDIENCE_COPY.stillSending };
  }
  const people = await selectCustomers(deps, actor.tenantId, selectionFromSpec(row.spec));
  const count = countView(people.total, people.included.length);
  if (count.tooSmall) {
    if (!deps.dryRun) await deps.store.update(actor.tenantId, row.id, { status: "too_small", lastError: null });
    const notice = promoteText("audience.too_small");
    return { audience: audienceView({ ...row, status: "too_small", lastError: null }, deps.env), dryRun: deps.dryRun, count, notice };
  }
  let audience = row;
  let mode: "add" | "replace" = "replace";
  if (!row.metaAudienceId) {
    const account = await requireAccount(deps, actor.tenantId);
    if (row.adAccountAssetId !== account.assetId) throw new HttpError(409, AUDIENCE_COPY.otherAccount);
    await assertTerms(deps, actor.tenantId, account);
    const created = await createOnMeta(deps, ctxFor(actor.tenantId, account.assetId), account.externalId, { kind: "customer_list", name: row.name, description: LIST_DESCRIPTION });
    if (deps.dryRun) return { audience: dryRunView(actor.tenantId, "customer_list", row.name, created.id, row.spec, deps.now(), deps.env), dryRun: true, count };
    await deps.store.update(actor.tenantId, row.id, { metaAudienceId: created.id, status: "populating", lastError: null });
    audience = { ...row, metaAudienceId: created.id, status: "populating" };
    mode = "add";
  } else if (deps.dryRun) {
    return { audience: audienceView(row, deps.env), dryRun: true, count };
  }
  const upload = await queueUpload(deps, audience, mode, people.included.length, actor.userId);
  await deps.audit({ tenantId: actor.tenantId, userId: actor.userId, action: "promote.audience_refreshed", target: row.id, meta: { kind: "customer_list", mode, rows: people.included.length, upload: upload.state } });
  return { audience: audienceView((await deps.store.get(actor.tenantId, id)) ?? audience, deps.env), dryRun: false, count, upload, notice: AUDIENCE_COPY.sending };
}

/**
 * A5 for one audience: its status, size and delivery code, stored with lastSyncedAt. A customer list whose upload is still open
 * stays "Getting ready", and keeps the note the upload task left (busy, or none), until the upload finishes.
 */
async function readFromMeta(deps: AudienceDeps, row: AudienceRecord, uploading = false): Promise<void> {
  const info = await deps.meta.getAudience(ctxFor(row.tenantId, row.adAccountAssetId as string), row.metaAudienceId as string);
  const mapped = statusFromMeta(info);
  const code = info.deliveryStatus?.code;
  await deps.store.update(row.tenantId, row.id, {
    status: uploading ? "populating" : mapped.status,
    sizeLower: sizeOf(info.lower),
    sizeUpper: sizeOf(info.upper),
    deliveryStatus: typeof code === "number" ? String(code) : null,
    lastSyncedAt: new Date(deps.now()),
    ...(uploading ? {} : { lastError: mapped.problem }),
  });
}

export type DeleteResult = { deleted: boolean; dryRun: boolean };

/**
 * DELETE /api/promote/audiences/[id] (delete_audience, a danger card). Meta first (A6; an audience Meta no longer has counts as
 * deleted), then deletedAt. A failure on Meta leaves the row as it was. A saved audience is local: only deletedAt. Allowed at
 * any flag level: removing an audience is never switched off.
 */
export async function deleteAudience(actor: Who, id: string, overrides: Partial<AudienceDeps> = {}): Promise<DeleteResult> {
  const deps = await resolveDeps(overrides);
  const row = ID.test(id) ? await deps.store.get(actor.tenantId, id) : null;
  if (!row || row.deletedAt) throw new HttpError(404, AUDIENCE_COPY.notFound);
  if (row.kind !== "saved" && row.metaAudienceId && row.adAccountAssetId) {
    if (deps.dryRun) return { deleted: true, dryRun: true };
    try {
      await deps.meta.deleteAudience(ctxFor(actor.tenantId, row.adAccountAssetId), row.metaAudienceId);
    } catch (error) {
      if (!isGone(error)) throw plainAudienceError(error, null, "delete");
    }
  }
  await deps.store.update(actor.tenantId, row.id, { status: "deleted", deletedAt: new Date(deps.now()) });
  await deps.audit({ tenantId: actor.tenantId, userId: actor.userId, action: "promote.audience_deleted", target: row.id, meta: { kind: row.kind } });
  return { deleted: true, dryRun: false };
}

// =====================================================================================================================
// The 6-hourly sync (tasks/audiences.ts)
// =====================================================================================================================

export type AudienceSyncResult = { audiences: number; updated: number; failed: number };

/**
 * What a failed read stores. Every failure stamps lastSyncedAt (when the sync last tried), so an audience that keeps failing (an
 * expired connection, a lost permission, an error Meta never explains) drops behind the healthy ones instead of holding the
 * head of the oldest-first batch for ever; it is tried again on the next run. Gone and flagged audiences become errors, and a
 * problem only the member can fix (reconnect, allow ads access) is shown on the audience.
 */
function syncFailure(error: unknown, now: number): AudiencePatch {
  const at = new Date(now);
  if (isGone(error)) return { status: "error", lastError: AUDIENCE_COPY.gone, lastSyncedAt: at };
  if (audienceErrorKind(error) === "audience_flagged") return { status: "error", lastError: metaErrorText("audience_flagged"), lastSyncedAt: at };
  const plain = plainAudienceError(error, null, "read");
  if (plain instanceof HttpError && !(plain instanceof AudienceFixError) && (plain.status === 403 || plain.status === 409)) return { lastError: plain.message, lastSyncedAt: at };
  return { lastSyncedAt: at };
}

/**
 * Every Meta-backed audience not read for 5 hours (at most SYNC_BATCH a run, oldest read first): A5 maps Meta's answer to
 * draft, populating, ready, too_small or error with the size range. It sends nothing: customer-list uploads are the upload
 * task's (sendQueuedUploads), and with customer lists switched off an open upload found here is closed too. When Meta calls an
 * ad account busy, that account's other audiences wait for the next run; other accounts and workspaces carry on.
 */
export async function syncAudiences(overrides: Partial<AudienceDeps> = {}): Promise<AudienceSyncResult> {
  const deps = await resolveDeps(overrides);
  const rows = await deps.store.dueForSync(new Date(deps.now() - SYNC_STALE_MS), SYNC_BATCH);
  const listsOn = kindAllowed("customer_list", deps.env);
  const busy = new Set<string>();
  let updated = 0;
  let failed = 0;
  for (const row of rows) {
    const account = row.adAccountAssetId ?? "";
    if (busy.has(account)) continue;
    try {
      let uploading = false;
      if (row.kind === "customer_list") {
        const open = await deps.store.openUpload(row.tenantId, row.id);
        if (open && !listsOn) await closeUpload(deps, row, open, AUDIENCE_COPY.listsOff);
        uploading = open !== null && listsOn;
      }
      await readFromMeta(deps, row, uploading);
      updated++;
    } catch (error) {
      if (error instanceof PromoteThrottledError) {
        busy.add(account);
        continue;
      }
      failed++;
      await deps.store.update(row.tenantId, row.id, syncFailure(error, deps.now())).catch(() => undefined);
    }
  }
  return { audiences: rows.length, updated, failed };
}
