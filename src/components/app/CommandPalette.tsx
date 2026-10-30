"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Role } from "@/generated/prisma/client";
import { cn } from "@/components/ui";
import { askEddyLabel, buildCommands, type Command } from "./commands";
import { fuzzyRank, highlightRuns } from "./fuzzy";
import { Icon } from "./Icon";
import { useShell } from "./shell-context";
import { toggleTheme } from "./theme";
import { useFocusTrap } from "./useFocusTrap";

function Highlight({ text, indices }: { text: string; indices: number[] }) {
  return (
    <>
      {highlightRuns(text, indices).map((run, i) =>
        run.match ? (
          <mark key={i} className="bg-transparent font-semibold text-accent">
            {run.text}
          </mark>
        ) : (
          <span key={i}>{run.text}</span>
        ),
      )}
    </>
  );
}

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="ml-auto flex shrink-0 gap-1">
      {keys.map((k, i) => (
        <kbd key={i} className="rounded border border-border bg-surface px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted">
          {k}
        </kbd>
      ))}
    </span>
  );
}

type Row = { command: Command; indices: number[] };

export function CommandPalette({ role, open, onClose }: { role: Role; open: boolean; onClose: () => void }) {
  const router = useRouter();
  const { openShortcuts, signOut, openEddy } = useShell();
  const dialog = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const listId = useId();
  const commands = useMemo(() => buildCommands(role), [role]);

  useFocusTrap(dialog, open, onClose);

  const rows: Row[] = useMemo(() => {
    const ranked = fuzzyRank(commands, query, (c) => c.label, (c) => [...c.keywords, c.hint ?? "", c.group]);
    return query.trim() === "" ? ranked.map((r) => ({ command: r.item, indices: [] })) : ranked.map((r) => ({ command: r.item, indices: r.indices }));
  }, [commands, query]);

  const safeCursor = Math.min(cursor, Math.max(rows.length - 1, 0));
  // With no match, the only row is Ask Eddy: "query" (docs/EDDY-SPEC.md 6.1), which opens Eddy and sends the query.
  const askRow = rows.length === 0 && query.trim() !== "";
  const askId = `${listId}-ask`;

  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [safeCursor, rows]);

  if (!open) return null;

  function run(command: Command) {
    onClose();
    if (command.href) router.push(command.href);
    else if (command.run === "toggle-theme") toggleTheme();
    else if (command.run === "sign-out") void signOut();
    else if (command.run === "open-shortcuts") window.setTimeout(openShortcuts, 0);
    else if (command.run === "ask-eddy") window.setTimeout(() => openEddy(), 0);
  }

  function askEddy() {
    const q = query.trim();
    onClose();
    window.setTimeout(() => openEddy(q ? { query: q } : undefined), 0);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor(rows.length === 0 ? 0 : (safeCursor + 1) % rows.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor(rows.length === 0 ? 0 : (safeCursor - 1 + rows.length) % rows.length);
    } else if (e.key === "Home") {
      e.preventDefault();
      setCursor(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setCursor(Math.max(rows.length - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[safeCursor];
      if (row) run(row.command);
      else if (askRow) askEddy();
    }
  }

  let lastGroup = "";
  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/50 px-3 pt-[max(1rem,env(safe-area-inset-top))] sm:pt-[12vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        tabIndex={-1}
        className="flex max-h-[min(32rem,calc(100dvh-2rem))] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
      >
        <div className="flex items-center gap-3 border-b border-border px-4">
          <Icon name="search" className="h-5 w-5 text-muted" />
          <input
            data-autofocus
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={rows[safeCursor] ? `${listId}-${safeCursor}` : askRow ? askId : undefined}
            aria-label="Search pages and actions"
            placeholder="Search pages and actions"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={onKeyDown}
            className="h-14 w-full bg-transparent text-base outline-none placeholder:text-muted"
          />
        </div>

        <ul ref={list} id={listId} role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto p-2">
          {rows.length === 0 && (
            <li role="presentation" className="px-3 pb-2 pt-6 text-center text-sm text-muted">
              Nothing matches &quot;{query}&quot;. Try a shorter word{askRow ? ", or ask Eddy." : "."}
            </li>
          )}
          {askRow && (
            <li role="presentation">
              <div
                id={askId}
                role="option"
                aria-selected="true"
                onClick={askEddy}
                className="flex cursor-pointer items-center gap-3 rounded-lg bg-surface px-3 py-2.5 text-sm"
                data-palette-ask-eddy
              >
                <Icon name="sparkles" className="h-[18px] w-[18px] text-accent" />
                <span className="min-w-0 truncate">{askEddyLabel(query)}</span>
                <span aria-hidden="true" className="ml-auto shrink-0 text-[11px] text-muted">
                  Eddy
                </span>
              </div>
            </li>
          )}
          {rows.map(({ command, indices }, i) => {
            const showGroup = query.trim() === "" && command.group !== lastGroup;
            lastGroup = command.group;
            const selected = i === safeCursor;
            return (
              <li key={command.id} role="presentation">
                {showGroup && (
                  <p role="presentation" className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-muted first:pt-1">
                    {command.group}
                  </p>
                )}
                <div
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={selected}
                  onMouseMove={() => setCursor(i)}
                  onClick={() => run(command)}
                  className={cn("flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-sm", selected && "bg-surface")}
                >
                  <Icon name={command.icon} className={cn("h-[18px] w-[18px]", selected ? "text-accent" : "text-muted")} />
                  <span className="min-w-0">
                    <span className="block truncate">
                      <Highlight text={command.label} indices={indices} />
                    </span>
                    {command.hint && <span className="block truncate text-xs text-muted">{command.hint}</span>}
                  </span>
                  {command.shortcut ? <Keys keys={command.shortcut} /> : query.trim() !== "" && <span className="ml-auto shrink-0 text-[11px] text-muted">{command.group === "Pages" ? "Page" : "Action"}</span>}
                </div>
              </li>
            );
          })}
        </ul>

        <div className="hidden items-center gap-4 border-t border-border bg-surface px-4 py-2 text-xs text-muted sm:flex">
          <span><kbd className="font-sans font-semibold">Up</kbd> <kbd className="font-sans font-semibold">Down</kbd> to move</span>
          <span><kbd className="font-sans font-semibold">Enter</kbd> to open</span>
          <span><kbd className="font-sans font-semibold">Esc</kbd> to close</span>
          <span className="ml-auto"><kbd className="font-sans font-semibold">?</kbd> all shortcuts</span>
        </div>
      </div>
    </div>
  );
}
