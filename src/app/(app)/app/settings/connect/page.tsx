import type { Metadata } from "next";
import { ConnectGuide } from "@/components/connect/ConnectGuide";

export const metadata: Metadata = { title: "Connect WhatsApp", robots: { index: false, follow: false } };

export default function ConnectPage() {
  return <ConnectGuide />;
}
