import Link from "next/link";
import { Logo } from "@/components/shell";
import { Icon } from "@/components/site/icons";
import { Pub } from "@/components/site/pub";
import { COMPANY } from "@/lib/config";

// Rendered per request: canonicals and the share tags carry siteUrl(), and the pages read the session cookie and the
// email setting. A build-time render would freeze a developer's SITE_URL (see src/app/(site)/layout.tsx).
export const dynamic = "force-dynamic";

const BENEFITS = [
  "Reply to every customer from one shared WhatsApp inbox",
  "Send broadcasts to people who opted in",
  "Automate answers with chatbots and AI replies",
  "Keep ads, messaging and AI spend under limits you set",
  "Get help from Eddy in English, Hindi or Hinglish",
];

export default function AuthLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <Pub>
      <div className="grid min-h-screen lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <main className="order-1 flex flex-col px-4 py-6 sm:px-10 lg:order-2 lg:justify-center lg:px-16">
          <div className="lg:hidden">
            <Logo />
          </div>
          <div className="mx-auto mt-10 w-full max-w-md lg:mt-0">
            {children}
            <p className="mt-8 flex items-start gap-2 border-t border-border pt-5 text-xs leading-relaxed text-muted">
              <span className="pub-ink mt-0.5 shrink-0">
                <Icon name="lock" className="h-4 w-4" />
              </span>
              <span>Built on the official WhatsApp Business Platform. Your contacts and messages stay yours, and we never sell your data.</span>
            </p>
          </div>
        </main>
        <aside aria-label="Why Edwyz WA" className="order-2 bg-[#064e3b] px-4 py-12 text-white sm:px-10 lg:order-1 lg:flex lg:flex-col lg:justify-between lg:px-14 lg:py-14">
          <Link href="/" aria-label={`${COMPANY.product} home`} className="hidden text-xl font-semibold tracking-tight text-white lg:inline-block">
            Edwyz WA
          </Link>
          <div className="max-w-md">
            <h2 className="text-2xl font-semibold leading-snug tracking-tight sm:text-3xl">Your ads, your WhatsApp and your team in one place</h2>
            <ul className="mt-8 space-y-4">
              {BENEFITS.map((b) => (
                <li key={b} className="flex items-start gap-3 text-base leading-relaxed text-[#d1fae5]">
                  <span className="mt-0.5 shrink-0 text-[#6ee7b7]">
                    <Icon name="check" className="h-5 w-5" />
                  </span>
                  {b}
                </li>
              ))}
            </ul>
          </div>
          <p className="mt-10 text-sm text-[#a7f3d0]">Free trial. No card needed to start.</p>
        </aside>
      </div>
    </Pub>
  );
}
