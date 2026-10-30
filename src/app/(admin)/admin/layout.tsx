import type { ReactNode } from "react";
import { UiProvider } from "@/components/ui/UiProvider";

/**
 * Deliberately no chrome and no metadata here: the header and navigation render inside AdminShell, after the access check, and each
 * page sets its own title with adminPageMetadata(). Layout metadata is still applied when a page answers 404, so a title here would
 * tell a stranger that an admin area exists.
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* The theme init script runs from the root layout, on every page. */}
      <UiProvider>{children}</UiProvider>
    </div>
  );
}
