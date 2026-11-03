/*
 * Pure helpers for the campaign wizard's Meta pickers (src/app/api/ads/pickers) and picture upload. Client-safe.
 */

export type InterestOption = { id: string; name: string; audienceLow?: number | null; audienceHigh?: number | null; path?: string[] };
export type CityOption = { key: string; name: string; region?: string | null; countryCode?: string | null };
export type ChosenCity = { key: string; name: string; radiusKm: number };

/** Meta allows up to 25 interests and 25 cities in one ad set (src/lib/ads/targeting.ts). */
export const MAX_PICKED = 25;
/** Meta takes a radius of 17 to 80 km (10 to 50 miles) around a city; anything else fails when the ad set is created. */
export const MIN_CITY_RADIUS_KM = 17;
export const MAX_CITY_RADIUS_KM = 80;
/** Special ad categories need at least 15 miles around a place. 24 km is only 14.9 miles, so the wizard uses 25 km. */
export const SPECIAL_MIN_RADIUS_KM = 25;
/** Radius choices around a city, in kilometres, all inside Meta's range. */
export const CITY_RADII = [17, 25, 40, 80];
export const DEFAULT_RADIUS_KM = 17;

/** A radius Meta takes: inside 17 to 80 km and at least `minKm` (a special category's minimum). Fixes older drafts too. */
export function cityRadiusKm(radiusKm: number, minKm = MIN_CITY_RADIUS_KM): number {
  const r = Number.isFinite(radiusKm) ? radiusKm : DEFAULT_RADIUS_KM;
  return Math.min(MAX_CITY_RADIUS_KM, Math.max(r, minKm, MIN_CITY_RADIUS_KM));
}

/** Pictures Meta takes for ads, and the library's size limit for them. */
export const AD_PICTURE_TYPES = ["image/jpeg", "image/png"];
export const MAX_PICTURE_BYTES = 8 * 1024 * 1024;

/** The pickers route for one kind, with its parameters (empty ones are left out). */
export function pickerPath(kind: "posts" | "instagram_media" | "lead_forms" | "interests" | "cities", params: Record<string, string | null | undefined> = {}): string {
  const q = new URLSearchParams({ kind });
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  return `/api/ads/pickers?${q.toString()}`;
}

/** Adds an interest once, up to the limit. */
export function addInterest(list: { id: string; name: string }[], next: InterestOption): { id: string; name: string }[] {
  if (list.some((i) => i.id === next.id) || list.length >= MAX_PICKED) return list;
  return [...list, { id: next.id, name: next.name }];
}

/** Adds a city once, up to the limit, with the default radius. */
export function addCity(list: ChosenCity[], next: CityOption, radiusKm = DEFAULT_RADIUS_KM): ChosenCity[] {
  if (list.some((c) => c.key === next.key) || list.length >= MAX_PICKED) return list;
  return [...list, { key: next.key, name: cityLabel(next), radiusKm }];
}

/** "Pune, Maharashtra, IN". */
export function cityLabel(c: CityOption): string {
  return [c.name, c.region, c.countryCode].filter((x) => typeof x === "string" && x.trim()).join(", ");
}

/** "About 1.2M to 1.5M people" for an interest, or "" when Meta did not say. */
export function audienceText(low: number | null | undefined, high: number | null | undefined): string {
  const fmt = (n: number) => {
    try {
      return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
    } catch {
      return String(n);
    }
  };
  if (typeof low === "number" && typeof high === "number") return `About ${fmt(low)} to ${fmt(high)} people`;
  if (typeof high === "number") return `Up to ${fmt(high)} people`;
  return "";
}

/** Why a chosen file cannot be an ad picture, or null when it can be uploaded. */
export function pictureFileProblem(file: { type: string; size: number }): string | null {
  if (!AD_PICTURE_TYPES.includes(file.type)) return "Use a JPG or PNG picture. Meta does not take other formats for ads.";
  if (file.size > MAX_PICTURE_BYTES) return "That picture is too large. Pictures can be up to 8 MB.";
  if (file.size === 0) return "That file is empty. Choose another picture.";
  return null;
}

/** Library pictures that can be ad pictures: JPG and PNG only (videos and other files are left out). */
export function adPictures<T extends { key: string; kind?: string }>(media: T[]): T[] {
  return media.filter((m) => m.kind !== "video" && /\.(jpg|png)$/.test(m.key));
}

/** The wording under a saved creative in the wizard: whether its own picture can go in an ad. */
export function creativePictureText(a: { kind: string; hasImage?: boolean; imageProblem?: string | null }): string {
  if (a.kind !== "image") return "Text";
  if (a.hasImage) return "Picture";
  if (a.imageProblem === "format") return "Picture needs a JPG or PNG (add a picture below)";
  return "Picture preview (add a picture below)";
}

/** A post's line in the picker: its text, or a plain stand-in when it has none. */
export function postLabel(p: { text?: string; caption?: string; createdAt?: string | null }, locale?: string): string {
  const words = (p.text ?? p.caption ?? "").trim();
  const when = p.createdAt ? new Date(p.createdAt) : null;
  const date = when && !Number.isNaN(when.getTime()) ? when.toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" }) : "";
  const head = words ? (words.length > 90 ? `${words.slice(0, 87)}...` : words) : "Post without text";
  return date ? `${head} (${date})` : head;
}
