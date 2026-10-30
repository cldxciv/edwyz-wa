import { BroadcastDetail } from "@/components/broadcasts/BroadcastDetail";

export const metadata = { title: "Broadcast" };

export default async function BroadcastPage({ params }: { params: Promise<{ id: string }> }) {
  return <BroadcastDetail id={(await params).id} />;
}
