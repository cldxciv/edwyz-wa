"use client";

/**
 * AudienceCards (docs/IG-PAGE-ADS-SPEC.md 3.7, 7.3, D9, D17): who sees the ad.
 *
 * - "Let Meta find people (recommended)": the workspace country, 18+, with "Meta treats age and gender as suggestions and may
 *   show your ad to others who are likely to respond."
 * - "People near my shop": PlacePicker (the browser's location, a PIN code or city, and a km slider from 1 to 50).
 * - "People I choose": a saved audience (its settings are copied in), age, gender, interests found by name (never typed ids),
 *   the workspace's ready audiences, and exclusions such as people who already chat with you. A link opens the audience manager.
 * The size line ("About 1.2–1.8 lakh people", or "Size not available right now") comes from POST /api/promote/audiences/size,
 * asked 600 ms after the last change and announced politely.
 *
 * Controlled through draft-path sets: onChange({"audience.mode": "near_shop", "audience.nearShop": {...}}).
 */
import Link from "next/link";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cn, Input, Select } from "@/components/ui";
import type { Gender } from "@/lib/ads/types";
import type { PromoteLang, PromotionDraft, ShopLocation } from "@/lib/promote/types";
import { AGE, AUDIENCES_PATH, audienceModeSet, errorText, PROMOTE_TEST_IDS, sizeTargeting } from "./flow-helpers";
import { PlacePicker } from "./PlacePicker";
import { jsonRequest } from "./usePromoteDraft";
import { usePromoteCopy } from "./usePromoteCopy";

export type AudienceCardsProps = {
  audience: PromotionDraft["audience"];
  onChange: (set: Record<string, unknown>) => void;
  /** The saved shop (Promote settings), used when "People near my shop" is picked. */
  shop: ShopLocation | null;
  specialAdCategory: string;
  lang?: PromoteLang;
  className?: string;
};

type AudienceLite = { id: string; kind: string; name: string; usable: boolean; chipText: string; sizeLine: string | null; details: Record<string, unknown> };
type InterestLite = { id: string; name: string };

const SIZE_DEBOUNCE_MS = 600;
const AGES = Array.from({ length: AGE.max - AGE.min + 1 }, (_, i) => AGE.min + i);

function useAudienceList(enabled: boolean, lang: PromoteLang) {
  const [list, setList] = useState<AudienceLite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled || list) return;
    let live = true;
    void jsonRequest("GET", "/api/promote/audiences").then((res) => {
      if (!live) return;
      const body = res.body as { audiences?: AudienceLite[] } | null;
      if (res.status === 200 && Array.isArray(body?.audiences)) setList(body.audiences);
      else setError(errorText(res.body, "media.picker.load_failed", lang));
    });
    return () => {
      live = false;
    };
  }, [enabled, list, lang]);
  return { list, error };
}

/** The audience size for the draft's audience, 600 ms after the last change. */
function useSizeLine(audience: PromotionDraft["audience"], specialAdCategory: string, lang: PromoteLang): { line: string | null; loading: boolean } {
  const t = usePromoteCopy(lang);
  const [line, setLine] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const key = JSON.stringify([sizeTargeting({ audience }), specialAdCategory]);
  const seq = useRef(0);
  useEffect(() => {
    const id = ++seq.current;
    setLoading(true);
    const timer = setTimeout(async () => {
      const res = await jsonRequest("POST", "/api/promote/audiences/size", { targeting: sizeTargeting({ audience }), specialAdCategory });
      if (id !== seq.current) return;
      setLoading(false);
      const size = (res.body as { size?: { line?: unknown } } | null)?.size;
      setLine(res.status === 200 && typeof size?.line === "string" ? size.line : t("audience.size_unknown"));
    }, SIZE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // The key carries everything the request reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { line, loading };
}

function InterestSearch({ chosen, onChange, lang }: { chosen: InterestLite[]; onChange: (list: InterestLite[]) => void; lang: PromoteLang }) {
  const t = usePromoteCopy(lang);
  const uid = useId();
  const [q, setQ] = useState("");
  const [found, setFound] = useState<InterestLite[] | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    const text = q.trim();
    if (text.length < 2) {
      setFound(null);
      return;
    }
    const id = ++seq.current;
    const timer = setTimeout(async () => {
      const res = await jsonRequest("GET", `/api/promote/interests?q=${encodeURIComponent(text)}`);
      if (id !== seq.current) return;
      const body = res.body as { interests?: InterestLite[] } | null;
      setFound(res.status === 200 && Array.isArray(body?.interests) ? body.interests.slice(0, 10) : []);
    }, 400);
    return () => clearTimeout(timer);
  }, [q]);
  const inputId = `${uid}-interests`;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={inputId} className="text-sm font-medium">
        {t("audience.interests")}
      </label>
      <Input id={inputId} type="search" value={q} aria-describedby={`${inputId}-hint`} onChange={(e) => setQ(e.target.value)} />
      <p id={`${inputId}-hint`} className="text-xs text-muted">
        {t("audience.interests_hint")}
      </p>
      {found && (
        <ul className="flex flex-col gap-1">
          {found.length === 0 && <li className="text-sm text-muted">{t("audience.none_found")}</li>}
          {found
            .filter((i) => !chosen.some((c) => c.id === i.id))
            .map((i) => (
              <li key={i.id}>
                <button type="button" className="flex min-h-11 w-full items-center rounded-md px-3 text-left text-sm hover:bg-surface-2" onClick={() => onChange([...chosen, { id: i.id, name: i.name }].slice(0, 25))}>
                  {t("audience.interest_add", { name: i.name })}
                </button>
              </li>
            ))}
        </ul>
      )}
      {chosen.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {chosen.map((i) => (
            <li key={i.id}>
              <button
                type="button"
                className="inline-flex min-h-11 items-center gap-2 rounded-full border border-border bg-surface px-3 text-sm"
                aria-label={t("audience.interest_remove", { name: i.name })}
                onClick={() => onChange(chosen.filter((c) => c.id !== i.id))}
              >
                {i.name}
                <span aria-hidden>×</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AudienceCards({ audience, onChange, shop, specialAdCategory, lang = "en", className }: AudienceCardsProps) {
  const t = usePromoteCopy(lang);
  const uid = useId();
  const mode = audience.mode;
  const chooses = mode === "i_choose";
  const { list, error } = useAudienceList(chooses, lang);
  const size = useSizeLine(audience, specialAdCategory, lang);
  const saved = (list ?? []).filter((a) => a.kind === "saved");
  const custom = (list ?? []).filter((a) => a.kind !== "saved" && a.usable);

  const card = (value: PromotionDraft["audience"]["mode"], title: string, note: string | null, body: ReactNode) => {
    const on = mode === value;
    return (
      <li className="min-w-0">
        <label
          className={cn(
            "flex min-h-11 min-w-0 cursor-pointer items-start gap-3 rounded-card border p-4 transition-colors duration-(--dur-fast) has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
            on ? "border-accent-ink bg-raised shadow-raised" : "border-border bg-surface hover:bg-surface-2",
          )}
        >
          <input type="radio" name={`${uid}-audience`} value={value} checked={on} onChange={() => onChange(audienceModeSet(value, value === "near_shop" ? (audience.nearShop ?? shop) : null))} className="mt-1 h-4 w-4 shrink-0 accent-accent" />
          <span className="flex min-w-0 flex-col gap-1">
            <span className="font-semibold break-words">{title}</span>
            {note && <span className="text-sm text-muted break-words">{note}</span>}
          </span>
        </label>
        {on && body && <div className="mt-3 min-w-0 rounded-card border border-border p-4">{body}</div>}
      </li>
    );
  };

  const toggleId = (path: "audience.customAudienceIds" | "audience.excludedAudienceIds", list: string[], id: string, on: boolean) => onChange({ [path]: on ? [...new Set([...list, id])] : list.filter((x) => x !== id) });

  const chooseBody = (
    <div className="flex min-w-0 flex-col gap-4">
      {error && <p className="text-sm text-bad-fg">{error}</p>}
      {saved.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${uid}-saved`} className="text-sm font-medium">
            {t("audience.saved")}
          </label>
          <Select
            id={`${uid}-saved`}
            value={audience.savedAudienceId ?? ""}
            onChange={(e) => {
              const pick = saved.find((a) => a.id === e.target.value) ?? null;
              const targeting = pick && pick.details && typeof pick.details.targeting === "object" && pick.details.targeting ? (pick.details.targeting as Record<string, unknown>) : null;
              const set: Record<string, unknown> = { "audience.savedAudienceId": pick?.id ?? null };
              if (targeting) {
                if (typeof targeting.ageMin === "number") set["audience.ageMin"] = Math.max(AGE.min, targeting.ageMin);
                if (typeof targeting.ageMax === "number") set["audience.ageMax"] = targeting.ageMax >= AGE.max ? null : targeting.ageMax;
                if (Array.isArray(targeting.genders)) set["audience.genders"] = targeting.genders;
                if (Array.isArray(targeting.interests)) set["audience.interests"] = targeting.interests;
              }
              onChange(set);
            }}
          >
            <option value="">{t("audience.saved_none")}</option>
            {saved.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </div>
      )}

      <fieldset className="flex min-w-0 flex-col gap-2">
        <legend className="text-sm font-medium">{t("audience.age")}</legend>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor={`${uid}-agemin`} className="text-xs text-muted">
              {t("audience.age_min")}
            </label>
            <Select id={`${uid}-agemin`} value={String(audience.ageMin)} onChange={(e) => onChange({ "audience.ageMin": Number(e.target.value) })}>
              {AGES.filter((a) => a < (audience.ageMax ?? AGE.max + 1)).map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${uid}-agemax`} className="text-xs text-muted">
              {t("audience.age_max")}
            </label>
            <Select id={`${uid}-agemax`} value={audience.ageMax === null ? "" : String(audience.ageMax)} onChange={(e) => onChange({ "audience.ageMax": e.target.value ? Number(e.target.value) : null })}>
              {AGES.filter((a) => a > audience.ageMin && a < AGE.max).map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
              <option value="">{t("audience.age_any")}</option>
            </Select>
          </div>
        </div>
      </fieldset>

      <fieldset className="flex min-w-0 flex-col gap-2">
        <legend className="text-sm font-medium">{t("audience.gender")}</legend>
        <div className="flex flex-wrap gap-2">
          {(
            [
              ["all", [] as Gender[], "audience.gender.all"],
              ["female", ["female"] as Gender[], "audience.gender.female"],
              ["male", ["male"] as Gender[], "audience.gender.male"],
            ] as const
          ).map(([id, genders, key]) => {
            const on = id === "all" ? audience.genders.length !== 1 : audience.genders.length === 1 && audience.genders[0] === id;
            return (
              <label key={id} className={cn("inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border px-4 text-sm", on ? "border-accent-ink bg-accent-soft text-accent-ink" : "border-border")}>
                <input type="radio" name={`${uid}-gender`} checked={on} onChange={() => onChange({ "audience.genders": genders })} className="sr-only" />
                {t(key)}
              </label>
            );
          })}
        </div>
      </fieldset>

      <InterestSearch chosen={audience.interests} onChange={(interests) => onChange({ "audience.interests": interests })} lang={lang} />

      {custom.length > 0 && (
        <>
          <fieldset className="flex min-w-0 flex-col gap-2">
            <legend className="text-sm font-medium">{t("audience.your_audiences")}</legend>
            {custom.map((a) => (
              <label key={a.id} className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
                <input type="checkbox" className="h-5 w-5 shrink-0 accent-accent" checked={audience.customAudienceIds.includes(a.id)} onChange={(e) => toggleId("audience.customAudienceIds", audience.customAudienceIds, a.id, e.target.checked)} />
                <span className="min-w-0 break-words">
                  {a.name}
                  {a.sizeLine && <span className="block text-xs text-muted">{a.sizeLine}</span>}
                </span>
              </label>
            ))}
          </fieldset>
          <fieldset className="flex min-w-0 flex-col gap-2">
            <legend className="text-sm font-medium">{t("audience.exclude")}</legend>
            {custom.map((a) => (
              <label key={a.id} className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
                <input type="checkbox" className="h-5 w-5 shrink-0 accent-accent" checked={audience.excludedAudienceIds.includes(a.id)} onChange={(e) => toggleId("audience.excludedAudienceIds", audience.excludedAudienceIds, a.id, e.target.checked)} />
                <span className="min-w-0 break-words">{a.name}</span>
              </label>
            ))}
          </fieldset>
        </>
      )}
      <Link href={AUDIENCES_PATH} className="inline-flex min-h-11 items-center self-start text-sm font-medium underline underline-offset-2">
        {t("audience.manage")}
      </Link>
    </div>
  );

  return (
    <div className={cn("flex min-w-0 flex-col gap-3", className)} data-testid={PROMOTE_TEST_IDS.audienceCards}>
      <fieldset className="min-w-0">
        <legend className="mb-2 text-sm font-semibold">{t("audience.legend")}</legend>
        <ul className="flex flex-col gap-3">
          {card("meta_finds", t("audience.meta_finds"), t("audience.meta_finds_note"), null)}
          {card("near_shop", t("audience.near_shop"), null, <PlacePicker value={audience.nearShop ?? shop} onChange={(place) => onChange({ "audience.mode": "near_shop", "audience.nearShop": place })} lang={lang} />)}
          {card("i_choose", t("audience.i_choose"), null, chooseBody)}
        </ul>
      </fieldset>
      <p className="text-sm font-medium" aria-live="polite" aria-busy={size.loading || undefined} data-testid={PROMOTE_TEST_IDS.sizeLine}>
        {size.line ?? t("audience.size_loading")}
      </p>
    </div>
  );
}

export default AudienceCards;
