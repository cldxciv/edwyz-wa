import { CampaignDetail } from "@/components/ads/CampaignDetail";

export const metadata = { title: "Campaign" };

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  return <CampaignDetail id={(await params).id} />;
}
