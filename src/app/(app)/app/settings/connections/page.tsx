import type { Metadata } from "next";
import { ConnectionsPanel } from "@/components/meta-connect/ConnectionsPanel";

export const metadata: Metadata = { title: "Connections", robots: { index: false, follow: false } };

export default function ConnectionsPage() {
  return <ConnectionsPanel />;
}
