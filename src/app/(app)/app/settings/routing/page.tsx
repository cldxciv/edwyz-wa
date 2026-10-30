import type { Metadata } from "next";
import { RoutingView } from "@/components/routing/RoutingView";

export const metadata: Metadata = { title: "Chat routing" };

export default function RoutingPage() {
  return <RoutingView />;
}
