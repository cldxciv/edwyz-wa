import { GraphError, graphFetchAs } from "@/lib/graph";
import { log } from "@/lib/log";
import { decimalToMinorBig } from "@/lib/spend/money";
import { INT_MAX } from "./insights-money";

export type InsightLevel = "campaign" | "adset" | "ad";
export const LEVELS: InsightLevel[] = ["campaign", "adset", "ad"];
export const MAX_PAGES = 40;
export const MAX_ROWS = 20_000;
const PAGE_SIZE = 500;

export class InsightsRateLimitError extends Error {
  constructor() {
    super("Meta rate limit reached");
  }
}

export type RawInsightRow = {
  date_start?: string;
  campaign_id?: string;
  adset_id?: string;
  ad_id?: string;
  objective?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  frequency?: string;
  quality_ranking?: string;
  actions?: { action_type?: string; value?: string }[];
};

const BASE_FIELDS = ["date_start", "objective", "spend", "impressions", "clicks", "frequency", "actions"];
const LEVEL_FIELDS: Record<InsightLevel, string[]> = {
  campaign: ["campaign_id"],
  adset: ["campaign_id", "adset_id"],
  ad: ["campaign_id", "adset_id", "ad_id", "quality_ranking"],
};

export const entityIdOf = (level: InsightLevel, row: RawInsightRow): string | undefined =>
  level === "campaign" ? row.campaign_id : level === "adset" ? row.adset_id : row.ad_id;

/** Meta codes: 4 app limit, 17 account limit, 32 page limit, 613 custom limit, 80000 to 80014 Business Use Case limits. VERIFY. */
export function isRateLimit(e: unknown): boolean {
  if (!(e instanceof GraphError)) return false;
  const c = e.code;
  return e.status === 429 || c === 4 || c === 17 || c === 32 || c === 613 || (c !== undefined && c >= 80000 && c <= 80014);
}

type Page = { data?: RawInsightRow[]; paging?: { cursors?: { after?: string }; next?: string } };

export const accountPath = (externalId: string) => `act_${externalId.replace(/^act_/, "")}/insights`;

/** Daily rows for one level and window, following cursors up to MAX_PAGES and MAX_ROWS. Throws InsightsRateLimitError. */
export async function fetchLevel(
  token: string,
  externalId: string,
  level: InsightLevel,
  since: string,
  until: string,
): Promise<{ rows: RawInsightRow[]; truncated: boolean }> {
  const rows: RawInsightRow[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const query: Record<string, string> = {
      level,
      fields: [...BASE_FIELDS, ...LEVEL_FIELDS[level]].join(","),
      time_increment: "1",
      time_range: JSON.stringify({ since, until }),
      limit: String(PAGE_SIZE),
    };
    if (after) query.after = after;
    let res: Page;
    try {
      res = await graphFetchAs<Page>(token, { path: accountPath(externalId), query });
    } catch (e) {
      if (isRateLimit(e)) throw new InsightsRateLimitError();
      throw e;
    }
    for (const row of res.data ?? []) {
      if (rows.length >= MAX_ROWS) return { rows, truncated: true };
      rows.push(row);
    }
    after = res.paging?.next ? res.paging.cursors?.after : undefined;
    if (!after) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

/**
 * The exact spend of one row in minor units (docs/SPEND-CONTROLS-SPEC.md 3.1): decimalToMinorBig, with no clamp, for the
 * spend controls' SpendDaily rows. The reporting snapshot keeps its 32-bit column; when its clamp would fire this logs
 * `insights.clamped` (ids and the level only), and the spend book uses only the exact value. Null for unreadable spend.
 */
export function exactSpendMinor(row: Pick<RawInsightRow, "spend" | "date_start">, exponent: number, ref: { level: InsightLevel; id?: string } = { level: "campaign" }): { minor: bigint; clamped: boolean } | null {
  let minor: bigint;
  try {
    minor = decimalToMinorBig(row.spend ?? "0", exponent);
  } catch {
    return null;
  }
  const clamped = minor > BigInt(INT_MAX);
  if (clamped) log.warn("insights.clamped", { level: ref.level, entity: ref.id ?? null, date: row.date_start ?? null });
  return { minor, clamped };
}

/**
 * One insights read of an ad account with the caller's query (the spend controls' fast sync, docs/SPEND-CONTROLS-SPEC.md
 * 6.1), following cursors up to `maxPages`. Reads only. Meta's errors are thrown as they are (isRateLimit tells a rate limit).
 */
export async function fetchAccountInsights(token: string, externalId: string, query: Record<string, string>, maxPages = 10): Promise<RawInsightRow[]> {
  const rows: RawInsightRow[] = [];
  let after: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await graphFetchAs<Page>(token, { path: accountPath(externalId), method: "GET", query: { ...query, limit: String(PAGE_SIZE), ...(after ? { after } : {}) } });
    rows.push(...(res?.data ?? []));
    after = res?.paging?.next ? res.paging.cursors?.after : undefined;
    if (!after) break;
  }
  return rows;
}
