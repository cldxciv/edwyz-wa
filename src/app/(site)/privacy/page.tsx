import { pageMetadata } from "@/components/site/seo";
import { COMPANY, siteUrl } from "@/lib/config";
import { LEGAL, META_LINKS, PRIVACY_SECTIONS as S } from "@/lib/legal";
import { RETENTION_DEFAULTS as R, RETENTION_SUMMARY } from "@/lib/lifecycle/personal-data";
import { LegalDoc, Sec, find } from "./legal-doc";

export const metadata = pageMetadata({
  title: "Privacy Policy",
  description:
    "How Edwyz WA collects, uses, shares and protects personal data, including WhatsApp message data processed for businesses, and how to exercise your rights or request deletion.",
  path: "/privacy",
});

const SUMMARY = [
  `${COMPANY.legalName} runs ${COMPANY.product}, software that lets a business use its own WhatsApp number through Meta's official WhatsApp Business Platform.`,
  "For the people who sign up we are the controller (data fiduciary). For the contacts and messages a business handles in the product, the business is in charge and we are its processor.",
  "We do not sell personal data. Meta access tokens are stored encrypted. Only session cookies are used.",
  "If a business connects Facebook, Instagram or ad accounts, or Shopify, we also handle that data for it. AI features, including the in-app assistant Eddy, send limited text to Anthropic, only when the business turns them on.",
  `You can ask for access, correction or deletion by email at any time. We aim to reply within ${LEGAL.requestResponseDays} days.`,
];

const sec = (id: string) => find(S, id);

export default function PrivacyPage() {
  return (
    <LegalDoc title="Privacy Policy" summary={SUMMARY} sections={S}>
      <Sec section={sec("who-we-are")}>
        <p>
          {COMPANY.legalName} (&ldquo;Edwyz&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;) operates {COMPANY.product} at wa.edwyz.com, including the
          Meta app &ldquo;Edwyz API&rdquo;. Registered office: {COMPANY.address}. Contact:{" "}
          <a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a>.
        </p>
        <p>
          {COMPANY.product} lets a business (our &ldquo;customer&rdquo;) connect its own WhatsApp Business number through Meta&apos;s Embedded Signup,
          then run a shared team inbox, message templates and broadcasts on the WhatsApp Business Platform.
        </p>
      </Sec>

      <Sec section={sec("roles")}>
        <ul>
          <li>
            <strong>Controller (data fiduciary) for account and billing data.</strong> For the people who sign up and use a workspace, and for
            billing records, we decide how and why the data is used.
          </li>
          <li>
            <strong>Processor (data processor) for customer content.</strong> For the contacts, conversations and messages a customer loads into
            or receives through the product, the customer decides the purposes. We process that data only to run the service for the customer and
            on its instructions. If you received a message from a business and have a question about it, please contact that business first.
          </li>
        </ul>
      </Sec>

      <Sec section={sec("data-we-process")}>
        <ul>
          <li>
            <strong>Account data:</strong> name, email address, a salted hash of your password, optional two-factor (TOTP) secret and recovery
            codes (the secret is stored encrypted), role, and email verification and invite status.
          </li>
          <li>
            <strong>Workspace data:</strong> workspace name, members and their roles, settings, templates, quick replies, automation rules, API keys
            (stored hashed) and outbound webhook endpoints you configure.
          </li>
          <li>
            <strong>WhatsApp connection data:</strong> WhatsApp Business Account and phone number identifiers, display name, quality rating and
            messaging limit, onboarding logs, and the access tokens Meta issues to us for the customer&apos;s account, which we store encrypted.
          </li>
          <li>
            <strong>Contacts and messages:</strong> contact phone numbers, names, tags and custom attributes a customer provides, opt-in and
            opt-out records, message content and media references, message type, template name, timestamps, delivery and read status, internal
            notes and broadcast recipient records. Customers should load only data they have the right to use.
          </li>
          <li>
            <strong>Usage and security logs:</strong> audit log entries for account and workspace actions, session records, IP address and
            browser information used for sign-in security, webhook events received from Meta, and background job records.
          </li>
          <li>
            <strong>Billing data:</strong> plan and subscription status, billing name and address, GST details you provide, and invoice and payment
            event records. Card and UPI details are entered with Razorpay and are not stored by us.
          </li>
          <li>
            <strong>Facebook, Instagram, advertising and lead data</strong>, when a customer connects them: the Facebook user ID of the person who
            connected, Page, Instagram account, ad account, dataset and catalog IDs and names, ad campaign settings and performance numbers, scheduled
            posts, and the leads people submit through lead ads. See &ldquo;Facebook, Instagram, ad account and lead-ad data&rdquo; below.
          </li>
          <li>
            <strong>AI and commerce data</strong>, when a customer turns those features on: AI agent settings and knowledge text, brand and creative
            briefs, AI usage records, and Shopify store and abandoned-cart data. See the sections on AI features and Shopify below.
          </li>
          <li>
            <strong>Eddy conversations</strong>, when a workspace turns Eddy on: what people in the workspace type to Eddy, Eddy&apos;s replies, the
            workspace data Eddy looked up to answer, and a record of each action taken through Eddy and who confirmed it.
          </li>
          <li>
            <strong>Spending alert numbers:</strong> the WhatsApp number a workspace owner, or an admin the owner names as an approver, gives us for
            spending approvals, alerts and a daily summary; the record of their consent; and the messages we send to that number from Edwyz&apos;s own
            WhatsApp number. These messages carry campaign names and amounts, never the workspace&apos;s customer data.
          </li>
        </ul>
        <p>
          We do not collect the contents of anyone&apos;s Facebook profile. Through Meta we receive only what Meta&apos;s platforms provide for the
          permissions the customer grants, for WhatsApp and for any Facebook, Instagram or advertising connection the customer chooses to make.
        </p>
      </Sec>

      <Sec section={sec("purposes")}>
        <ul>
          <li>
            Provide, operate and support the service, including connecting numbers, delivering and displaying messages, and running broadcasts and
            automations. Basis: performance of our contract with the customer; for customer content, the customer&apos;s instructions.
          </li>
          <li>
            Secure accounts, prevent abuse and spam, and enforce WhatsApp and Meta rules. Basis: legitimate interests and, in India, the lawful uses
            permitted by the Digital Personal Data Protection Act, 2023 (&ldquo;DPDP Act&rdquo;).
          </li>
          <li>Bill for paid plans, issue invoices and keep tax records. Basis: contract and legal obligation.</li>
          <li>
            Send service emails such as verification, password reset, invites, trial and payment notices. Basis: contract and legitimate interests.
          </li>
          <li>Comply with law and respond to lawful requests. Basis: legal obligation.</li>
          <li>Where we rely on consent, you can withdraw it at any time.</li>
        </ul>
        <p>We do not sell personal data, and we do not use customer message content to build advertising profiles.</p>
      </Sec>

      <Sec section={sec("meta-whatsapp")}>
        <p>
          {COMPANY.product} is built on the WhatsApp Business Platform operated by Meta Platforms, Inc. and its affiliates. Messages sent or received
          through the platform pass through Meta&apos;s systems, and Meta processes that data under its own terms and privacy policies, not ours. We are
          an independent company and are not endorsed by Meta.
        </p>
        <ul>
          <li><a href={META_LINKS.whatsappPrivacy}>WhatsApp Privacy Policy</a></li>
          <li><a href={META_LINKS.metaPrivacy}>Meta Privacy Policy</a></li>
          <li><a href={META_LINKS.businessTerms}>WhatsApp Business Terms of Service</a></li>
          <li><a href={META_LINKS.messagingPolicy}>WhatsApp Business Messaging Policy</a></li>
          <li><a href={META_LINKS.metaPlatformTerms}>Meta Platform Terms</a></li>
        </ul>
        <p>
          Customers must have a valid opt-in before sending marketing messages. People can stop marketing messages by replying STOP, and the product
          records and honours that request.
        </p>
      </Sec>

      <Sec section={sec("meta-growth-data")}>
        <p>
          This section applies only if a customer connects Facebook, Instagram or advertising assets to {COMPANY.product} with Facebook Login. We act as
          the customer&apos;s processor for this data and use it only to run the features the customer uses.
        </p>
        <ul>
          <li>
            <strong>The connection.</strong> We receive the app-scoped Facebook user ID of the person who connected, the permissions they granted, and
            access tokens. Tokens are stored encrypted with AES-256-GCM and are never shown or logged. We also store the Pages, Instagram professional
            accounts, ad accounts, datasets (pixels) and catalogs that person can use for the customer&apos;s workspace: their IDs and names.
          </li>
          <li>
            <strong>Facebook Pages and Instagram.</strong> We publish the posts a customer schedules, and read Page and Instagram engagement and insights
            for the customer&apos;s own reports.
          </li>
          <li>
            <strong>Ad accounts and ad performance data.</strong> We create and manage the campaigns, ad sets and ads the customer asks for, in the
            customer&apos;s ad account. Campaigns are created paused and need an explicit confirmation from an owner or admin, within a daily budget cap
            the customer sets. We read performance numbers (spend, impressions, clicks, results, frequency and quality ranking) per campaign, ad set and
            ad. These are not about individual people. We keep them for {R.insightSnapshotDays} days.
          </li>
          <li>
            <strong>Lead ads.</strong> When someone submits a lead form on a customer&apos;s Facebook or Instagram ad, Meta tells us and we retrieve that
            lead: the answers they gave (such as name, email, phone number and custom questions), the form, ad and campaign IDs, and the consent text
            and time shown on the form. The customer is in charge of this data. We show it in the customer&apos;s lead inbox and, only where the
            customer has set it up, send follow-up WhatsApp messages. Marketing messages need the person&apos;s opt-in, which we record from the form
            consent. Leads are kept for {R.leadMonths} months after their last activity unless the customer deletes them earlier.
          </li>
          <li>
            <strong>Conversion events.</strong> If a customer turns it on, we send events (for example, a lead became qualified) to Meta&apos;s
            Conversions API for the customer&apos;s dataset. Email and phone number are sent only as one-way SHA-256 hashes, with the event name and
            time. We keep our record of each event for {R.conversionEventDays} days.
          </li>
          <li>
            <strong>Approvals.</strong> Approval links we send are stored only as a hash. We keep the decision and any comment for{" "}
            {R.approvalRequestDays} days after it is made.
          </li>
        </ul>
        <p>
          We do not sell this data, use it for our own advertising, build profiles from it, or use it to train models. We use it only as Meta&apos;s{" "}
          <a href={META_LINKS.metaPlatformTerms}>Platform Terms</a> allow.
        </p>
        <p>
          <strong>Disconnecting and removal.</strong> A customer can disconnect at any time in Settings: we ask Meta to revoke the permission (best
          effort) and delete the stored tokens. If a person removes the app &ldquo;Edwyz API&rdquo; in Facebook, or asks us by email, we erase that
          person&apos;s Meta connection, its Pages, Instagram, ad account and dataset records, and the data that came only from it: leads from its Pages
          with their forms and follow-up records, contacts created only by those leads, campaigns, ad sets, ads, ad performance data, suggestions and
          post targets. The rest of the workspace, such as WhatsApp contacts and messages, belongs to the business and stays until the business deletes it.
        </p>
      </Sec>

      <Sec section={sec("ai-processing")}>
        <p>
          AI features are off until a customer turns them on. When they are on, we send limited text to <strong>Anthropic, PBC</strong>, our AI
          subprocessor, through its commercial API, and show the answer in the product. Anthropic processes and keeps it under its own terms and{" "}
          <a href={META_LINKS.anthropicPrivacy}>privacy policy</a>, outside India.
        </p>
        <ul>
          <li>
            <strong>AI agent (WhatsApp replies).</strong> Sent: the business&apos;s instructions, the parts of the business&apos;s knowledge that match the
            customer&apos;s question, the contact&apos;s name if the business has one, the last few text messages of that conversation (at most 10
            messages and about 4,000 characters), and, if the business connected its own tools, the results those tools return. Only text messages are used.
          </li>
          <li>
            <strong>Inbox reply suggestions.</strong> When a team member asks for suggested replies, we send the business&apos;s AI instructions, the
            matching parts of its knowledge and the last text messages of that conversation (at most 12). Nothing is sent to the customer until the
            team member sends it.
          </li>
          <li>
            <strong>Chatbot escalation check.</strong> If a business turns it on for a chatbot, each customer message to that chatbot (at most 500
            characters) is sent to check whether the customer is asking for a person.
          </li>
          <li>
            <strong>Creative studio (ad research, angles and copy).</strong> Sent: the brand name, colours, tone and industry, the offer and goal the
            customer wrote, text we fetch from the website address the customer gave, and competitor notes the customer typed.
          </li>
          <li>
            <strong>Never sent:</strong> access tokens, passwords, API keys, payment details or any other workspace&apos;s data. We do not write the
            content of prompts or answers to our application logs. Eddy conversations are stored as described below. We record the amount of AI
            credit used and keep that record for {R.usageLedgerDays} days.
          </li>
        </ul>
        <p>
          A business that connects its own MCP tool server decides which of its tools the AI agent may call; what the agent sends to that server goes to the
          destination the business chose. Businesses should tell their customers when an AI assistant replies to them and review AI-written ad copy before
          using it.
        </p>
        <p id="eddy">
          <strong>Eddy, the in-app assistant.</strong> Eddy is an optional assistant inside the Edwyz app. The workspace owner turns it on. When
          someone in the workspace asks Eddy something, we send their question, the page they are on, and the workspace data Eddy looks up to answer,
          such as conversations, customer messages, contact details and templates that this person is already allowed to see, to Anthropic, PBC, which
          runs the AI model for us. We keep Eddy conversations for {R.eddyHistoryDays} days so people can scroll back, then delete them. Each person can
          delete their own Eddy history at any time, and erasing a contact also erases Eddy conversations that included that contact. When a person
          deletes their Eddy history, a record of the actions they confirmed (including the text of messages they approved) is kept for{" "}
          {R.actionRecordDays} days as part of the activity record. Eddy acts with the same permissions as the person using it, and asks for
          confirmation before it messages customers, spends money or deletes anything. We record which actions Eddy took and who confirmed them, as we
          do for actions people take themselves. Admins of a workspace cannot read their teammates&apos; Eddy conversations; they can see which actions
          were taken through Eddy. Eddy can be wrong, so check important details before relying on them.
        </p>
      </Sec>

      <Sec section={sec("shopify-data")}>
        <p>
          If a customer connects a Shopify store, we store the shop domain and the access token and webhook secret Shopify gives us (encrypted). Shopify
          sends us checkout and cart events. For abandoned checkouts we keep the shopper&apos;s phone number, the items, the total, the checkout link and
          the reminder status, and we keep each record for {R.abandonedCartDays} days. We send a WhatsApp reminder only to a contact who has opted in and
          has not opted out. See <a href={META_LINKS.shopifyPrivacy}>Shopify&apos;s privacy policy</a>.
        </p>
      </Sec>

      <Sec section={sec("subprocessors")}>
        <p>We share data only as needed to run the service, with these categories of recipients:</p>
        <ul>
          <li>
            <strong>Meta Platforms:</strong> the WhatsApp Business Platform, Embedded Signup and Graph API, and for customers who connect them, Facebook
            Login, Pages, Instagram, the Marketing API, lead ads and the Conversions API, as described above.
          </li>
          <li>
            <strong>Anthropic, PBC:</strong> AI processing, for workspaces that turn on AI features, including Eddy, limited to the text described in the AI
            section above.
          </li>
          <li><strong>Shopify:</strong> only for customers who connect a Shopify store; Shopify sends us the store&apos;s cart and checkout events.</li>
          <li>
            <strong>Razorpay:</strong> payment processing and subscription billing. See the{" "}
            <a href={META_LINKS.razorpayPrivacy}>Razorpay privacy policy</a>.
          </li>
          <li><strong>Hosting and infrastructure provider:</strong> the servers and database where the service runs.</li>
          <li><strong>Email delivery provider:</strong> sends verification, invite, password reset and billing notices.</li>
          <li><strong>Professional advisers and authorities:</strong> where needed to protect legal rights or where the law requires it.</li>
          <li><strong>Your own endpoints:</strong> if a customer configures outbound webhooks or API integrations, data is sent to the destinations it chooses.</li>
        </ul>
        <p>We will give you the current list of named providers on request.</p>
      </Sec>

      <Sec section={sec("transfers")}>
        <p>
          We are based in India.{" "}
          {LEGAL.hostingLocation
            ? `Our production data is hosted in ${LEGAL.hostingLocation}.`
            : "Our production data is hosted with a third-party infrastructure provider."}{" "}
          Meta and our other providers process data in other countries, so personal data can be transferred outside India, and outside the EEA or UK for
          people there. We rely on the transfer routes the DPDP Act and, where applicable, the GDPR and UK GDPR allow, such as contractual safeguards.
        </p>
      </Sec>

      <Sec section={sec("retention")}>
        <p>We keep data only as long as the purposes above need, then delete or anonymise it. What the system actually does:</p>
        <ul>
          <li>
            Customer content (contacts, conversations, messages, templates) stays while the workspace is active and is deleted when the customer asks us
            to delete it or the workspace. A customer can also delete an individual contact together with its messages and notes.
          </li>
          <li>
            Webhook events received from Meta are deleted 30 days after they are processed. Completed background jobs are deleted after 7 days.
            Automation run records are deleted after 90 days.
          </li>
          <li>
            Sign-in sessions are deleted 30 days after they expire or are revoked. One-time email tokens (verification, reset) are deleted 7 days after use or expiry.
          </li>
          <li>
            Eddy conversations are deleted {R.eddyHistoryDays} days after their last message, or at once when the person deletes their Eddy history.
            Records of actions taken through Eddy are deleted {R.actionRecordDays} days after they are decided. When a person leaves a workspace or
            their account is erased, Eddy forgets them there.
          </li>
          <li>
            Spending alert numbers stay while the person is a member of the workspace and are removed when they leave or the workspace is erased,
            together with the alerts we sent to them about that workspace. Replying STOP ends the alerts at once; the consent record is kept as proof
            for the life of the workspace.
          </li>
          <li>
            When a user account is erased we replace the name and email with placeholders, remove the password hash and two-factor data, revoke
            sessions and remove memberships. If the user is a workspace&apos;s only owner the membership is kept until the workspace is transferred or closed.
          </li>
          <li>
            Product and advertising data is deleted automatically after these periods:
            <ul>
              {RETENTION_SUMMARY.slice(5).map((r) => (
                <li key={r.label}>
                  {r.label}: {r.period}.
                </li>
              ))}
            </ul>
            These are the current defaults; we can change them within safe limits and will update this page. A customer can delete leads and other
            records earlier. Generated creative image and video files with no matching record are deleted after 24 hours.
          </li>
          <li>
            When a workspace is erased, we delete its contacts, conversations, messages, leads, ad and post data, AI settings, connections and uploaded
            files, revoke its Meta connections, overwrite stored secrets, and keep only a tombstone (a one-way hash of the workspace ID and the date) and
            the billing records mentioned below.
          </li>
          <li>
            Invoices, payment records and audit logs have no fixed deletion period in the product. We keep billing records for as long as tax and
            accounting law requires, and other records until you ask us to delete them.
          </li>
        </ul>
      </Sec>

      <Sec section={sec("security")}>
        <ul>
          <li>Meta access tokens are encrypted at rest with AES-256-GCM, and two-factor secrets are stored encrypted.</li>
          <li>Passwords are stored only as salted hashes. API keys are stored hashed.</li>
          <li>Traffic uses TLS (HTTPS). Session cookies are HttpOnly and, in production, Secure.</li>
          <li>
            Role-based access control within each workspace, and tenant isolation: each request is limited to the data of the signed-in user&apos;s own workspace.
          </li>
          <li>Platform administrator access requires time-based one-time password (TOTP) two-factor authentication.</li>
          <li>The signature of webhooks from Meta and Razorpay is verified before they are processed.</li>
          <li>Secrets such as tokens and passwords are kept out of logs.</li>
        </ul>
        <p>
          No system is perfectly secure. If a personal data breach affects you, we will notify the affected customers, the authorities and individuals as
          the law requires.
        </p>
      </Sec>

      <Sec section={sec("your-rights")}>
        <p>
          <strong>India (DPDP Act, 2023).</strong> You may ask for a summary of your personal data and who it is shared with, to have it corrected,
          completed or updated, to have it erased, to withdraw consent, to nominate another person to exercise your rights if you die or become
          incapacitated, and to have a grievance addressed. If our response does not resolve your grievance, you may complain to the Data Protection Board
          of India.
        </p>
        <p>
          <strong>EU and UK (GDPR).</strong> Where those laws apply you may also ask for portability, object to or ask us to restrict processing, and
          complain to your supervisory authority.
        </p>
        <p>
          <strong>How.</strong> Email <a href={`mailto:${COMPANY.email}?subject=Privacy%20request`}>{COMPANY.email}</a> from the address on your account
          (or tell us your workspace name) so we can confirm it is you. We aim to respond within {LEGAL.requestResponseDays} days. If your data was loaded
          by a business that messaged you, we may direct your request to that business, because it decides how that data is used; we will help you reach it.
        </p>
      </Sec>

      <Sec section={sec("data-deletion")}>
        <p>
          You can ask us to delete your data in either of two ways, described in full on our <a href="/data-deletion">data deletion page</a>:
        </p>
        <ul>
          <li>
            <strong>Remove the app on Facebook.</strong> In Facebook, go to Settings, then Apps and Websites, and remove &ldquo;Edwyz API&rdquo;. Meta then
            sends a signed deletion request to our callback at {siteUrl()}/api/meta/data-deletion. We record it and return a confirmation code and a link to
            check progress at <a href="/data-deletion/status">{siteUrl()}/data-deletion/status</a>. The request is recorded automatically. We then erase the
            data connected to your Facebook login (see &ldquo;Facebook, Instagram, ad account and lead-ad data&rdquo;) automatically, and the status
            page shows &ldquo;completed&rdquo;. Anything else you ask us to delete is handled by our team.
          </li>
          <li>
            <strong>By email</strong> to{" "}
            <a href={`mailto:${COMPANY.email}?subject=Data%20deletion%20request`}>{COMPANY.email}</a>.
          </li>
        </ul>
        <p>
          We delete or anonymise your personal data, except data we must keep by law, such as tax and billing records. We aim to finish within{" "}
          {LEGAL.requestResponseDays} days.
        </p>
      </Sec>

      <Sec section={sec("cookies")}>
        <p>
          We use only strictly necessary session cookies (<code>wa_access</code> and <code>wa_refresh</code>) to keep you signed in. They are HttpOnly, last
          up to 15 minutes and 30 days respectively, and end when you sign out. We do not use advertising or analytics cookies and do not load third-party
          tracking scripts on this site. Razorpay and Meta may set their own cookies when you use their checkout or sign-up windows, under their own policies.
        </p>
      </Sec>

      <Sec section={sec("children")}>
        <p>
          {COMPANY.product} is for businesses and is not directed at anyone under 18. We do not knowingly collect children&apos;s personal data. If you
          believe we have, tell us and we will delete it.
        </p>
      </Sec>

      <Sec section={sec("changes")}>
        <p>We will post changes on this page and update the &ldquo;Last updated&rdquo; date and version above.</p>
      </Sec>

      <Sec section={sec("grievance")}>
        <p>
          {COMPANY.legalName}, {COMPANY.address}.
        </p>
        <p>
          Privacy contact and grievance contact: <a href={`mailto:${LEGAL.grievanceEmail}`}>{LEGAL.grievanceEmail}</a>. Put &ldquo;Grievance&rdquo; in the
          subject line. We will acknowledge and respond within {LEGAL.requestResponseDays} days.
        </p>
      </Sec>
    </LegalDoc>
  );
}
