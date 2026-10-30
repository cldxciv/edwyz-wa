"use client";

import { useEffect, useId, useRef, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { trapTarget } from "./a11y";
import { cn } from "./cn";

const FOCUSABLE =
  'a[href], summary, button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const SIZES = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-4xl" } as const;

const stack: symbol[] = [];
let scrollLocks = 0;
let previousOverflow = "";

function lockScroll() {
  if (scrollLocks++ === 0) {
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
}

function unlockScroll() {
  if (--scrollLocks === 0) document.body.style.overflow = previousOverflow;
}

const noopSubscribe = () => () => {};

export type DialogProps = {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  /** Same as size="lg". Kept for existing callers. */
  wide?: boolean;
  size?: keyof typeof SIZES;
  /** Buttons row. Put the primary action last. */
  footer?: ReactNode;
  /** Use "alertdialog" for destructive confirmations. */
  role?: "dialog" | "alertdialog";
  /** Element to focus on open. Defaults to [data-autofocus], then the first focusable element. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** When false, Escape and backdrop clicks do nothing (use while a request is running). */
  dismissible?: boolean;
  /** Optional mark before the title (for example Eddy's avatar). Decorative: give it aria-hidden. */
  icon?: ReactNode;
  /** Optional controls between the title and the close button (for example a status pill and a menu button). */
  headerAside?: ReactNode;
  /** Extra classes for the close button, for example a 44 px touch target on a phone sheet. */
  closeClassName?: string;
  /** The close button's accessible name, in the page's language (default "Close dialog"). */
  closeLabel?: string;
};

/** Modal dialog: portal, focus trap, Escape to close, focus restore, scroll lock, bottom sheet on small screens. */
export function Dialog({ title, description, onClose, children, wide, size, footer, role = "dialog", initialFocus, dismissible = true, icon, headerAside, closeClassName, closeLabel = "Close dialog" }: DialogProps) {
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const latest = useRef({ onClose, dismissible });
  latest.current = { onClose, dismissible };

  useEffect(() => {
    if (!mounted) return;
    const node = ref.current;
    if (!node) return;
    const me = Symbol("dialog");
    const previous = document.activeElement as HTMLElement | null;
    stack.push(me);
    lockScroll();
    const target = initialFocus?.current ?? node.querySelector<HTMLElement>("[data-autofocus]") ?? node.querySelector<HTMLElement>(FOCUSABLE) ?? node;
    target.focus();

    function onKey(e: KeyboardEvent) {
      if (stack[stack.length - 1] !== me || !node) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        if (latest.current.dismissible) latest.current.onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const index = items.indexOf(document.activeElement as HTMLElement);
      const go = trapTarget(items.length, index, e.shiftKey);
      if (go === null) return;
      e.preventDefault();
      (go === -1 ? node : items[go]).focus();
    }
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      stack.splice(stack.indexOf(me), 1);
      unlockScroll();
      // Opened from a deep link (or the opener was removed): nothing real to return to, so land on the page's main region instead of <body>.
      // Only when focus is truly lost: a stacked dialog (a "discard changes?" question) can unmount after the dialog under it, and its stale opener must not steal focus back from the real one.
      if (previous && previous !== document.body && previous.isConnected) previous.focus?.();
      else if (!document.activeElement || document.activeElement === document.body) document.querySelector<HTMLElement>("main[tabindex]")?.focus();
    };
  }, [mounted, initialFocus]);

  if (!mounted) return null;

  const heading = (
    <div>
      <h2 id={titleId} className="text-lg font-semibold tracking-tight">
        {title}
      </h2>
      {description && (
        <p id={descId} className="mt-1 text-sm text-muted">
          {description}
        </p>
      )}
    </div>
  );

  return createPortal(
    <div
      className="ui-fade-in fixed inset-0 z-(--z-modal) flex items-end justify-center overflow-y-auto bg-overlay p-0 sm:items-center sm:p-4"
      onMouseDown={(e) => e.target === e.currentTarget && latest.current.dismissible && latest.current.onClose()}
    >
      <div
        ref={ref}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cn(
          "ui-pop-in flex max-h-[92dvh] w-full flex-col rounded-t-card border border-border bg-raised text-foreground shadow-modal outline-none sm:rounded-card",
          SIZES[size ?? (wide ? "lg" : "md")],
        )}
      >
        <div className="flex items-start justify-between gap-4 px-5 pt-5 sm:px-6 sm:pt-6">
          {icon ? (
            <div className="flex min-w-0 items-center gap-2">
              {icon}
              {heading}
            </div>
          ) : (
            heading
          )}
          {headerAside && <div className="ml-auto flex min-w-0 items-center gap-1">{headerAside}</div>}
          <button type="button" onClick={onClose} disabled={!dismissible} aria-label={closeLabel} className={cn("-mr-1.5 -mt-1 rounded-full p-2 text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-50", closeClassName)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-4 sm:px-6">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
