"use client";

import { useEffect, useRef } from "react";
import { Textarea } from "@/components/ui";

const BLANK = "Please tell us what to change.";

/**
 * The comment box for "Request changes". The HTML required check lets a box that holds only spaces through, so this
 * keeps the browser's own message up until there is real text. It is a convenience: the server checks again.
 * 16 px text stops iPhones from zooming the page when the box gets focus.
 */
export function CommentField({ id, name, maxLength }: { id: string; name: string; maxLength: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const sync = (el: HTMLTextAreaElement) => el.setCustomValidity(el.value.trim() ? "" : BLANK);
  useEffect(() => {
    if (ref.current) sync(ref.current);
  }, []);
  return <Textarea ref={ref} id={id} name={name} rows={4} required maxLength={maxLength} className="text-base!" onChange={(e) => sync(e.currentTarget)} />;
}
