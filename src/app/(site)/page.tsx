import Link from "next/link";
import {
  COMING_SOON,
  DEVELOPER_POINTS,
  EDDY_POINTS,
  FAQS,
  FEATURE_GROUPS,
  HIGHLIGHTS,
  SECTION,
  SECURITY_FACTS,
  SPEND_POINTS,
  START_TRIAL,
  STEPS,
} from "@/components/site/content";
import { Faq } from "@/components/site/faq";
import { HeroArt } from "@/components/site/hero-art";
import { Icon } from "@/components/site/icons";
import { EddySample, FeatureCards, PointList, SectionHead, SpendPreview, primaryCta, secondaryCta, textLink, wrap } from "@/components/site/landing";
import { JsonLd, Pub } from "@/components/site/pub";
import { HOME_DESCRIPTION, HOME_TITLE, faqLd, organizationLd, pageMetadata, softwareApplicationLd } from "@/components/site/seo";
import { COMPAT_BASE_PATH } from "@/lib/compat/spec";
import { siteUrl } from "@/lib/config";

export const metadata = pageMetadata({ title: HOME_TITLE, description: HOME_DESCRIPTION, path: "", absoluteTitle: true });

export default function Home() {
  const apiExample = `curl "${siteUrl()}${COMPAT_BASE_PATH}/contacts?page_size=5" \\\n  -H "Authorization: Bearer wak_your_token"`;
  return (
    <Pub>
      <JsonLd data={organizationLd()} />
      <JsonLd data={softwareApplicationLd()} />
      <JsonLd data={faqLd(FAQS)} />
      <main>
        <section className="pub-hero" aria-labelledby="hero-title">
          <div className={`${wrap} grid items-center gap-10 py-14 sm:py-20 lg:grid-cols-[1.1fr_0.9fr]`}>
            <div>
              <p className="pub-ink text-sm font-semibold uppercase tracking-widest">For every business that talks to customers on WhatsApp</p>
              <h1 id="hero-title" className="mt-4 text-4xl font-semibold leading-[1.1] tracking-tight sm:text-5xl lg:text-6xl">
                Run customer chats on WhatsApp as a team, and automate the rest
              </h1>
              <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted">
                One shared inbox for your WhatsApp Business number, broadcasts to people who opted in, chatbots, and an AI agent that answers from your own
                knowledge. Connect your number in about 5 minutes, and set limits on what messaging and AI can spend.
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <Link href={START_TRIAL.href} className={primaryCta}>
                  {START_TRIAL.label}
                  <Icon name="arrow" />
                </Link>
                <a href={`#${SECTION.howItWorks}`} className={secondaryCta}>
                  See how it works
                </a>
              </div>
              <p className="mt-4 text-sm text-muted">No card needed to start. WhatsApp message charges are billed by Meta, separately from your plan.</p>
            </div>
            <div className="mx-auto w-full max-w-md lg:max-w-none">
              <HeroArt />
            </div>
          </div>
        </section>

        <section aria-label="Highlights" className="border-y border-border bg-surface">
          <ul className={`${wrap} grid gap-4 py-6 text-sm font-medium sm:grid-cols-3`}>
            {HIGHLIGHTS.map((h) => (
              <li key={h.text} className="flex items-center gap-3">
                <span className="pub-ink shrink-0">
                  <Icon name={h.icon} />
                </span>
                {h.text}
              </li>
            ))}
          </ul>
        </section>

        {/* Anchor jumps clear the sticky header through html { scroll-padding-top } in globals.css; a scroll-margin on these sections would add to it. */}
        <section id={SECTION.howItWorks} className={`${wrap} py-16 sm:py-20`} aria-labelledby="how-title">
          <SectionHead id="how-title" eyebrow="How it works" title="Up and running in three steps" />
          <ol className="mt-10 grid gap-6 md:grid-cols-3">
            {STEPS.map((s, i) => (
              <li key={s.title} className="rounded-2xl border border-border bg-surface p-6">
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-accent text-sm font-bold text-white" aria-hidden="true">
                  {i + 1}
                </span>
                <h3 className="mt-4 text-lg font-semibold">
                  <span className="sr-only">Step {i + 1}: </span>
                  {s.title}
                </h3>
                <p className="mt-2 leading-relaxed text-muted">{s.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section id={SECTION.features} className="border-t border-border bg-surface" aria-labelledby="features-title">
          <div className={`${wrap} py-16 sm:py-20`}>
            <SectionHead
              id="features-title"
              eyebrow="Features"
              title="Everything your team needs on WhatsApp"
              intro="Grouped by what you want done. Everything in this section works today."
            />
            <div className="mt-12 space-y-14">
              {FEATURE_GROUPS.map((group) => (
                <div key={group.id}>
                  <h3 id={`group-${group.id}`} className="text-xl font-semibold tracking-tight">
                    {group.outcome}
                  </h3>
                  <p className="mt-1 text-muted">{group.summary}</p>
                  <FeatureCards items={group.features} />
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id={SECTION.eddy} className={`${wrap} py-16 sm:py-20`} aria-labelledby="eddy-title">
          <div className="grid gap-10 lg:grid-cols-2 lg:items-start">
            <div>
              <SectionHead
                id="eddy-title"
                eyebrow="Eddy, your in-app helper"
                status="new"
                title="Ask in English, Hindi or Hinglish. Eddy does the task."
                intro="Eddy is the AI helper inside Edwyz WA. Say what you need in your own words, and Eddy finds the answer or does the task for you, after you confirm anything that matters. The workspace owner switches Eddy on."
              />
              <PointList items={EDDY_POINTS} />
            </div>
            <EddySample />
          </div>
        </section>

        <section id={SECTION.spending} className="border-y border-border bg-surface" aria-labelledby="spending-title">
          <div className={`${wrap} grid gap-10 py-16 sm:py-20 lg:grid-cols-[1.2fr_0.8fr] lg:items-start`}>
            <div>
              <SectionHead
                id="spending-title"
                eyebrow="Spending controls"
                status="new"
                title="You stay in control of spending"
                intro="Choose the most Edwyz WA may spend for you on ads, WhatsApp messages and AI, each month and each day, and see what has been used so far."
              />
              <PointList items={SPEND_POINTS} />
            </div>
            <SpendPreview />
          </div>
        </section>

        <section id={SECTION.comingSoon} className={`${wrap} py-16 sm:py-20`} aria-labelledby="soon-title">
          <SectionHead
            id="soon-title"
            eyebrow="On the way"
            status="soon"
            title="Instagram and Facebook ads, and an Android app"
            intro="We are building these now. They are not available yet."
          />
          <FeatureCards items={COMING_SOON} tone="surface" status="soon" />
          <p className="mt-6 max-w-3xl text-sm leading-relaxed text-muted">
            When ads arrive, they will run inside the ad limit you set, and Meta will bill your own ad account directly. Edwyz WA never holds your ad money.
          </p>
        </section>

        <section id={SECTION.developers} className="border-y border-border bg-surface" aria-labelledby="dev-title">
          <div className={`${wrap} grid gap-10 py-16 sm:py-20 lg:grid-cols-2 lg:items-start`}>
            <div>
              <SectionHead
                id="dev-title"
                eyebrow="For developers"
                title="Connect your own systems and AI tools"
                intro="Everything the API can do follows the same WhatsApp rules as the app: replies inside the 24-hour window, approved templates outside it, and no marketing messages to people who opted out."
              />
              <PointList items={DEVELOPER_POINTS} />
            </div>
            <div className="min-w-0 rounded-2xl border border-border bg-background p-5">
              <p className="text-sm font-semibold">Your first request</p>
              <pre
                tabIndex={0}
                role="region"
                aria-label="Example API request"
                className="mt-3 overflow-x-auto rounded-xl border border-border bg-surface-2 p-4 text-xs leading-relaxed"
              >
                <code>{apiExample}</code>
              </pre>
              <p className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm">
                <Link href="/docs" className={textLink}>
                  Read the API docs
                </Link>
                <Link href="/docs/webhooks" className={textLink}>
                  Webhook events
                </Link>
              </p>
            </div>
          </div>
        </section>

        <section id={SECTION.security} className={`${wrap} py-16 sm:py-20`} aria-labelledby="security-title">
          <SectionHead
            id="security-title"
            eyebrow="Security and privacy"
            title="Plain facts about how we handle your data"
            intro="Your customers trust you with their phone numbers and messages. This is what we do to look after them."
          />
          <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {SECURITY_FACTS.map((f) => (
              <li key={f.title} className="flex gap-4 rounded-2xl border border-border bg-surface p-5">
                <span className="pub-ink mt-0.5 shrink-0">
                  <Icon name={f.icon} className="h-6 w-6" />
                </span>
                <div>
                  <h3 className="font-semibold">{f.title}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-muted">{f.body}</p>
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-6 text-sm text-muted">
            Read the full{" "}
            <Link href="/privacy" className="pub-ink underline underline-offset-2">
              privacy policy
            </Link>{" "}
            and{" "}
            <Link href="/terms" className="pub-ink underline underline-offset-2">
              terms
            </Link>
            .
          </p>
        </section>

        <section id={SECTION.faq} className="border-t border-border" aria-labelledby="faq-title">
          <div className={`${wrap} py-16 sm:py-20`}>
            <SectionHead id="faq-title" eyebrow="Questions" title="Answers before you ask" />
            <Faq items={FAQS} />
          </div>
        </section>

        <section className={`${wrap} pb-4`} aria-labelledby="cta-title">
          <div className="rounded-3xl border border-border bg-surface px-6 py-12 text-center sm:px-12">
            <h2 id="cta-title" className="text-3xl font-semibold tracking-tight sm:text-4xl">
              Start with your own WhatsApp number
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-lg text-muted">
              Create a workspace, connect your number in about 5 minutes, and answer your next customer from the shared inbox.
            </p>
            <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
              <Link href={START_TRIAL.href} className={primaryCta}>
                {START_TRIAL.label}
              </Link>
              <Link href="/pricing" className={secondaryCta}>
                See pricing
              </Link>
            </div>
          </div>
        </section>
      </main>
    </Pub>
  );
}
