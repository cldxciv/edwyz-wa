import type { Metadata } from "next";
import { verifyState } from "@/lib/oauth-state";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Connecting WhatsApp", robots: { index: false, follow: false } };

type Params = { code?: string; state?: string; error?: string; error_description?: string };

/** Landing page after Meta signup screens. Onboarding runs from the Connect WhatsApp button (JS SDK flow); nothing is exchanged or stored here and no tenant is ever chosen from the URL. */
export default async function OAuthCallback({ searchParams }: { searchParams: Promise<Params> }) {
  const { code, state, error } = await searchParams;

  let heading = "We could not connect your WhatsApp number";
  let body = "The link is not valid or has expired. Please start the connection again from your workspace.";

  if (error) {
    heading = "The connection was cancelled";
    body = "No changes were made to your WhatsApp account. You can start again whenever you are ready.";
  } else if (code && verifyState(state, process.env.STATE_SECRET)) {
    heading = "Continue in your workspace";
    body = "Please sign in and use Connect WhatsApp in your workspace to finish connecting your number. Nothing has been stored from this page.";
  }

  return (
    <main className="mx-auto max-w-xl px-6 pt-24 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">{heading}</h1>
      <p className="mt-4 leading-relaxed text-muted">{body}</p>
      <a href="/" className="mt-8 inline-block rounded-full border border-border px-6 py-3 text-sm font-semibold hover:bg-surface">
        Back to Edwyz WA
      </a>
    </main>
  );
}
