import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Review and respond",
  robots: { index: false, follow: false, nocache: true },
  // same-origin keeps the token out of third-party requests, yet the browser still sends a real Origin on the decision form (no-referrer makes it "null").
  referrer: "same-origin",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function ApproveLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <main className="mx-auto w-full max-w-xl px-4 pb-10 pt-5 sm:pt-8">
        <p className="mb-5 text-sm font-semibold text-muted">Edwyz WA</p>
        {children}
        <p className="mt-8 text-center text-sm text-muted">You do not need to sign in. If you have a question, reply to the person who sent you this link.</p>
      </main>
    </div>
  );
}
