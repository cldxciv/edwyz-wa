"use client";

import { Button, cn, type ButtonProps } from "@/components/ui";
import { ButtonSpinner } from "@/components/ui/Button";

/**
 * Button that stays focusable while it works. `busy` shows a spinner and ignores clicks, `inactive` ignores clicks quietly
 * (nothing to save). Both use aria-disabled instead of disabled, so a keyboard user never loses their place.
 */
export function BusyButton({ busy, inactive, onClick, className, children, ...props }: Omit<ButtonProps, "loading"> & { busy?: boolean; inactive?: boolean }) {
  const blocked = !!busy || !!inactive;
  return (
    <Button
      {...props}
      aria-disabled={blocked || undefined}
      aria-busy={busy || undefined}
      className={cn("aria-disabled:cursor-not-allowed aria-disabled:opacity-50", className)}
      onClick={(e) => {
        if (blocked) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
    >
      {busy && <ButtonSpinner />}
      {children}
    </Button>
  );
}
