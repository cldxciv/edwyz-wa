"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "./cn";
import { EmptyState, Skeleton } from "./feedback";
import { ariaSort, nextSort, sortRows, type SortState, type SortValue } from "./table-sort";

export type Column<T> = {
  key: string;
  /** Column heading. Also the label shown next to each value in the phone card layout. */
  header: string;
  /** Cell content. Defaults to the accessor value as text. */
  cell?: (row: T) => ReactNode;
  /** Value used for sorting and as the default cell content. Required for sortable columns. */
  accessor?: (row: T) => SortValue;
  sortable?: boolean;
  align?: "left" | "right" | "center";
  /** The row's title in the phone card layout: shown first, bold, without a label. Use on one column. */
  primary?: boolean;
  /** Hide the heading visually (for an actions column). The heading is still read by screen readers. */
  srOnlyHeader?: boolean;
  className?: string;
};

export type DataTableProps<T> = {
  columns: Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  /** Accessible table name, for example "Contacts". Not shown on screen. */
  caption: string;
  loading?: boolean;
  skeletonRows?: number;
  /** Shown when there are no rows. Use an EmptyState. */
  empty?: ReactNode;
  /** Controlled sort. Pass it with onSortChange when the server sorts; rows are then rendered in the order given. */
  sort?: SortState;
  onSortChange?: (sort: SortState) => void;
  defaultSort?: SortState;
  /** Keep the header visible while the body scrolls (the table scrolls inside maxHeight). */
  stickyHeader?: boolean;
  maxHeight?: string;
  onRowClick?: (row: T) => void;
  /** Under 640 px each row becomes a card. Set false to keep a scrolling table. */
  responsive?: boolean;
  footer?: ReactNode;
  className?: string;
};

const ALIGN = { left: "text-left", right: "text-right", center: "text-center" } as const;
const CARD_ALIGN = { left: "sm:text-left", right: "sm:text-right", center: "sm:text-center" } as const;

const cellText = <T,>(col: Column<T>, row: T): ReactNode => {
  if (col.cell) return col.cell(row);
  const v = col.accessor?.(row);
  if (v === null || v === undefined || v === "") return <span className="text-muted">-</span>;
  return v instanceof Date ? v.toLocaleString() : String(v);
};

function SortIcon({ dir }: { dir: "ascending" | "descending" | "none" }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className={cn("shrink-0", dir === "none" ? "opacity-40" : "text-foreground")}>
      <path d="M6 1.5 9 5H3z" fill="currentColor" opacity={dir === "descending" ? 0.25 : 1} />
      <path d="M6 10.5 3 7h6z" fill="currentColor" opacity={dir === "ascending" ? 0.25 : 1} />
    </svg>
  );
}

/**
 * Accessible data table: sortable headers (aria-sort), optional sticky header, skeleton loading rows, empty state,
 * and a card layout under 640 px. Works uncontrolled (sorts the rows you pass) or controlled for server-side sorting.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  caption,
  loading,
  skeletonRows = 5,
  empty,
  sort: controlled,
  onSortChange,
  defaultSort = null,
  stickyHeader,
  maxHeight = "70vh",
  onRowClick,
  responsive = true,
  footer,
  className,
}: DataTableProps<T>) {
  const sortId = useId();
  const [inner, setInner] = useState<SortState>(defaultSort);
  const isControlled = controlled !== undefined;
  const sort = isControlled ? controlled : inner;

  // A scrolling region must be reachable by keyboard (WCAG 2.1.1), so it becomes a focusable region only while it overflows.
  const scroller = useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = useState(false);
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setScrolls(el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, []);

  const visible = useMemo(() => {
    if (isControlled || !sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    return col?.accessor ? sortRows(rows, col.accessor, sort.dir) : rows;
  }, [rows, columns, sort, isControlled]);

  function changeSort(next: SortState) {
    if (!isControlled) setInner(next);
    onSortChange?.(next);
  }

  const sortable = columns.filter((c) => c.sortable && (c.accessor || isControlled));
  const colCount = columns.length;

  function rowKeyDown(e: KeyboardEvent<HTMLTableRowElement>, row: T) {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onRowClick?.(row);
    }
  }

  const showEmpty = !loading && visible.length === 0;

  return (
    <div className={className}>
      {sortable.length > 0 && responsive && (
        <div className="mb-3 flex items-center gap-2 sm:hidden">
          <label htmlFor={sortId} className="text-xs font-medium text-muted">
            Sort by
          </label>
          <select
            id={sortId}
            className="min-h-9 flex-1 rounded-control border border-border-strong bg-raised px-2 text-sm"
            value={sort ? `${sort.key}:${sort.dir}` : ""}
            onChange={(e) => {
              const [key, dir] = e.target.value.split(":");
              changeSort(key ? { key, dir: dir === "desc" ? "desc" : "asc" } : null);
            }}
          >
            <option value="">Default order</option>
            {sortable.flatMap((c) => [
              <option key={`${c.key}:asc`} value={`${c.key}:asc`}>{`${c.header} (A to Z)`}</option>,
              <option key={`${c.key}:desc`} value={`${c.key}:desc`}>{`${c.header} (Z to A)`}</option>,
            ])}
          </select>
        </div>
      )}
      <div
        ref={scroller}
        className={cn("overflow-x-auto rounded-card border border-border bg-raised", responsive && "max-sm:overflow-visible max-sm:rounded-none max-sm:border-0 max-sm:bg-transparent", stickyHeader && "overflow-y-auto", scrolls && "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent")}
        style={stickyHeader ? { maxHeight } : undefined}
        aria-busy={loading || undefined}
        {...(scrolls ? { role: "region", tabIndex: 0, "aria-label": caption } : {})}
      >
        <table role="table" className={cn("ui-dt", stickyHeader && "ui-dt-sticky", responsive && "ui-dt-cards")}>
          <caption className="sr-only">{caption}</caption>
          <thead role="rowgroup">
            <tr role="row">
              {columns.map((c) => {
                const canSort = c.sortable && (c.accessor || isControlled);
                const dir = ariaSort(sort, c.key);
                return (
                  <th key={c.key} scope="col" role="columnheader" aria-sort={canSort ? dir : undefined} className={cn(ALIGN[c.align ?? "left"], c.className)}>
                    {canSort ? (
                      <button
                        type="button"
                        onClick={() => changeSort(nextSort(sort, c.key))}
                        className={cn("-mx-1 inline-flex items-center gap-1.5 rounded px-1 uppercase hover:text-foreground", c.align === "right" && "flex-row-reverse")}
                      >
                        {c.header}
                        <SortIcon dir={dir} />
                      </button>
                    ) : c.srOnlyHeader ? (
                      <span className="sr-only">{c.header}</span>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody role="rowgroup">
            {loading
              ? Array.from({ length: skeletonRows }, (_, i) => (
                  <tr key={`s${i}`} role="row" aria-hidden>
                    {columns.map((c) => (
                      <td key={c.key} role="cell" data-label={c.primary || c.srOnlyHeader ? "" : c.header} data-primary={c.primary || undefined}>
                        <Skeleton className="h-4 w-full max-w-40" />
                      </td>
                    ))}
                  </tr>
                ))
              : visible.map((row) => (
                  <tr
                    key={rowKey(row)}
                    role="row"
                    className={cn(onRowClick && "ui-dt-row-action")}
                    tabIndex={onRowClick ? 0 : undefined}
                    onClick={onRowClick ? (e) => !(e.target as HTMLElement).closest("a, button, input, select, textarea, label") && onRowClick(row) : undefined}
                    onKeyDown={onRowClick ? (e) => rowKeyDown(e, row) : undefined}
                  >
                    {columns.map((c) => (
                      <td key={c.key} role="cell" data-label={c.primary || c.srOnlyHeader ? "" : c.header} data-primary={c.primary || undefined} className={cn((responsive ? CARD_ALIGN : ALIGN)[c.align ?? "left"], c.className)}>
                        {cellText(c, row)}
                      </td>
                    ))}
                  </tr>
                ))}
            {showEmpty && (
              <tr role="row">
                <td role="cell" data-label="" colSpan={colCount} className="block! p-0! sm:table-cell!">
                  {empty ?? <EmptyState title="Nothing here yet" />}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {loading && (
        <p role="status" className="sr-only">
          Loading {caption}
        </p>
      )}
      {footer && <div className="mt-3">{footer}</div>}
    </div>
  );
}
