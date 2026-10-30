"use client";

import { useEffect, useRef, useState } from "react";
import { Button, type ButtonProps } from "./Button";
import { cn } from "./cn";

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      area.remove();
    }
  }
}

type CopyButtonProps = Omit<ButtonProps, "onClick" | "children" | "value"> & {
  /** The text to copy. Never log it; it may be a secret such as an API key. */
  value: string;
  label?: string;
  copiedLabel?: string;
  onCopied?: () => void;
};

/** Copies text and confirms with a label change that screen readers announce. Falls back to execCommand on insecure origins. */
export function CopyButton({ value, label = "Copy", copiedLabel = "Copied", onCopied, variant = "secondary", size = "sm", className, ...props }: CopyButtonProps) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    const ok = await writeClipboard(value);
    setState(ok ? "copied" : "failed");
    if (ok) onCopied?.();
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2000);
  }

  return (
    <>
      <Button type="button" variant={variant} size={size} className={cn(className)} onClick={copy} {...props}>
        {state === "copied" ? copiedLabel : state === "failed" ? "Copy failed" : label}
      </Button>
      <span role="status" className="sr-only">
        {state === "copied" ? copiedLabel : state === "failed" ? "Copy failed. Select the text and copy it manually." : ""}
      </span>
    </>
  );
}
