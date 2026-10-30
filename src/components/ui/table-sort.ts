export type SortDir = "asc" | "desc";
export type SortState = { key: string; dir: SortDir } | null;
export type SortValue = string | number | boolean | Date | null | undefined;

/** Click cycle on one column: ascending, descending, then back to the original order. A different column starts ascending. */
export function nextSort(current: SortState, key: string): SortState {
  if (!current || current.key !== key) return { key, dir: "asc" };
  return current.dir === "asc" ? { key, dir: "desc" } : null;
}

export function ariaSort(sort: SortState, key: string): "ascending" | "descending" | "none" {
  if (!sort || sort.key !== key) return "none";
  return sort.dir === "asc" ? "ascending" : "descending";
}

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export const isEmptyValue = (v: SortValue) =>
  v === null || v === undefined || v === "" || (typeof v === "number" && Number.isNaN(v)) || (v instanceof Date && Number.isNaN(v.getTime()));

function rank(v: SortValue): string | number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "boolean") return v ? 1 : 0;
  return v as string | number;
}

/** Ascending comparison of two non-empty values. Numbers numerically, dates by time, text with natural number order. */
export function compareValues(a: SortValue, b: SortValue): number {
  const x = rank(a);
  const y = rank(b);
  if (typeof x === "number" && typeof y === "number") return x - y;
  return collator.compare(String(x), String(y));
}

/** Stable sort. Empty values (null, undefined, NaN, invalid dates, empty strings) sit at the end in both directions. */
export function sortRows<T>(rows: readonly T[], accessor: (row: T) => SortValue, dir: SortDir): T[] {
  const sign = dir === "asc" ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index, value: accessor(row) }))
    .sort((p, q) => {
      const pe = isEmptyValue(p.value);
      const qe = isEmptyValue(q.value);
      if (pe || qe) return pe && qe ? p.index - q.index : pe ? 1 : -1;
      return sign * compareValues(p.value, q.value) || p.index - q.index;
    })
    .map((x) => x.row);
}
