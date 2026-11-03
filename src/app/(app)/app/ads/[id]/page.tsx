import { CampaignDetail } from "@/components/ads/CampaignDetail";
import { metaScreenHref } from "@/lib/meta-connect/meta-screens";

export const metadata = { title: "Campaign" };

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  // The status timeline's Opens Meta buttons (docs/IG-PAGE-ADS-SPEC.md 3.9, 8.4): resolved here from the allowlist, never in the browser.
  const metaLinks = { appeal_ad: metaScreenHref("appeal_ad"), account_quality: metaScreenHref("account_quality") };
  return <CampaignDetail id={(await params).id} metaLinks={metaLinks} />;
}
