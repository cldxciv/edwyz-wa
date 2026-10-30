import type { Metadata } from "next";
import { SpendingSettings } from "@/components/spend/SpendingSettings";

/*
 * Settings > Spending limits (docs/SPEND-CONTROLS-SPEC.md 8.1): open to every member. The owner edits, admins lower and
 * stop, team members read. The header, subtitle and role notes are part of <SpendingSettings/>.
 */

export const metadata: Metadata = { title: "Spending limits", robots: { index: false, follow: false } };

export default function SpendingPage() {
  return <SpendingSettings />;
}
