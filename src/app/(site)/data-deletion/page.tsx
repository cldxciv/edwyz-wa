import { pageMetadata } from "@/components/site/seo";
import { COMPANY, siteUrl } from "@/lib/config";
import { LEGAL } from "@/lib/legal";
import { LegalDoc, Sec } from "../privacy/legal-doc";

export const metadata = pageMetadata({
  title: "Data Deletion",
  description: "How to ask Edwyz WA to delete your personal data, by email or by removing the Edwyz API app from your Facebook account.",
  path: "/data-deletion",
});

const SECTIONS = [
  { id: "facebook", title: "Remove the app on Facebook" },
  { id: "email", title: "Ask by email" },
  { id: "status", title: "Check the status of a request" },
  { id: "what-happens", title: "What happens next" },
  { id: "business-messages", title: "If a business messaged you" },
] as const;

const SUMMARY = [
  "Remove the app “Edwyz API” from your Facebook account and Meta sends us a deletion request automatically, or email us.",
  "You get a confirmation code and a status page link for requests that come from Facebook.",
  `We aim to finish within ${LEGAL.requestResponseDays} days. We keep only what the law requires, such as billing records.`,
];

export default function DataDeletionPage() {
  const [facebook, email, status, next, business] = SECTIONS;
  return (
    <LegalDoc title="Data deletion" summary={SUMMARY} sections={SECTIONS}>
      <p>
        You can ask {COMPANY.legalName} to delete the personal data we hold about you in {COMPANY.product}. See also our{" "}
        <a href="/privacy">Privacy Policy</a>.
      </p>

      <Sec section={facebook}>
        <ol className="mt-3 list-decimal pl-5">
          <li>In Facebook, open Settings and privacy, then Settings, then Apps and Websites (or Business Integrations).</li>
          <li>Find &ldquo;Edwyz API&rdquo; and choose Remove.</li>
          <li>
            Facebook sends a signed deletion request to our callback ({siteUrl()}/api/meta/data-deletion). We verify it, record it, and return a
            confirmation code and a status link to Facebook.
          </li>
        </ol>
      </Sec>

      <Sec section={email}>
        <p>
          Write to <a href={`mailto:${COMPANY.email}?subject=Data%20deletion%20request`}>{COMPANY.email}</a>{" "}with the subject &ldquo;Data deletion
          request&rdquo;. Write from the email address on your account, or include your workspace name and the WhatsApp number concerned, so we can confirm
          it is you.
        </p>
      </Sec>

      <Sec section={status}>
        <p>
          If your request came from Facebook, open <a href="/data-deletion/status">{siteUrl()}/data-deletion/status</a>{" "}and enter the confirmation code, or
          use the link Facebook shows you. The status is &ldquo;received&rdquo; until the deletion has been carried out (automatically for data connected to your Facebook login, otherwise by our team), then &ldquo;completed&rdquo;.
        </p>
      </Sec>

      <Sec section={next}>
        <ul>
          <li>
            For a request from Facebook, we automatically erase your Meta connection and what came only from it (Pages, Instagram, ad accounts, leads from
            your Pages, campaigns and ad performance data) and mark the request completed. Your business&apos;s WhatsApp data is not part of it.
          </li>
          <li>We confirm your identity and the scope of the request.</li>
          <li>We delete or anonymise your personal data, except data we must keep by law, such as tax and billing records.</li>
          <li>We aim to finish within {LEGAL.requestResponseDays} days and confirm by email or on the status page.</li>
        </ul>
      </Sec>

      <Sec section={business}>
        <p>
          Messages you exchanged with a business through {COMPANY.product}{" "}are part of that business&apos;s records, and the business decides how they are
          used. Please ask the business to delete them. If you cannot reach it, email us and we will help.
        </p>
      </Sec>
    </LegalDoc>
  );
}
