import { VerifyEmailFlow } from "@/components/site/auth-flows";
import { pageMetadata } from "@/components/site/seo";

export const metadata = pageMetadata({
  title: "Confirm your email",
  description: "Confirm your Edwyz WA email address.",
  path: "/verify-email",
  noindex: true,
});

export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token = "" } = await searchParams;
  return <VerifyEmailFlow token={token} />;
}
