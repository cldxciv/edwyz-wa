import Link from "next/link";
import { COMPANY } from "@/lib/config";
import { LEGAL } from "@/lib/legal";
import { NAV_LINKS, SIGN_IN, START_TRIAL } from "@/components/site/content";
import { MobileNav } from "@/components/site/mobile-nav";
import { NavLink } from "@/components/site/nav-link";

export function Logo({ className = "text-lg" }: { className?: string }) {
  return (
    <Link href="/" aria-label={`${COMPANY.product} home`} className={`inline-flex shrink-0 items-center gap-2 whitespace-nowrap font-semibold tracking-tight ${className}`}>
      <svg viewBox="0 0 32 32" className="h-7 w-7" aria-hidden="true" focusable="false">
        <rect width="32" height="32" rx="9" className="fill-accent" />
        <path d="M16 7.5a8.5 8.5 0 0 0-7.3 12.9L7.5 24.5l4.2-1.1A8.5 8.5 0 1 0 16 7.5z" fill="none" stroke="#fff" strokeWidth="2" strokeLinejoin="round" />
        <path d="m12.5 16 2.4 2.4 4.6-4.8" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span>
        Edwyz <span style={{ color: "var(--accent-ink, var(--accent))" }}>WA</span>
      </span>
    </Link>
  );
}

const ctaClass =
  "inline-flex items-center justify-center whitespace-nowrap rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-strong";
const navLinkClass = "rounded-full px-3 py-2 hover:bg-surface";
const navCurrentClass = "bg-surface text-accent-ink";

export function Header() {
  const mobileLinks = [...NAV_LINKS, SIGN_IN];
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/90 backdrop-blur">
      <div className="relative mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
        <Logo />
        <nav aria-label="Main" className="hidden items-center gap-1 text-sm font-medium md:flex">
          {NAV_LINKS.map((l) => (
            <NavLink key={l.href} href={l.href} className={navLinkClass} currentClassName={navCurrentClass}>
              {l.label}
            </NavLink>
          ))}
          <NavLink href={SIGN_IN.href} className={`ml-2 ${navLinkClass}`} currentClassName={navCurrentClass}>
            {SIGN_IN.label}
          </NavLink>
          <Link href={START_TRIAL.href} className={`ml-1 ${ctaClass}`}>
            {START_TRIAL.label}
          </Link>
        </nav>
        <div className="flex items-center gap-2 md:hidden">
          {/* Below 360px the logo, the full label and the menu button do not fit on one line, so the button says less. */}
          <Link href={START_TRIAL.href} className={`${ctaClass} max-[359px]:px-3`}>
            <span className="max-[359px]:hidden">{START_TRIAL.label}</span>
            <span className="hidden max-[359px]:inline">{START_TRIAL.shortLabel}</span>
          </Link>
          <MobileNav links={mobileLinks} />
        </div>
      </div>
    </header>
  );
}

const linkClass = "rounded underline-offset-2 hover:underline";

export function Footer() {
  return (
    <footer className="mt-20 border-t border-border bg-surface">
      <div className="mx-auto max-w-6xl px-4 py-12 text-sm text-muted sm:px-6">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <Logo className="text-base" />
            <p className="mt-3 max-w-xs leading-relaxed">WhatsApp team inbox, broadcasts, chatbots and AI replies in one place, with spending limits you set.</p>
          </div>
          <nav aria-label="Product">
            <h2 className="text-sm font-semibold text-foreground">Product</h2>
            <ul className="mt-3 space-y-2">
              <li><Link href="/#features" className={linkClass}>Features</Link></li>
              <li><Link href="/#how-it-works" className={linkClass}>How it works</Link></li>
              <li><Link href="/pricing" className={linkClass}>Pricing</Link></li>
              <li><Link href="/#faq" className={linkClass}>Questions</Link></li>
              <li><Link href="/docs" className={linkClass}>Docs</Link></li>
            </ul>
          </nav>
          <nav aria-label="Account and legal">
            <h2 className="text-sm font-semibold text-foreground">Account and legal</h2>
            <ul className="mt-3 space-y-2">
              <li><Link href={SIGN_IN.href} className={linkClass}>{SIGN_IN.label}</Link></li>
              <li><Link href={START_TRIAL.href} className={linkClass}>{START_TRIAL.label}</Link></li>
              <li><Link href="/privacy" className={linkClass}>Privacy policy</Link></li>
              <li><Link href="/terms" className={linkClass}>Terms of service</Link></li>
              <li><Link href="/data-deletion" className={linkClass}>Data deletion</Link></li>
            </ul>
          </nav>
          <div>
            <h2 className="text-sm font-semibold text-foreground">{COMPANY.legalName}</h2>
            <address className="mt-3 not-italic leading-relaxed">
              {COMPANY.address}
              <br />
              <a href={`mailto:${COMPANY.email}`} className="underline underline-offset-2">
                {COMPANY.email}
              </a>
            </address>
          </div>
        </div>
        <p className="mt-10 border-t border-border pt-6 text-xs leading-relaxed">
          {COMPANY.product} is operated by {COMPANY.legalName}, India. It is an independent product and is not affiliated with or endorsed by Meta or WhatsApp.
          WhatsApp, Facebook and Instagram are trademarks of Meta Platforms, Inc.
        </p>
      </div>
    </footer>
  );
}

export function LegalPage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-3xl px-6 pt-16">
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 text-sm text-muted">
        Last updated {LEGAL.lastUpdated} &middot; Version {LEGAL.version} &middot; {COMPANY.legalName}
      </p>
      <div className="prose-legal mt-6">{children}</div>
    </main>
  );
}
