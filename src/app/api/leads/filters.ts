import { LEAD_PLATFORMS, LEAD_SOURCES, type LeadPlatform, type LeadSourceKey } from "@/lib/leads/ingest";
import { HttpError } from "@/lib/tenancy";

/** platform=not_reported lists the leads Meta gave no platform for (the capability probe, IG-PAGE-ADS-SPEC 3.10). */
export const PLATFORM_NOT_REPORTED = "not_reported";

export type LeadFilters = {
  status?: string;
  formId?: string;
  campaign?: string;
  assignedToId?: string;
  from?: string;
  to?: string;
  /** Lead.source: instant_form, ctwa, ctig, ctm or manual. */
  source?: LeadSourceKey;
  platform?: LeadPlatform | typeof PLATFORM_NOT_REPORTED;
  /** true: only test leads (D33); false: no test leads; left out: both. */
  test?: boolean;
};

/** The leads list and export filters from the query string. An unknown source, platform or test value answers 400. */
export function filtersFrom(params: URLSearchParams): LeadFilters {
  const get = (k: string) => params.get(k) || undefined;
  return {
    status: get("status"),
    formId: get("formId"),
    campaign: get("campaign"),
    assignedToId: get("assignedToId"),
    from: get("from"),
    to: get("to"),
    ...sourceFilter(get("source")),
    ...platformFilter(get("platform")),
    ...testFilter(get("test")),
  };
}

function sourceFilter(v: string | undefined): Pick<LeadFilters, "source"> {
  if (v === undefined) return {};
  // The name the list used for form leads before Lead.source existed.
  if (v === "meta_lead_form") return { source: "instant_form" };
  if (!(LEAD_SOURCES as readonly string[]).includes(v)) throw new HttpError(400, `source must be one of ${LEAD_SOURCES.join(", ")}.`);
  return { source: v as LeadSourceKey };
}

function platformFilter(v: string | undefined): Pick<LeadFilters, "platform"> {
  if (v === undefined) return {};
  if (v !== PLATFORM_NOT_REPORTED && !(LEAD_PLATFORMS as readonly string[]).includes(v)) throw new HttpError(400, `platform must be one of ${[...LEAD_PLATFORMS, PLATFORM_NOT_REPORTED].join(", ")}.`);
  return { platform: v as LeadFilters["platform"] };
}

function testFilter(v: string | undefined): Pick<LeadFilters, "test"> {
  if (v === undefined) return {};
  if (v === "true" || v === "1") return { test: true };
  if (v === "false" || v === "0") return { test: false };
  throw new HttpError(400, "test must be true or false.");
}
