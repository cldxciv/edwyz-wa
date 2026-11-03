"use client";

/**
 * PlacePicker (docs/IG-PAGE-ADS-SPEC.md 3.7 "People near my shop", 7.3): where the shop is and how far around it.
 *
 * - [Use my shop location] asks the browser for its location (the geolocation prompt), pins it, and saves it as the shop in
 *   Promote settings, so the next ad starts there.
 * - Or search: a 6-digit PIN code or a city (GET /api/promote/geo). A place whose map position the answer gives is pinned.
 *   Meta's place search gives keys and names only (promote/meta Place), so today a searched place is explained instead
 *   ("Use your shop location, or choose another audience"); a location turned off says the same, never "search instead".
 * - A km slider from 1 to 50, with the value in words ("5 km").
 * The status line is polite and says what happened ("Finding where you are…", "Location is off for this site…").
 */
import { useEffect, useId, useRef, useState } from "react";
import { Button, cn, Input } from "@/components/ui";
import type { PromoteLang, ShopLocation } from "@/lib/promote/types";
import { clampRadius, errorText, placeFromPosition, placeFromSearch, PROMOTE_TEST_IDS, RADIUS_KM } from "./flow-helpers";
import { jsonRequest } from "./usePromoteDraft";
import { usePromoteCopy } from "./usePromoteCopy";

export type PlacePickerProps = {
  value: ShopLocation | null;
  onChange: (place: ShopLocation) => void;
  lang?: PromoteLang;
  className?: string;
};

type Found = { key: string; name: string; type: string | null; region: string | null; lat?: unknown; lng?: unknown; latitude?: unknown; longitude?: unknown };

const SEARCH_DEBOUNCE_MS = 400;

export function PlacePicker({ value, onChange, lang = "en", className }: PlacePickerProps) {
  const t = usePromoteCopy(lang);
  const uid = useId();
  const [status, setStatus] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Found[] | null>(null);
  const [searching, setSearching] = useState(false);
  const seq = useRef(0);

  // Search 400 ms after the member stops typing; at least 2 characters (a PIN code is 6 digits).
  useEffect(() => {
    const text = q.trim();
    if (text.length < 2) {
      setFound(null);
      return;
    }
    const id = ++seq.current;
    const timer = setTimeout(async () => {
      setSearching(true);
      const res = await jsonRequest("GET", `/api/promote/geo?q=${encodeURIComponent(text)}`);
      if (id !== seq.current) return;
      setSearching(false);
      const body = res.body as { places?: Found[] } | null;
      if (res.status === 200 && Array.isArray(body?.places)) setFound(body.places.slice(0, 10));
      else {
        setFound([]);
        setStatus(errorText(res.body, "media.picker.load_failed", lang));
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [q, lang]);

  const radius = value?.radiusKm ?? 5;

  const locate = () => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setStatus(t("place.denied"));
      return;
    }
    setLocating(true);
    setStatus(t("place.locating"));
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        const place = placeFromPosition(pos.coords.latitude, pos.coords.longitude, t("place.my_shop"), radius);
        if (!place) {
          setStatus(t("place.denied"));
          return;
        }
        onChange(place);
        setStatus(t("place.around", { km: String(place.radiusKm), label: place.label }));
        // The shop is saved for the next ad too (best effort: the draft already has the pin).
        void jsonRequest("PUT", "/api/promote/settings", { shop: { lat: place.lat, lng: place.lng, label: place.label, pincode: null } });
      },
      () => {
        setLocating(false);
        setStatus(t("place.denied"));
      },
      { enableHighAccuracy: false, timeout: 15_000, maximumAge: 300_000 },
    );
  };

  const choose = (p: Found) => {
    const place = placeFromSearch(p, radius);
    if (!place) {
      setStatus(t("place.no_pin"));
      return;
    }
    onChange(place);
    setFound(null);
    setQ("");
    setStatus(t("place.around", { km: String(place.radiusKm), label: place.label }));
  };

  const sliderId = `${uid}-radius`;
  const searchId = `${uid}-search`;

  return (
    <div className={cn("flex min-w-0 flex-col gap-4", className)} data-testid={PROMOTE_TEST_IDS.placePicker}>
      <Button type="button" variant="secondary" className="self-start pointer-coarse:min-h-11" onClick={locate} loading={locating}>
        {t("place.use_location")}
      </Button>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={searchId} className="text-sm font-medium">
          {t("place.search")}
        </label>
        <Input id={searchId} type="search" inputMode="search" autoComplete="postal-code" value={q} aria-describedby={`${searchId}-hint`} aria-busy={searching || undefined} onChange={(e) => setQ(e.target.value)} />
        <p id={`${searchId}-hint`} className="text-xs text-muted">
          {t("place.search_hint")}
        </p>
        {found && (
          <ul className="flex flex-col gap-1" aria-label={t("place.search")}>
            {found.length === 0 && !searching && <li className="text-sm text-muted">{t("place.none")}</li>}
            {found.map((p) => (
              <li key={p.key}>
                <button type="button" className="flex min-h-11 w-full items-center rounded-md px-3 text-left text-sm hover:bg-surface-2" onClick={() => choose(p)}>
                  {[p.name, p.region].filter(Boolean).join(", ")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {value && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={sliderId} className="text-sm font-medium">
            {t("place.radius")}
          </label>
          <div className="flex items-center gap-3">
            <input
              id={sliderId}
              type="range"
              min={RADIUS_KM.min}
              max={RADIUS_KM.max}
              step={1}
              value={radius}
              aria-valuetext={t("place.radius_value", { km: String(radius) })}
              onChange={(e) => onChange({ ...value, radiusKm: clampRadius(Number(e.target.value)) })}
              className="h-11 min-w-0 flex-1 accent-accent"
            />
            <span className="w-14 shrink-0 text-right text-sm tabular-nums" aria-hidden>
              {t("place.radius_value", { km: String(radius) })}
            </span>
          </div>
          <p className="text-sm text-muted break-words">{t("place.around", { km: String(radius), label: value.label || t("place.my_shop") })}</p>
        </div>
      )}

      <p role="status" aria-live="polite" className="text-sm text-muted">
        {status}
      </p>
    </div>
  );
}

export default PlacePicker;
