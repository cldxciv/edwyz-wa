/**
 * Print rules for the invoice page. Browsers drop background colours when printing, so the dark theme would print light
 * text on white paper. This forces the light token values, hides the app chrome and removes the page padding.
 * Rendered only on the invoice page, so it never affects any other screen.
 */
export const INVOICE_PRINT_CSS = `
@media print {
  html:root:root:root {
    color-scheme: light;
    --background: #ffffff; --foreground: #0f172a; --muted: #475569; --surface: #f8fafc; --surface-2: #f1f5f9; --raised: #ffffff;
    --border: #cbd5e1; --border-strong: #64748b;
    --accent: #047857; --accent-strong: #065f46; --accent-soft: #ecfdf5; --accent-ink: #047857; --on-accent: #ffffff;
    --good: #059669; --good-soft: #ecfdf5; --good-fg: #065f46; --good-line: #a7f3d0;
    --warn: #d97706; --warn-soft: #fffbeb; --warn-fg: #78350f; --warn-line: #fde68a;
    --bad: #dc2626; --bad-soft: #fef2f2; --bad-fg: #991b1b; --bad-line: #fecaca;
    --info: #2563eb; --info-soft: #eff6ff; --info-fg: #1e40af; --info-line: #bfdbfe;
  }
  html, body { background: #fff !important; color: #000 !important; }
  aside, header, nav, [role="dialog"] { display: none !important; }
  .flex.min-h-screen { display: block !important; min-height: 0 !important; }
  #main-content { padding: 0 !important; }
  @page { margin: 14mm; }
}
`;

export function InvoicePrintStyles() {
  return <style dangerouslySetInnerHTML={{ __html: INVOICE_PRINT_CSS }} />;
}
