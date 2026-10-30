"use client";

import { Button } from "@/components/ui";

export function PrintButton() {
  return (
    <Button variant="secondary" onClick={() => window.print()} className="print:hidden">
      Print or save as PDF
    </Button>
  );
}
