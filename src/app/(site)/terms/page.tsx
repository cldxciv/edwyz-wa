import { pageMetadata } from "@/components/site/seo";
import { COMPANY } from "@/lib/config";
import { LEGAL, META_LINKS, TERMS_SECTIONS as S } from "@/lib/legal";
import { LegalDoc, Sec, find } from "../privacy/legal-doc";

export const metadata = pageMetadata({
  title: "Terms of Service",
  description:
    "The terms for using Edwyz WA: accounts, WhatsApp rules every customer must follow, plans and billing in INR with GST, suspension, liability and governing law.",
  path: "/terms",
});

const SUMMARY = [
  `${COMPANY.product} lets a business run WhatsApp conversations and broadcasts on its own number through Meta's WhatsApp Business Platform.`,
  "You must follow the WhatsApp Business Terms, Messaging Policy and Commerce Policy, get opt-in before marketing messages, and never send spam.",
  "Paid plans are billed in INR through Razorpay, with GST. A free trial applies to new workspaces. You can cancel at the end of a billing period.",
  `You keep ownership of your data and can ask for it to be exported or deleted. These terms are governed by Indian law, with courts at ${LEGAL.jurisdictionCity}.`,
];

const sec = (id: string) => find(S, id);

export default function TermsPage() {
  return (
    <LegalDoc title="Terms of Service" summary={SUMMARY} sections={S}>
      <Sec section={sec("service")}>
        <p>
          These terms govern your use of {COMPANY.product} at wa.edwyz.com, provided by {COMPANY.legalName}{" "}(&ldquo;Edwyz&rdquo;, &ldquo;we&rdquo;). By
          creating an account or using the service you agree to them for yourself and the business you represent.
        </p>
        <p>
          {COMPANY.product}{" "}is software that lets a business connect its own WhatsApp Business number to the WhatsApp Business Platform through Meta&apos;s
          Embedded Signup, and manage conversations in a team inbox, message templates, contacts, broadcasts and automations. The WhatsApp Business Platform is
          run by Meta, not by us. We are independent of Meta and not endorsed by it. See our <a href="/privacy">Privacy Policy</a>{" "}for how data is handled.
        </p>
      </Sec>

      <Sec section={sec("eligibility")}>
        <p>
          The service is for businesses and professionals. You must be at least 18, able to enter a binding contract, and authorised to bind the business
          you sign up for. You must not be barred from using Meta&apos;s products or from receiving services under applicable law.
        </p>
      </Sec>

      <Sec section={sec("accounts")}>
        <p>
          Give accurate information and keep it up to date. Keep your password and any two-factor codes or API keys secret, and tell us promptly at{" "}
          <a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a>{" "}if you suspect unauthorised use. You are responsible for activity under your workspace,
          including by people you invite and integrations you create.
        </p>
      </Sec>

      <Sec section={sec("roles")}>
        <p>
          A workspace has members with roles that control what they can do, such as managing members, billing, connected numbers, templates and broadcasts.
          The workspace owner decides who gets which role and is responsible for removing access when someone leaves.
        </p>
      </Sec>

      <Sec section={sec("responsibilities")}>
        <ul>
          <li>You are responsible for the contacts you load and the messages you send, and for having the legal right and consent to do so.</li>
          <li>Get a valid opt-in from each person before sending marketing messages, keep a record of it, and stop when they ask, including when they reply STOP.</li>
          <li>Send free-form messages only within the 24-hour customer service window, and use approved templates outside it.</li>
          <li>Keep your business profile, display name and contact details accurate, and comply with the laws that apply to your business, including consumer protection, data protection and telecom or marketing rules.</li>
          <li>Pay Meta any charges it makes for WhatsApp conversations. Meta bills these under your own payment method in WhatsApp Manager, not through us.</li>
        </ul>
      </Sec>

      <Sec section={sec("whatsapp-rules")}>
        <p>You must follow Meta&apos;s rules at all times. They can change, and they apply even where these terms do not repeat them:</p>
        <ul>
          <li><a href={META_LINKS.businessTerms}>WhatsApp Business Terms of Service</a></li>
          <li><a href={META_LINKS.messagingPolicy}>WhatsApp Business Messaging Policy</a></li>
          <li><a href={META_LINKS.commercePolicy}>WhatsApp Commerce Policy</a></li>
          <li><a href={META_LINKS.metaPlatformTerms}>Meta Platform Terms</a></li>
        </ul>
        <p>
          Meta may restrict, rate-limit or disable a number, template or account, and may change its rules, prices or limits. We are not responsible for
          Meta&apos;s decisions. The product also enforces some rules itself, for example by limiting broadcasts to your number&apos;s messaging limit and
          blocking marketing sends to contacts who opted out.
        </p>
      </Sec>

      <Sec section={sec("meta-ads-ai")}>
        <ul>
          <li>
            <strong>Facebook, Instagram and ads.</strong>{" "}If you connect Pages, Instagram accounts or ad accounts, you confirm you are allowed to manage them
            and you must follow the <a href={META_LINKS.metaPlatformTerms}>Meta Platform Terms</a> and Meta&apos;s{" "}
            <a href={META_LINKS.metaAdsPolicies}>advertising standards</a>. Ad spend is charged by Meta to your own ad account payment method, not by us.
            Campaigns are created paused and nothing that spends money runs until an owner or admin confirms it, within the daily budget cap you set.
          </li>
          <li>
            <strong>Lead ads.</strong>{" "}You are responsible for the consent text on your lead forms, for having a lawful basis to contact the people who
            submit them, and for the way you use their answers. Do not use lead data for anything the form did not tell people about.
          </li>
          <li>
            <strong>AI features.</strong>{" "}They are optional. AI output can be wrong or unsuitable. You are responsible for reviewing AI-written replies,
            ad copy and images before relying on or publishing them, and for telling your customers when an AI assistant replies to them. AI features
            use Anthropic as a subprocessor, as described in the <a href="/privacy">Privacy Policy</a>, and use AI credits where your plan meters them.
          </li>
          <li>
            <strong>Eddy.</strong>{" "}Eddy acts on your instructions and your confirmations. Check each preview before you confirm; you are responsible for
            messages and changes you approve. Eddy&apos;s answers may be inaccurate.
          </li>
          <li>
            <strong>Shopify.</strong>{" "}If you connect a Shopify store you must have the right to do so and a lawful basis to message your shoppers; abandoned
            cart reminders go only to contacts who opted in.
          </li>
          <li>
            <strong>Disconnecting.</strong>{" "}You can disconnect any connection in Settings. If the person who connected Facebook removes the app in Facebook,
            we erase the data that came only from that connection, as the Privacy Policy describes, and features that depend on it stop working.
          </li>
        </ul>
      </Sec>

      <Sec section={sec("prohibited")}>
        <ul>
          <li>Sending spam, unsolicited bulk messages, or messages to people who have not opted in or have opted out.</li>
          <li>Unlawful, deceptive, harassing, hateful, sexually exploitative or fraudulent content, phishing, or content that infringes others&apos; rights.</li>
          <li>Goods or services that WhatsApp&apos;s Commerce Policy or Messaging Policy prohibit.</li>
          <li>Collecting or processing sensitive data you have no right to handle, or sharing credentials or one-time codes in ways the policies forbid.</li>
          <li>Accessing another customer&apos;s data, probing, scanning or disrupting the service, evading limits, or reverse engineering it except as law allows.</li>
          <li>Reselling or sublicensing the service without our written agreement.</li>
        </ul>
      </Sec>

      <Sec section={sec("suspension")}>
        <p>
          We may suspend or restrict a workspace, number, API key or user, with notice where practical, if we reasonably believe you have breached these
          terms or Meta&apos;s rules, if your use puts other customers, the service or our Meta app at risk, if the law or Meta requires it, or if payment
          is overdue. While a workspace is suspended it cannot send or change data. We will tell you the reason shown in the account and work with you to
          resolve it where we can.
        </p>
      </Sec>

      <Sec section={sec("plans-billing")}>
        <ul>
          <li>
            <strong>Trial.</strong>{" "}New workspaces start with a free trial. Its length is set by us in the product and shown in the account. When it ends,
            the workspace becomes read-only (you can view data and visit billing) until you subscribe.
          </li>
          <li>
            <strong>Plans and price.</strong>{" "}Plan features, limits and prices are shown in the product before you subscribe. Prices are in Indian rupees
            (INR) and include GST unless the page says otherwise; GST is shown on your invoice. Invoices are issued once we have a GST registration on file;
            until then they are marked as proforma and are not tax invoices.
          </li>
          <li>
            <strong>Payment.</strong>{" "}Subscriptions are charged through Razorpay on a recurring basis using the payment method you authorise. Razorpay&apos;s
            terms apply to the payment. We do not store your card or UPI details.
          </li>
          <li>
            <strong>Failed payment.</strong>{" "}If a renewal fails, Razorpay retries. Access continues for a grace period shown in the product. If payment is
            not made by then, the workspace becomes read-only until payment succeeds.
          </li>
          <li>
            <strong>Cancellation.</strong>{" "}You can cancel from the billing page. Cancellation takes effect at the end of the current billing period and you
            keep access until then. A cancelled subscription cannot be reactivated; you start a new one. To change plan, cancel at the end of the period and
            choose the new plan.
          </li>
          <li>
            <strong>Mistakes and refunds.</strong> If you think you were billed incorrectly, email <a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a>{" "}and
            we will review it and correct genuine errors. Any other refund is at our discretion unless the law requires otherwise.
          </li>
          <li>
            <strong>Changes.</strong>{" "}We may change plans and prices. A change does not affect a billing period already paid, and we will give notice before
            it applies to your next renewal.
          </li>
        </ul>
      </Sec>

      <Sec section={sec("your-data")}>
        <p>
          You own your content and contact data. You give us permission to process it only to provide the service to you, as described in the{" "}
          <a href="/privacy">Privacy Policy</a>. For personal data in your contacts and messages, you are the controller (data fiduciary) and we are your
          processor; you are responsible for the notices and consents that apply to it. Some data is deleted automatically after fixed periods (for example ad
          performance data, conversion events, finished chatbot sessions and leads); the periods are listed in the Privacy Policy. We may use aggregated, non-identifying usage statistics to run and
          improve the service.
        </p>
      </Sec>

      <Sec section={sec("availability")}>
        <p>
          We work to keep the service running but do not promise uninterrupted or error-free operation, and the service depends on Meta and other third
          parties we do not control. We may add, change or remove features and will give reasonable notice of changes that materially affect you. Scheduled
          maintenance may cause brief interruptions.
        </p>
      </Sec>

      <Sec section={sec("disclaimers")}>
        <p>
          To the extent the law allows, the service is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;. We do not give warranties of fitness for a
          particular purpose, non-infringement, message delivery, or that a template, number or account will be approved or stay enabled by Meta. Nothing in
          the service is legal advice.
        </p>
      </Sec>

      <Sec section={sec("liability")}>
        <p>
          To the extent the law allows, we are not liable for indirect, incidental, special or consequential loss, or for loss of profit, revenue, goodwill or
          data, or for loss caused by Meta, Razorpay or other third parties. Our total liability for all claims arising from the service is limited to the fees
          you paid us in the {LEGAL.liabilityCapMonths}{" "}months before the claim arose. Nothing in these terms limits liability that cannot be limited by law.
        </p>
      </Sec>

      <Sec section={sec("indemnity")}>
        <p>
          You will defend and compensate us against claims, losses and reasonable costs arising from your content, your contacts and messages, your breach of
          these terms or Meta&apos;s rules, or your violation of law or a third party&apos;s rights, except to the extent we caused them.
        </p>
      </Sec>

      <Sec section={sec("termination")}>
        <p>
          You can stop using the service at any time and cancel your plan as described above. We may end access for serious or repeated breach, or if the service
          is discontinued, with notice where practical. On exit, you can ask us at <a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a>{" "}to export or delete your workspace data, and we will handle the request as
          described in the <a href="/privacy">Privacy Policy</a> and on the <a href="/data-deletion">data deletion page</a>, except records we must keep by
          law. Sections that by their nature should survive, such as liability, indemnity and governing law, continue after termination.
        </p>
      </Sec>

      <Sec section={sec("governing-law")}>
        <p>
          These terms are governed by the laws of India. Subject to any mandatory rights you have, the courts at {LEGAL.jurisdictionCity},{" "}
          {LEGAL.jurisdictionState}, have exclusive jurisdiction.
        </p>
      </Sec>

      <Sec section={sec("changes")}>
        <p>
          We may update these terms. We will post the new version here with a new &ldquo;Last updated&rdquo; date and version, and give notice of material
          changes. If you keep using the service after a change takes effect, you accept it; if you do not agree, you can cancel before it applies.
        </p>
      </Sec>

      <Sec section={sec("contact")}>
        <p>
          {COMPANY.legalName}, {COMPANY.address}. Email: <a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a>.
        </p>
      </Sec>
    </LegalDoc>
  );
}
