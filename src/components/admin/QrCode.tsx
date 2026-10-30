"use client";

import qrcode from "qrcode-generator";
import { useMemo } from "react";

/**
 * A QR code drawn in the browser as inline SVG. The text (an authenticator setup link that contains the secret)
 * never leaves the page: no image service is involved. Always dark on white so any authenticator app can scan it, in both themes.
 */
export function QrCode({ value, label, className }: { value: string; label: string; className?: string }) {
  const svg = useMemo(() => {
    try {
      const qr = qrcode(0, "M");
      qr.addData(value);
      qr.make();
      return qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
    } catch {
      return null;
    }
  }, [value]);
  if (!svg) return null;
  return (
    <div role="img" aria-label={label} className={className ?? "h-44 w-44 shrink-0 rounded-control border border-border bg-white p-1 [&>svg]:h-full [&>svg]:w-full"} dangerouslySetInnerHTML={{ __html: svg }} />
  );
}
