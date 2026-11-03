import { describe, expect, it } from "vitest";
import { FALLBACK_ZONES, LEGACY_ZONES, currentZoneName, timeZoneList } from "@/lib/timezones";

/** Time zone selects list one entry per zone under its current name (Settings > Spending limits, Settings > Routing). */
describe("time zone lists", () => {
  const browser = ["America/Godthab", "America/New_York", "Asia/Calcutta", "Asia/Katmandu", "Asia/Rangoon", "Asia/Saigon", "Europe/Kiev", "Europe/London", "UTC"];

  it("uses current names and lists India once, with the stored zone selected", () => {
    const list = timeZoneList("Asia/Kolkata", browser);
    expect(list).toEqual(["America/New_York", "America/Nuuk", "Asia/Ho_Chi_Minh", "Asia/Kathmandu", "Asia/Kolkata", "Asia/Yangon", "Europe/Kyiv", "Europe/London", "UTC"]);
    expect(list.filter((z) => z === "Asia/Kolkata" || z === "Asia/Calcutta")).toEqual(["Asia/Kolkata"]);
  });

  it("keeps a stored old name as the option in place of its current twin, never both", () => {
    const list = timeZoneList("Asia/Calcutta", browser);
    expect(list).toContain("Asia/Calcutta");
    expect(list).not.toContain("Asia/Kolkata");
    expect(list).toHaveLength(9);
  });

  it("puts a stored zone the list lacks first, and falls back to a short list", () => {
    expect(timeZoneList("Asia/Dubai", browser)[0]).toBe("Asia/Dubai");
    expect(timeZoneList(null, [])).toEqual([...FALLBACK_ZONES].sort());
    expect(timeZoneList(undefined, ["Asia/Calcutta", "Asia/Kolkata"])).toEqual(["Asia/Kolkata"]);
  });

  it("maps every old name to a zone Intl accepts, and leaves current names alone", () => {
    expect(currentZoneName("Asia/Calcutta")).toBe("Asia/Kolkata");
    expect(currentZoneName("Europe/London")).toBe("Europe/London");
    for (const [old, now] of Object.entries(LEGACY_ZONES)) {
      expect(() => new Intl.DateTimeFormat("en", { timeZone: now }), `${old} -> ${now}`).not.toThrow();
      expect(() => new Intl.DateTimeFormat("en", { timeZone: old }), old).not.toThrow();
    }
  });

  it("this runtime's own list has no old name left once mapped", () => {
    const list = timeZoneList();
    for (const old of Object.keys(LEGACY_ZONES)) expect(list).not.toContain(old);
    expect(new Set(list).size).toBe(list.length);
  });
});
