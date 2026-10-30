import { AcceptInviteFlow } from "@/components/site/auth-flows";
import { pageMetadata } from "@/components/site/seo";

export const metadata = pageMetadata({
  title: "Join a workspace",
  description: "Accept your invitation to an Edwyz WA workspace.",
  path: "/accept-invite",
  noindex: true,
});

export default async function AcceptInvitePage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token = "" } = await searchParams;
  return <AcceptInviteFlow token={token} />;
}
