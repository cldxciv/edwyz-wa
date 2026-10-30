import { pageMetadata } from "@/components/site/seo";
import { siteUrl } from "@/lib/config";
import { COMPAT_BASE_PATH, ENDPOINTS } from "@/lib/compat/spec";
import { Code, DocShell } from "./parts";

export const metadata = pageMetadata({
  title: "API documentation",
  description: "A REST API for contacts, conversations, messages, templates, broadcasts and webhooks, with an OpenAPI 3.1 document.",
  path: "/docs",
});

export default function DocsHome() {
  return (
    <DocShell
      title="Edwyz WA compatibility API"
      intro="A JSON REST API for contacts, session and template messages, broadcasts and webhooks. Its paths and field names follow the common v3 convention (snake_case JSON, page_number and page_size, custom_params), so HTTP steps in Zapier, Make or n8n are easy to point at it. Recipes built for an older, differently shaped API need their paths and field names changed."
    >
      <h2>Base URL</h2>
      <Code>{`${siteUrl()}${COMPAT_BASE_PATH}`}</Code>
      <h2>Conventions</h2>
      <ul>
        <li>Requests and responses are JSON with snake_case field names. Send a Content-Type: application/json header on writes; bodies are limited to 64 KB.</li>
        <li>Every success response contains &quot;ok&quot;: true. Every failure contains &quot;ok&quot;: false and an error object with a code and a message.</li>
        <li>
          List endpoints take page_number (starting at 1) and page_size (1 to 100) and answer with the items under a named key plus page_number, page_size, total and
          has_more.
        </li>
        <li>
          A contact can be addressed in a path by phone number (digits with country code, plus sign optional), by contact id, or as external_id:&lt;your id&gt;.
        </li>
        <li>Contacts without a phone number are returned with phone_number set to null. They can be read, tagged and updated, but not messaged.</li>
        <li>Sending is idempotent when you pass local_message_id: repeating it for the same recipient within 24 hours returns the first result and sends nothing.</li>
      </ul>
      <h2>First request</h2>
      <Code>{`curl "${siteUrl()}${COMPAT_BASE_PATH}/contacts?page_size=5" \\
  -H "Authorization: Bearer wak_your_token"`}</Code>
      <p>
        The API offers {ENDPOINTS.length} endpoints. The <a href="/docs/endpoints">reference</a> is generated from the same table the server uses to register them.
        For code generators and API clients, download the <a href="/docs/openapi.json">OpenAPI 3.1 document</a>; it also describes the webhook events.
      </p>
      <h2>Messaging rules still apply</h2>
      <p>
        Free-form messages need an open 24-hour customer service window; outside it send an approved template. You are responsible for having the recipient&apos;s consent
        before sending marketing templates, and people who opted out cannot be messaged. A contact is addressed by phone number, or by the
        WhatsApp user id (bsuid) when they have messaged you through a username and no phone number is known. A contact with neither cannot be messaged.
        A send is accepted when we have queued it; delivery and read receipts follow as message.status events.
      </p>
    </DocShell>
  );
}
