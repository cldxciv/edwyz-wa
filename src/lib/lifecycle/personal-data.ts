/**
 * Single source of truth for personal data in Edwyz WA: every tenant-owned table and file store, what personal data it
 * holds, how long it is kept and how it is erased. Pure data, no imports of the database, so legal pages, tests and the
 * erasure code can all read it. tests/lifecycle-personal-data.test.ts fails when a Prisma model with a tenantId column
 * is missing from this list.
 *
 * The workspace erasure (erase-workspace.ts) is driven by this list: entries are erased in array order, children first.
 */

/** Fixed retention periods in days (not configurable). Used by retention.ts and quoted by the privacy policy. */
export const FIXED_RETENTION_DAYS = {
  webhookEvents: 30,
  doneJobs: 7,
  sessions: 30,
  emailTokens: 7,
  automationRuns: 90,
} as const;

/** Configurable retention. Defaults here; a platform admin can override them in PlatformSetting "retention:config". */
export const RETENTION_DEFAULTS = {
  insightSnapshotDays: 400,
  conversionEventDays: 90,
  approvalRequestDays: 90,
  chatbotSessionDays: 90,
  usageLedgerDays: 400,
  leadMonths: 24,
  abandonedCartDays: 90,
  webhookDeliveryDays: 30,
  // Eddy (docs/EDDY-SPEC.md 8.3). EddyTurn uses usageLedgerDays.
  eddyHistoryDays: 90,
  actionRecordDays: 90,
  actionInvocationDays: 400,
  noticeDays: 30,
} as const;

export type RetentionKey = keyof typeof RETENTION_DEFAULTS;

/** Smallest value an override may take, so a typo cannot wipe recent data. Larger than the max or smaller than the min falls back to the default. */
export const RETENTION_LIMITS: Record<RetentionKey, { min: number; max: number }> = {
  insightSnapshotDays: { min: 90, max: 3650 },
  conversionEventDays: { min: 30, max: 3650 },
  approvalRequestDays: { min: 30, max: 3650 },
  chatbotSessionDays: { min: 30, max: 3650 },
  usageLedgerDays: { min: 90, max: 3650 },
  leadMonths: { min: 6, max: 120 },
  abandonedCartDays: { min: 14, max: 3650 },
  webhookDeliveryDays: { min: 7, max: 3650 },
  eddyHistoryDays: { min: 30, max: 365 },
  actionRecordDays: { min: 30, max: 365 },
  actionInvocationDays: { min: 90, max: 730 },
  noticeDays: { min: 7, max: 180 },
};

export const RETENTION_CONFIG_KEY = "retention:config";

export type EraseMethod =
  /** Rows deleted in batches by the tenant column. */
  | { method: "delete" }
  /** Sealed secret columns are overwritten first, then the rows are deleted. */
  | { method: "secrets-then-delete"; overwrite: Record<string, string | null> }
  /** Kept because the law requires it. Not touched by workspace erasure. */
  | { method: "retain"; reason: string }
  /** Directory of files removed with path checks (see files.ts). */
  | { method: "files"; directory: string }
  /**
   * Append-only by database trigger (0009). Erasure deletes the workspace's rows inside ONE transaction after setting the
   * transaction-local `guc` to '<table>:<tenantId>'. The trigger accepts that for a row-level DELETE of that workspace's rows
   * only, so a delete that lost its tenant filter still fails (SPEND 12.1c R2; erase-workspace.ts purgeAppendOnly).
   */
  | { method: "append-only-purge"; guc: "edwyz.purge" }
  /** Handled by dedicated code, described in `how`. */
  | { method: "custom" };

export type PersonalDataEntry = {
  /** Prisma model name for tables; a slug such as "files:creative" for other stores. */
  id: string;
  store: "table" | "files" | "settings" | "queue";
  /** Column that holds the tenant id. Defaults to tenantId. */
  tenantColumn?: string;
  /** Primary key column used for batched deletes. Defaults to id. */
  primaryKey?: string;
  /** Personal data held, in plain words. */
  holds: string;
  /** Retention rule in plain words. */
  retention: string;
  retentionKey?: RetentionKey;
  erase: EraseMethod;
  /** How it is erased, in plain words. */
  how: string;
  /** True when workspace-connection erasure for one Meta user also removes this data (data derived solely from that connection). */
  metaDerived?: boolean;
  /** What kind of data the table is registered as, where a spec names it (docs/IG-PAGE-ADS-SPEC.md 5.5). */
  category?: PersonalDataCategory;
  /** Columns added after the table, each with what it holds and the rule it follows (docs/IG-PAGE-ADS-SPEC.md 5.5). */
  columns?: Readonly<Record<string, string>>;
  /**
   * Deleted by workspace id inside the erasure's final transaction, together with the workspace row and the tombstone, instead
   * of in batches beforehand: either all of these rows go with the workspace or none do and the erasure can run again
   * (docs/IG-PAGE-ADS-SPEC.md 5.5). Only for tables a workspace keeps few enough rows in for one transaction.
   */
  inErasureTransaction?: true;
};

/** "Registered as" in docs/IG-PAGE-ADS-SPEC.md 5.5. */
export type PersonalDataCategory = "user_content" | "no_personal_data" | "counts_only" | "aggregates";

/** Fixed retention of Instagram and Facebook Page ads data (docs/IG-PAGE-ADS-SPEC.md 5.5), in days. Used by retention.ts. */
export const PROMOTE_RETENTION_DAYS = {
  /** The longest period; a shorter ad performance period (insightSnapshotDays) wins. */
  insightBreakdowns: 400,
  audienceUploads: 180,
  /** After AdMedia.lastUsedAt, for ad-only media no live ad uses. Their files go too. */
  adOnlyMedia: 30,
  /** After a video Meta has processed became ready, when no live ad or draft uses it: the local file goes, the row stays. */
  processedVideoOriginals: 30,
  testLeads: 30,
  /** After AdCampaign.discardedAt. */
  discardedDrafts: 30,
} as const;

/**
 * Fixed retention of Studio images and Canva data (docs/specs/ADS-MCP-CANVA-CREATIVE-SPEC.md 4.4, 5.3). Used by the studio.sweep
 * task (src/lib/studio/sweep.ts), which runs every `sweepHours`.
 */
export const STUDIO_RETENTION = {
  /** The sweep's interval: a row whose Library file is gone, or a former member's Canva connection, goes within this. */
  sweepHours: 6,
  /** StudioJob rows, after they finish (done or failed). */
  finishedJobDays: 7,
  /** An unfinished StudioJob older than this is failed, then removed with the finished ones. */
  unfinishedJobDays: 1,
  /** CanvaReturnState rows, after they are used. */
  usedReturnStateDays: 2,
  /** CanvaReturnState lifetime when unused: the life of a Canva edit link. */
  returnStateDays: 30,
} as const;

const WORKSPACE = "Kept while the workspace exists. Removed when the customer deletes it or the workspace is erased.";
const del: EraseMethod = { method: "delete" };
const BY_TENANT = "Deleted in batches by workspace id.";
const IN_ERASURE_TX: Partial<PersonalDataEntry> = {
  inErasureTransaction: true,
  how: "Deleted by workspace id in the erasure's final transaction, together with the workspace row.",
};
const SAME_AS_LEAD = "The same rules as the rest of the lead.";
const FORM_SETTING = "No personal data: a setting or state of the form.";

const table = (id: string, holds: string, retention: string, extra: Partial<PersonalDataEntry> = {}): PersonalDataEntry => ({
  id,
  store: "table",
  holds,
  retention,
  erase: del,
  how: BY_TENANT,
  ...extra,
});

/**
 * Tenant-owned data in erasure order: leaf tables first, then parents, then the tombstone-bearing steps.
 * Platform-level tables that can hold personal data (User, Job, ...) follow the tenant tables.
 */
export const PERSONAL_DATA: readonly PersonalDataEntry[] = [
  // Leads
  table("LeadSequenceRun", "Progress of a follow-up sequence for one lead (lead id, step, schedule).", "Removed with its lead (24 months after last activity) or with the workspace.", { metaDerived: true, retentionKey: "leadMonths" }),
  table("Lead", "Lead-form answers (name, email, phone, free text), consent text and time, status, assignee, where the lead came from (a form, a chat started from an ad, or added by hand), the platform and ad set, and the chat it started.", `24 months after last activity (configurable), unless the customer deletes it earlier. Test leads are removed after ${PROMOTE_RETENTION_DAYS.testLeads} days.`, {
    metaDerived: true,
    retentionKey: "leadMonths",
    columns: { source: SAME_AS_LEAD, platform: SAME_AS_LEAD, adsetMetaId: SAME_AS_LEAD, isOrganic: SAME_AS_LEAD, isTest: SAME_AS_LEAD, conversationId: SAME_AS_LEAD },
  }),
  table("LeadForm", "Lead form id, name and consent text, and for forms built in Edwyz the questions, privacy link, thank-you screen and disclaimer sent to Meta (no person data).", WORKSPACE, {
    metaDerived: true,
    columns: {
      spec: "No personal data: the form as sent to Meta (questions, privacy link, thank-you screen, disclaimer).",
      origin: FORM_SETTING, formType: FORM_SETTING, locale: FORM_SETTING, metaStatus: FORM_SETTING, syncedAt: FORM_SETTING,
      copiedFromId: FORM_SETTING, lastBackfillAt: FORM_SETTING, testLeadUntil: FORM_SETTING, hiddenAt: FORM_SETTING,
    },
  }),
  table("LeadSequence", "Follow-up message steps written by the customer.", WORKSPACE),
  table("ConversionEvent", "Lead and contact ids, event name and time, the response from Meta.", "90 days (configurable).", { retentionKey: "conversionEventDays", metaDerived: true }),
  table("ApprovalRequest", "Hashed approval link token, subject id, the approver's comment.", "90 days after the decision (configurable).", { retentionKey: "approvalRequestDays", metaDerived: true }),

  // Ads and insights
  table("OptimizerProposal", "Ad entity ids, rationale and payload of a suggested change, deciding user id.", "Finished proposals are removed with ad performance data (400 days, configurable).", { retentionKey: "insightSnapshotDays", metaDerived: true }),
  table("InsightSnapshot", "Daily ad performance numbers per campaign, ad set and ad (spend, impressions, clicks, results). No individual people.", "400 days (configurable).", { retentionKey: "insightSnapshotDays", metaDerived: true }),
  // Instagram and Facebook Page ads (docs/IG-PAGE-ADS-SPEC.md 5.5): deleted in the erasure's final transaction, children first.
  // All five are also erased with the Meta connection whose ad account they came from (erase-meta.ts).
  table("InsightBreakdown", "Ad results per day by placement, ad version (text, picture, video, button), age and gender band, region and the run total: spend, impressions, reach, clicks, results. Aggregates only, no individual people.", `${PROMOTE_RETENTION_DAYS.insightBreakdowns} days after the day they describe, or the ad performance period if that is shorter (configurable).`, {
    category: "aggregates",
    retentionKey: "insightSnapshotDays",
    metaDerived: true,
    ...IN_ERASURE_TX,
  }),
  table("AdTest", "A comparison of ad versions: the ad sets compared, the measure, the verdict numbers and the deciding user id. No personal data.", "Kept with its campaign. Removed when the campaign or the workspace is deleted.", {
    category: "no_personal_data",
    metaDerived: true,
    ...IN_ERASURE_TX,
  }),
  table("AdMedia", "Pictures and videos prepared for ads (file key, size, checksum, dimensions, Meta's image hash or video id) and the user id that added them. User content: the files can show people and the customer's brand.", `Kept while the workspace exists. Crops and copies made only for ads are removed with their files ${PROMOTE_RETENTION_DAYS.adOnlyMedia} days after their last use, once no live ad uses them. Copies of Instagram videos that Meta has processed lose their local file ${PROMOTE_RETENTION_DAYS.processedVideoOriginals} days after they were ready, once no live ad or draft uses them; Meta keeps its copy and the row keeps the video id and thumbnail.`, {
    category: "user_content",
    metaDerived: true,
    ...IN_ERASURE_TX,
  }),
  table("AdAudienceUpload", "One customer-list upload: row counts, batch number, status and the requesting user id. Counts only: no hashes, no identifiers.", `${PROMOTE_RETENTION_DAYS.audienceUploads} days after the upload.`, {
    category: "counts_only",
    metaDerived: true,
    ...IN_ERASURE_TX,
  }),
  table("AdAudience", "Audience definitions: name, targeting spec, Meta audience id, size range and, for customer lists, the lawful basis (consentBasis). No personal data: people in a customer list are hashed and sent to Meta, never stored here.", "Kept while the workspace exists. Customer-list audiences are also deleted on Meta when the workspace, or the Meta connection of their ad account, is erased.", {
    category: "no_personal_data",
    metaDerived: true,
    ...IN_ERASURE_TX,
  }),
  table("Ad", "Ad creative settings (page id, copy, link, form id) and name.", WORKSPACE, { metaDerived: true }),
  table("AdSet", "Targeting settings (locations, age range, interests) and name.", WORKSPACE, { metaDerived: true }),
  table("AdCampaign", "Campaign settings, budget, schedule, creating user id.", `${WORKSPACE} Discarded drafts are removed ${PROMOTE_RETENTION_DAYS.discardedDrafts} days after they were discarded.`, { metaDerived: true }),

  // Publishing and creative
  table("PostTarget", "Page or account the post goes to, external post id, error text.", WORKSPACE, { metaDerived: true }),
  table("ScheduledPost", "Post text and media file keys, schedule, creating user id.", WORKSPACE),
  // Studio images and Canva (docs/specs/ADS-MCP-CANVA-CREATIVE-SPEC.md 4.4), before Brand (StudioItem.brandId). None is data of
  // the Meta connection: the Meta data-deletion callback has nothing new to remove.
  table("StudioItem", "Where a Library image came from: its file key, the template inputs the member typed (offer text, prices, the business contact line), the Canva design id and the creating user id.", `While its Library file exists. A row whose file is gone is removed by the sweep within ${STUDIO_RETENTION.sweepHours} hours.`, {
    how: "Rows deleted in batches by workspace id. The files go with the files:content entry.",
  }),
  table("StudioJob", "A Canva import, autofill or return run by the worker: the Canva design or template id, chosen pages and format, error text and the user id.", `${STUDIO_RETENTION.finishedJobDays} days after it finishes (done or failed). Unfinished jobs older than ${STUDIO_RETENTION.unfinishedJobDays} day are failed, then removed.`),
  table("CanvaReturnState", "The Canva design id, user id and export settings behind Canva's Return button.", `Until used plus ${STUDIO_RETENTION.usedReturnStateDays} days, or its expiry (${STUDIO_RETENTION.returnStateDays} days, the life of a Canva edit link).`),
  table("CanvaConnection", "A member's Canva user id, team id and display name, and the sealed Canva access and refresh tokens.", `Until the member disconnects, leaves the workspace (removed by the sweep within ${STUDIO_RETENTION.sweepHours} hours) or the workspace is erased.`, {
    erase: { method: "secrets-then-delete", overwrite: { accessTokenEnc: null, refreshTokenEnc: null } },
    how: "Tokens revoked at Canva (best effort), then overwritten, then rows deleted by workspace id.",
  }),
  table("CreativeAsset", "Ad copy, file key of a generated image or video, provider, policy check.", "Kept while the workspace exists. Files with no database row are deleted after 24 hours.", { how: "Rows deleted in batches by workspace id. Files under DATA_DIR/creative/<tenant id> are removed with the files:creative entry." }),
  table("CreativeAngle", "Ad angle text (hook, audience, call to action).", WORKSPACE),
  table("CreativeBrief", "Offer text and research summary, which can include text taken from the customer's website.", WORKSPACE),
  table("Brand", "Brand name, website, logo link and logo file key, colours, fonts and image style, tone, banned words, tagline and the business contact line shown on images.", WORKSPACE),

  // Commerce
  table("AbandonedCart", "Shopper phone number, cart items, total, checkout link, reminder state.", "90 days after creation (configurable).", { retentionKey: "abandonedCartDays" }),
  table("ShopifyStore", "Shop domain, encrypted Shopify access token and webhook secret.", "Kept while the store is connected. Secrets are overwritten when the workspace is erased.", {
    erase: { method: "secrets-then-delete", overwrite: { tokenEnc: "", webhookSecretEnc: null } },
    how: "Secrets overwritten, then rows deleted by workspace id.",
  }),

  // AI
  table("AiKnowledgeSource", "Knowledge text, FAQs and web page text the customer gave the AI agent. May contain personal data the customer chose to add.", WORKSPACE),
  table("AiAgent", "Agent instructions, tone, language, hand-off keywords.", WORKSPACE),
  table("McpConnection", "Name and URL of the customer's own MCP server and an encrypted bearer token.", WORKSPACE, {
    erase: { method: "secrets-then-delete", overwrite: { authEnc: null } },
    how: "Token overwritten, then rows deleted by workspace id.",
  }),

  // Chatbots and automation
  table("ChatbotSession", "Chatbot progress and variables, which hold the answers a customer typed.", "90 days after it ends (configurable).", { retentionKey: "chatbotSessionDays" }),
  table("Chatbot", "Flow designed by the customer.", WORKSPACE),
  table("AutomationRun", "Which automatic reply fired in which conversation (ids only).", "90 days after it fires."),
  table("RuleExecution", "Which automation rule fired for which conversation and contact (ids only), the outcome and a short detail.", "90 days after it runs, or when the contact is erased."),
  table("ReplyMaterial", "Reusable reply text and the file keys of media written or uploaded by the customer.", WORKSPACE),
  table("AutomationRule", "Reply text, keywords and schedule written by the customer.", WORKSPACE),

  // Messaging
  table("BroadcastRecipient", "Contact id, delivery status, message id, error code, timestamps.", WORKSPACE),
  table("Broadcast", "Campaign name, template, segment tags, schedule.", WORKSPACE),
  table("Message", "Message text, media references, template name, delivery status, sending user id.", "Kept while the workspace exists. The customer can delete a contact together with its messages."),
  table("Note", "Internal note text and author id.", WORKSPACE),
  table("ConversationMark", "Which team member marked which conversation as a favourite or unread (user and conversation ids).", WORKSPACE),
  table("SavedInboxFilter", "Inbox filters saved by a team member (name and filter settings).", WORKSPACE),
  table("Segment", "Saved audience definitions (name and the filter rules written by the customer).", WORKSPACE),
  table("Conversation", "Contact link, assignee, tags, click-to-WhatsApp ad referral.", WORKSPACE),
  table("Contact", "Phone number (absent for people who message through a WhatsApp username), WhatsApp username, business-scoped user id (BSUID) and WhatsApp id, name, tags, custom attributes, owner, lead stage, opt-in and opt-out records.", "Kept while the workspace exists. The customer can delete a contact on request."),
  table("QuickReply", "Canned replies written by the customer.", WORKSPACE),
  table("Template", "Message template text and sample values.", WORKSPACE),

  // WhatsApp connection
  table("PhoneNumber", "Business phone number, verified name, quality rating, messaging tier.", WORKSPACE),
  table("Waba", "WhatsApp Business Account id, business id and name.", WORKSPACE),
  table("AccessToken", "Encrypted WhatsApp access token issued by Meta for the customer's account.", "Kept while the number is connected. Overwritten when the workspace is erased.", {
    erase: { method: "secrets-then-delete", overwrite: { tokenCiphertext: "", iv: "", authTag: "" } },
    how: "Ciphertext overwritten, then rows deleted by workspace id.",
  }),

  // Meta connection (Facebook Page, Instagram, ad account, dataset, catalog)
  table("MetaAsset", "Page, Instagram account, ad account, dataset and catalog ids and names, and encrypted page access tokens.", "Kept while connected. Tokens are deleted on disconnect; rows go with the workspace or when the Meta user's data is erased.", {
    erase: { method: "secrets-then-delete", overwrite: { tokenEnc: null } },
    how: "Tokens overwritten, then rows deleted. Also removed by the Meta data-deletion callback for the connecting user.",
    metaDerived: true,
  }),
  table("MetaConnection", "Facebook user id of the person who connected, business id, granted scopes, encrypted access token.", "Token deleted on disconnect. Row kept as a revoked record until the workspace or the Meta user's data is erased.", {
    erase: { method: "secrets-then-delete", overwrite: { tokenEnc: "" } },
    how: "Token revoked at Meta (best effort) and overwritten, then rows deleted. Also removed by the Meta data-deletion callback for the connecting user.",
    metaDerived: true,
  }),

  // Integrations and API
  table("WebhookDelivery", "Outbound webhook payloads, which carry event data such as contact and message details.", "30 days (configurable).", { retentionKey: "webhookDeliveryDays" }),
  table("WebhookEndpoint", "Destination URL and encrypted signing secret.", WORKSPACE, {
    erase: { method: "secrets-then-delete", overwrite: { secretCiphertext: "", iv: "", authTag: "" } },
    how: "Secret overwritten, then rows deleted by workspace id.",
  }),
  table("ApiKey", "Key name, prefix, hash and scopes (the key itself is never stored).", WORKSPACE),

  // Usage, billing and onboarding
  table("UsageLedger", "Meter, amount and reference ids for AI credits, ad accounts and posts.", "400 days (configurable).", { retentionKey: "usageLedgerDays" }),
  table("WalletTransaction", "Amount, kind and reference of wallet movements.", WORKSPACE),
  table("OnboardingLog", "Steps and outcome of connecting a WhatsApp number.", WORKSPACE),
  table("AgentAvailability", "Team member user id and availability settings.", WORKSPACE),
  table("RoutingConfig", "Assignment settings and fallback user id.", WORKSPACE),
  table("TeamMember", "Which team member belongs to which team (user id and team id).", WORKSPACE),
  table("Team", "Team names and which one is the default.", WORKSPACE),

  // Spend controls (docs/SPEND-CONTROLS-SPEC.md 3.5). No foreign keys between these tables.
  table("SpendLedger", "Every spending decision: who made it (user id, assistant or system), what changed, worst-case forecasts, values before and after, the reason, approval id and undo recipe.", "Kept while the workspace exists. Rows are never changed or deleted, except when the workspace is erased.", {
    erase: { method: "append-only-purge", guc: "edwyz.purge" },
    how: "Append-only by database trigger. Deleted by workspace id inside one transaction that first sets edwyz.purge to this table and this workspace, so no other workspace's rows can be deleted.",
  }),
  table("SpendConsent", "Which user agreed to what (Meta's spending limit or WhatsApp spending alerts), the text version and its hash, and when.", "Kept while the workspace exists as proof of consent. Rows are never changed or deleted, except when the workspace is erased.", {
    erase: { method: "append-only-purge", guc: "edwyz.purge" },
    how: "Append-only by database trigger. Deleted by workspace id inside the same purge transaction as the spending ledger.",
  }),
  table("OwnerNotifyChannel", "WhatsApp number of the owner or an approver for spending alerts, opt-in and opt-out times.", "While the person is a member and has not opted out. Removed with the membership or the workspace.", {
    how: "Deleted in batches by workspace id. The person's copy in the platform notifier workspace is removed by the notifier erasure.",
  }),
  table("SpendApproval", "Spending requests from assistants: what they asked to change, the plain reason, forecasts, the hashed link token and who decided.", "90 days after the decision (configurable, with approval requests).", { retentionKey: "approvalRequestDays" }),
  table("AssistantShadowRecord", "What an assistant would have done while learning (ad object ids, forecast, reason, results). No individual people.", "400 days (configurable, with ad performance data).", { retentionKey: "insightSnapshotDays" }),
  table("SpendBreaker", "Safety stops: which campaign, ad set, number or workspace was paused or held, why, and who cleared it (user id).", "Kept while the workspace exists. Cleared safety stops are removed after 400 days."),
  table("IntradaySpendSample", "Spend, impressions, clicks and results of ad sets sampled every 15 minutes today. No individual people.", "35 days after the sample is taken."),
  table("SpendDaily", "Daily spend per ad account, campaign, ad set and WhatsApp number. No individual people.", "400 days (configurable, with ad performance data).", { retentionKey: "insightSnapshotDays", primaryKey: "scopeId" }),
  table("SpendReservation", "Money set aside for broadcasts, automation runs, API batches and AI calls in progress (ids and amounts).", "Closed reservations are removed after 90 days."),
  table("SpendCounter", "Running totals of WhatsApp and AI spend per day and month (amounts only).", WORKSPACE, { primaryKey: "periodKey", how: "Deleted by workspace id." }),
  table("SpendCommitment", "Money set aside for running ads, per campaign or ad set (ids, budgets, dates).", "Kept while the workspace exists. Stopped entries are removed after 400 days."),
  table("MetaSpendLimit", "State of Meta's spending limit on each ad account Edwyz manages (account id, amounts, mode, last error).", WORKSPACE, {
    primaryKey: "adAccountAssetId",
    how: "The offboarding choice for Meta's limit is applied first while the token still works, then rows are deleted by workspace id.",
  }),
  table("AssistantMandate", "Autonomy level and limits the owner set for each assistant, and the user id of the last change.", WORKSPACE),
  table("SpendAllowance", "The workspace's monthly and daily limits per pot, and the user id of the last change.", WORKSPACE),
  table("SpendControl", "Spending switches: whether spending is stopped and by whom, new-workspace limit state, approver user ids, time zone, target cost per lead.", WORKSPACE, {
    primaryKey: "tenantId",
    how: "Deleted by workspace id (single row). Workspace overrides in SpendCeiling (scope tenant) are deleted with it.",
  }),

  // Eddy, the action layer and in-app notices (docs/EDDY-SPEC.md 8.3), children first.
  table("NoticeReceipt", "Which member saw, dismissed or was shown each in-app notice (user and notice ids, times).", "Removed with its notice (30 days, configurable) or with the workspace.", { primaryKey: "noticeId", retentionKey: "noticeDays" }),
  table("Notice", "In-app notices: kind, ids, counts and codes, and the member it is for. Never customer message text.", "30 days after it is created or resolved (configurable).", { retentionKey: "noticeDays" }),
  table("NoticeScanState", "Where each notice scanner stopped (timestamps and ids only).", WORKSPACE, { primaryKey: "scanner", how: "Deleted by workspace id." }),
  table("ActionInvocation", "Log of every action Eddy or another surface ran: user id, action name, hashed and redacted arguments, outcome.", "400 days (configurable). Rows are never changed, except that the user id is removed when the person is anonymised.", { retentionKey: "actionInvocationDays" }),
  table("ActionRecord", "Preview cards, confirmations and undo records: user id, action, its arguments (which can include names, phone numbers and message text the member could see), the result.", "90 days (configurable), sooner when a contact it mentions is erased.", { retentionKey: "actionRecordDays" }),
  table("EddyMessage", "What a team member typed to Eddy, Eddy’s replies, and tool results that can include contact names, phone numbers and message text the member could already see.", "90 days after the conversation’s last message (configurable), sooner if the member deletes it or leaves the workspace; erased at once when a contact it mentions is erased.", { retentionKey: "eddyHistoryDays" }),
  table("EddyTurn", "Usage of each Eddy reply: member user id, model, token counts, cost and credits, timings. No message text.", "400 days (configurable, with AI usage records). The user id is removed when the person is anonymised.", { retentionKey: "usageLedgerDays" }),
  table("EddyConversation", "One Eddy chat of a team member: user id, role at the start, language, title, status.", "90 days after its last message (configurable), sooner if the member deletes it or leaves the workspace.", { retentionKey: "eddyHistoryDays" }),
  table("EddyUserPref", "A member's Eddy settings: language, notice preferences, when they saw the first-use notice.", "While the person is a member.", { primaryKey: "userId", how: "Deleted by workspace id, and with the membership." }),
  table("EddyWorkspaceSetting", "Whether Eddy is switched on, who switched it on and when, and the consent version.", WORKSPACE, { primaryKey: "tenantId", how: "Deleted by workspace id (single row)." }),

  table("BillingProfile", "Billing legal name, GSTIN, address, billing email.", "Kept while the workspace exists. Invoices keep their own copy as tax law requires.", { primaryKey: "tenantId", how: "Deleted by workspace id (single row)." }),
  table("Subscription", "Plan, status, period dates, Razorpay subscription id.", "Kept while the workspace exists.", { how: "Deleted by workspace id (single row). Erasure is refused while a Razorpay subscription is active unless the operator confirms it was cancelled." }),
  table("Invoice", "Customer name, GSTIN, address, amounts, Razorpay payment id.", "Kept as tax and accounting law requires. The period is to be confirmed with an accountant. No deletion job.", {
    erase: { method: "retain", reason: "Tax and accounting records must be kept by law." },
    how: "Not erased with the workspace. Only the workspace link (tenant row) is removed.",
  }),

  // Logs and sessions
  table("WebhookEvent", "Raw payloads received from Meta, which contain message text and phone numbers.", "30 days after processing; unprocessed events older than 30 days have their payload cleared.", {
    how: "Deleted by workspace id, plus events of the workspace's WhatsApp account and numbers that carry no workspace id.",
  }),
  table("AuditLog", "User id, action, target id and small metadata of account and workspace actions. No message content.", "Kept while the workspace exists. No automatic deletion job.", { how: BY_TENANT }),
  table("Session", "User id, workspace id, browser user agent, token hash.", "30 days after expiry or revocation."),
  table("Invite", "Invitee email address and role.", WORKSPACE),
  table("Membership", "Link between a user and the workspace, and the role.", "While the person is a member.", { how: "Deleted by workspace id. Users left with no workspace are anonymised unless they are platform admins." }),

  // Per-workspace rows that are not keyed by a tenantId column
  {
    id: "DailyMetric",
    store: "table",
    tenantColumn: "scope",
    holds: "Daily counters per workspace (no personal data).",
    retention: "Kept while the workspace exists.",
    erase: del,
    how: "Deleted where scope equals the workspace id.",
  },
  {
    id: "PlatformSetting",
    store: "settings",
    holds: "Per-workspace settings and state keyed by workspace id (ad caps, optimizer, conversions and Shopify settings, approval state, lifecycle markers). Short-lived rows for Meta connect state and onboarding locks.",
    retention: "Kept while the workspace exists. Meta connect state expires after minutes.",
    erase: { method: "custom" },
    how: "Rows whose key contains the workspace id are deleted, plus Meta connect state rows naming the workspace.",
  },
  {
    id: "Job",
    store: "queue",
    holds: "Queued background jobs. Payloads carry ids, and email jobs carry the recipient address and message.",
    retention: "Completed jobs deleted after 7 days.",
    erase: { method: "custom" },
    how: "Jobs whose payload names the workspace id are deleted.",
  },
  {
    id: "files:creative",
    store: "files",
    holds: "Generated ad images and videos, which can show the customer's brand and text.",
    retention: "Kept while the matching CreativeAsset exists. Files with no row are deleted after 24 hours.",
    erase: { method: "files", directory: "creative" },
    how: "Directory DATA_DIR/creative/<tenant id> removed after path checks.",
  },
  {
    id: "files:content",
    store: "files",
    holds: "Images and videos uploaded for scheduled posts.",
    retention: "Kept until the customer deletes them or the workspace is erased.",
    erase: { method: "files", directory: "content" },
    how: "Directory DATA_DIR/content/<tenant id> removed after path checks.",
  },
  {
    id: "files:inbound-media",
    store: "files",
    holds: "Copies of photos, videos, voice notes and documents that customers of the workspace sent on WhatsApp, cached so the team can view them in the inbox.",
    retention: "Kept as a cache of at most 500 MB per workspace (oldest removed first). Removed with the message when a contact is erased, and with the workspace.",
    erase: { method: "files", directory: "inbound-media" },
    how: "Directory DATA_DIR/inbound-media/<tenant id> removed after path checks. A contact's files are deleted with the contact's messages.",
  },

  // Platform-level tables outside a workspace
  {
    id: "Tenant",
    store: "table",
    tenantColumn: "id",
    holds: "Workspace name and slug.",
    retention: "Kept while the workspace exists.",
    erase: { method: "custom" },
    how: "Row deleted last, in the same transaction as the erasure tombstone.",
  },
  {
    id: "User",
    store: "table",
    holds: "Name, email, password hash, encrypted two-factor secret and recovery code hashes.",
    retention: "Kept while the account exists.",
    erase: { method: "custom" },
    how: "Anonymised (anonymiseUser) when the user asks, or when a workspace erasure leaves the user with no workspace. Platform admins are skipped.",
  },
  {
    id: "EmailToken",
    store: "table",
    holds: "Hashed one-time tokens for email verification and password reset.",
    retention: "7 days after use or expiry.",
    erase: { method: "custom" },
    how: "Deleted when the user is anonymised.",
  },
  {
    id: "PaymentEvent",
    store: "table",
    holds: "Razorpay webhook payloads, which can include payer email and phone.",
    retention: "Kept as payment and tax records require. No deletion job.",
    erase: { method: "retain", reason: "Payment records must be kept by law." },
    how: "Not erased with the workspace.",
  },
];

export const RETENTION_SUMMARY: { label: string; period: string }[] = [
  { label: "Webhook events from Meta", period: `${FIXED_RETENTION_DAYS.webhookEvents} days after processing` },
  { label: "Completed background jobs", period: `${FIXED_RETENTION_DAYS.doneJobs} days` },
  { label: "Automation run records", period: `${FIXED_RETENTION_DAYS.automationRuns} days` },
  { label: "Sign-in sessions", period: `${FIXED_RETENTION_DAYS.sessions} days after expiry or revocation` },
  { label: "One-time email tokens", period: `${FIXED_RETENTION_DAYS.emailTokens} days after use or expiry` },
  { label: "Ad performance data (insight snapshots, results by placement, version, age and gender, and region, finished optimizer proposals)", period: `${RETENTION_DEFAULTS.insightSnapshotDays} days` },
  { label: "Conversion events sent to Meta", period: `${RETENTION_DEFAULTS.conversionEventDays} days` },
  { label: "Approval requests", period: `${RETENTION_DEFAULTS.approvalRequestDays} days after the decision` },
  { label: "Finished chatbot sessions", period: `${RETENTION_DEFAULTS.chatbotSessionDays} days after they end` },
  { label: "AI credit and usage records", period: `${RETENTION_DEFAULTS.usageLedgerDays} days` },
  { label: "Leads from lead ads", period: `${RETENTION_DEFAULTS.leadMonths} months after last activity` },
  { label: "Abandoned cart records", period: `${RETENTION_DEFAULTS.abandonedCartDays} days` },
  { label: "Outbound webhook delivery records", period: `${RETENTION_DEFAULTS.webhookDeliveryDays} days` },
];

export const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * Entries that workspace erasure deletes by workspace id, in order: in batches beforehand (batchedTables) or inside its final
 * transaction (erasureTransactionTables).
 */
export function deletableTables(): PersonalDataEntry[] {
  return PERSONAL_DATA.filter((e) => e.store === "table" && (e.erase.method === "delete" || e.erase.method === "secrets-then-delete"));
}

/** The deletable tables erasure clears in batches before its final transaction, in order. */
export function batchedTables(): PersonalDataEntry[] {
  return deletableTables().filter((e) => !e.inErasureTransaction);
}

/** The deletable tables erasure clears inside its final transaction, with the workspace row and the tombstone, in order. */
export function erasureTransactionTables(): PersonalDataEntry[] {
  return deletableTables().filter((e) => e.inErasureTransaction === true);
}

/** Append-only tables that workspace erasure purges inside one transaction with the edwyz.purge GUC (SpendLedger, SpendConsent). */
export function appendOnlyPurgeTables(): PersonalDataEntry[] {
  return PERSONAL_DATA.filter((e) => e.store === "table" && e.erase.method === "append-only-purge");
}
