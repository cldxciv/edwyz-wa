import type { Metadata } from "next";
import { InboxApp } from "@/components/inbox/InboxApp";

export const metadata: Metadata = { title: "Inbox" };

export default function InboxPage() {
  return <InboxApp />;
}
