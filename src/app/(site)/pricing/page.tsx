import Link from "next/link";
import { START_TRIAL } from "@/components/site/content";
import { type Billing, NO_PRICES_TEXT, aiFairUseNote, chooseBilling, comparisonRows, formatPrice, offersFor, planLimitLines, plansFor, publicPlans, taxNote } from "@/components/site/pricing";
import { JsonLd, Pub } from "@/components/site/pub";
import { organizationLd, pageMetadata, softwareApplicationLd } from "@/components/site/seo";
import { defaultMonthlyCreditCeiling } from "@/lib/ai-agent/credits";
import { listActivePlans } from "@/lib/billing/service";
import { COMPANY } from "@/lib/config";
import { getSettings } from "@/lib/platform-settings";

export const dynamic = "force-dynamic";
export const metadata = pageMetadata({
  title: "Pricing",
  description: "Edwyz WA plans, limits and free trial. Compare team seats, contacts, broadcasts and AI credits.",
  path: "/pricing",
});

const primary =
  "inline-flex items-center justify-center rounded-full bg-accent px-6 py-3 text-sm font-semibold text-white hover:bg-accent-strong";

function BillingToggle({ current }: { current: Billing }) {
  const item = (value: Billing, label: string, href: string) => (
    <Link
      href={href}
      scroll={false}
      aria-current={current === value ? "true" : undefined}
      className={`rounded-full px-5 py-2 text-sm font-semibold ${current === value ? "bg-accent text-white" : "hover:bg-surface"}`}
    >
      {label}
    </Link>
  );
  return (
    <nav aria-label="Billing period" className="mt-8 inline-flex gap-1 rounded-full border border-border bg-background p-1">
      {item("monthly", "Monthly", "/pricing")}
      {item("yearly", "Yearly", "/pricing?billing=yearly")}
    </nav>
  );
}

export default async function PricingPage({ searchParams }: { searchParams: Promise<{ billing?: string }> }) {
  const [{ billing: requested }, allPlans, settings] = await Promise.all([searchParams, listActivePlans().then(publicPlans).catch(() => []), getSettings()]);
  const billing = chooseBilling(allPlans, requested);
  const plans = plansFor(allPlans, billing);
  const tax = taxNote(settings, plans);
  const limitOpts = { aiDefaultCredits: defaultMonthlyCreditCeiling() };
  const rows = comparisonRows(plans, limitOpts);
  const aiNote = aiFairUseNote(plans, limitOpts);

  return (
    <Pub>
      <JsonLd data={organizationLd()} />
      <JsonLd data={softwareApplicationLd(offersFor(plans))} />
      <main className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">Pricing</h1>
        <p className="mt-4 max-w-2xl text-lg leading-relaxed text-muted">
          Start with a {settings.trialDays}-day free trial. You do not need a card. WhatsApp message charges are paid to Meta directly and are not part of your plan.
        </p>

        {plans.length === 0 ? (
          <div className="mt-10 rounded-2xl border border-dashed p-10 text-center" style={{ borderColor: "var(--field-border)" }}>
            <h2 className="text-xl font-semibold">{NO_PRICES_TEXT}</h2>
            <p className="mt-2 text-muted">You can still start a free trial and try everything. Write to us if you would like a plan quote.</p>
            <div className="mt-6 flex flex-col items-center justify-center gap-4 sm:flex-row">
              <Link href={START_TRIAL.href} className={primary}>{START_TRIAL.label}</Link>
              <a href={`mailto:${COMPANY.email}?subject=Edwyz%20WA%20pricing`} className="pub-ink font-medium underline underline-offset-2">{COMPANY.email}</a>
            </div>
          </div>
        ) : (
          <>
            {billing && <BillingToggle current={billing} />}
            <ul className="mt-8 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
              {plans.map((plan) => {
                const price = formatPrice(plan);
                return (
                  <li key={plan.id} className="flex flex-col rounded-2xl border border-border bg-surface p-6">
                    <h2 className="text-xl font-semibold">{plan.name}</h2>
                    {plan.description && <p className="mt-1 text-sm text-muted">{plan.description}</p>}
                    <p className="mt-5">
                      <span className="text-3xl font-semibold tracking-tight">{price.amount}</span>
                      <span className="text-muted"> per {price.per}</span>
                    </p>
                    <ul className="mt-5 flex-1 space-y-2 text-sm">
                      {planLimitLines(plan, limitOpts).map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                    <Link href={START_TRIAL.href} className={`${primary} mt-6`}>
                      {START_TRIAL.label}
                      <span className="sr-only">, then choose {plan.name}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>

            <h2 className="mt-16 text-2xl font-semibold tracking-tight">Compare limits</h2>
            <div className="mt-4 overflow-x-auto rounded-2xl border border-border" tabIndex={0} role="region" aria-label="Plan limits comparison, scrolls sideways on small screens">
              <table className="w-full min-w-[32rem] border-collapse text-left text-sm">
                <caption className="sr-only">Limits for each plan. No fixed limit means the plan does not cap that item.</caption>
                <thead className="bg-surface">
                  <tr>
                    <th scope="col" className="px-4 py-3 font-semibold">Limit</th>
                    {plans.map((p) => (
                      <th key={p.id} scope="col" className="px-4 py-3 font-semibold">{p.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.key} className="border-t border-border">
                      <th scope="row" className="px-4 py-3 font-medium">{row.label}</th>
                      {row.values.map((v, i) => (
                        <td key={plans[i].id} className="px-4 py-3 text-muted">{v}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        <div className="mt-10 max-w-3xl space-y-2 text-sm leading-relaxed text-muted">
          {plans.length > 0 && <p>{tax.main}</p>}
          {plans.length > 0 && tax.proforma && <p>{tax.proforma}</p>}
          {plans.length > 0 && aiNote && <p>{aiNote}</p>}
          <p>Ad spend is paid to Meta from your own ad account. We never hold it.</p>
          <p>
            Questions about plans or bigger teams? Write to{" "}
            <a href={`mailto:${COMPANY.email}`} className="pub-ink underline underline-offset-2">{COMPANY.email}</a>. See also the{" "}
            <Link href="/#faq" className="pub-ink underline underline-offset-2">common questions</Link>.
          </p>
        </div>
      </main>
    </Pub>
  );
}
