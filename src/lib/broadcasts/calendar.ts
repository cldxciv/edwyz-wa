export type CalendarItem = { id: string; name: string; status: string; at: string };

export type DayCell = { date: Date; key: string; inMonth: boolean };

export const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Weeks (Sunday first) covering the month, in local time. */
export function monthGrid(year: number, month: number): DayCell[][] {
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - first.getDay());
  const weeks: DayCell[][] = [];
  for (let w = 0; w < 6; w++) {
    const row: DayCell[] = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + d);
      row.push({ date, key: dayKey(date), inMonth: date.getMonth() === month });
    }
    if (w >= 4 && !row.some((c) => c.inMonth)) break;
    weeks.push(row);
  }
  return weeks;
}

export function gridRange(weeks: DayCell[][]): { from: Date; to: Date } {
  const first = weeks[0][0].date;
  const last = weeks[weeks.length - 1][6].date;
  return { from: first, to: new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1) };
}

export function bucketByDay(items: CalendarItem[]): Map<string, CalendarItem[]> {
  const map = new Map<string, CalendarItem[]>();
  for (const item of [...items].sort((a, b) => a.at.localeCompare(b.at))) {
    const key = dayKey(new Date(item.at));
    map.set(key, [...(map.get(key) ?? []), item]);
  }
  return map;
}

export type StatusColour = "scheduled" | "sent" | "sending" | "attention" | "inactive";

export function statusColour(status: string): StatusColour {
  switch (status) {
    case "scheduled":
    case "draft":
      return "scheduled";
    case "completed":
      return "sent";
    case "sending":
      return "sending";
    case "paused":
    case "failed":
      return "attention";
    default:
      return "inactive";
  }
}

export const isPastDay = (date: Date, now = new Date()) => dayKey(date) < dayKey(now);
