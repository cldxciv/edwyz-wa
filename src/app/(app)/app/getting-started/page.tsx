import type { Metadata } from "next";
import { GettingStarted } from "@/components/setup/GettingStarted";

export const metadata: Metadata = { title: "Getting started", robots: { index: false, follow: false } };

export default function GettingStartedPage() {
  return <GettingStarted />;
}
