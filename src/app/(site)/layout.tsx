import { Footer, Header } from "@/components/shell";

// Rendered per request, not at build time: these pages print siteUrl() (canonicals, JSON-LD, the API base URL in the docs,
// the callback and status URLs on the legal pages). A static build made on a developer machine would freeze SITE_URL at
// http://localhost:3500 and ship that to production, which is what happened.
export const dynamic = "force-dynamic";

export default function SiteLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <>
      <Header />
      {children}
      <Footer />
    </>
  );
}
