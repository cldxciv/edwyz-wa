import { pageMetadata } from "@/components/site/seo";
import { WEBHOOK_EVENTS } from "@/lib/integrations/events";
import { EVENT_CATALOG } from "@/lib/integrations/payloads";
import { Code, DocShell } from "../parts";

export const metadata = pageMetadata({
  title: "Webhooks",
  description: "The webhook events we send, their payloads, and how to verify that a delivery really came from Edwyz WA.",
  path: "/docs/webhooks",
});

const NODE = `import { createHmac, timingSafeEqual } from "node:crypto";

export function verify(secret, headers, rawBody) {
  const timestamp = headers["x-edwyz-timestamp"];
  const given = headers["x-edwyz-signature"];
  if (!timestamp || !given) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(timestamp + "." + rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}`;

const PY = `import hmac, hashlib, time

def verify(secret: str, headers: dict, raw_body: bytes) -> bool:
    ts = headers.get("x-edwyz-timestamp", "")
    given = headers.get("x-edwyz-signature", "")
    if not ts.isdigit() or abs(time.time() - int(ts)) > 300:
        return False
    msg = ts.encode() + b"." + raw_body
    expected = "sha256=" + hmac.new(secret.encode(), msg, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, given)`;

function EventSection({ event }: { event: (typeof EVENT_CATALOG)[number] }) {
  return (
    <article id={event.event} className="space-y-2 rounded-lg border border-border p-4">
      <h3 className="font-mono text-sm font-semibold">{event.event}</h3>
      <p>
        <strong>{event.title}.</strong> {event.when}
      </p>
      <ul>
        {event.fields.map((f) => (
          <li key={f.name}>
            <code>{f.name}</code> <span className="text-muted">({f.type})</span> {f.description}
          </li>
        ))}
      </ul>
      <Code label={`Sample ${event.event} data`}>{JSON.stringify(event.sample, null, 2)}</Code>
    </article>
  );
}

export default function WebhooksPage() {
  return (
    <DocShell title="Webhooks" intro="Subscriptions are created through the API or the app. Every delivery is signed with the secret returned when the subscription was created.">
      <h2>Subscribing</h2>
      <p>
        POST a public https URL and the event names to /webhooks. The response includes signing_secret once; store it. Available events: {WEBHOOK_EVENTS.join(", ")}. A
        subscription that fails repeatedly is switched to disabled; enable it again with a PUT.
      </p>
      <h2>What we send</h2>
      <p>A POST with a JSON body {`{ id, event, createdAt, data }`} and these headers:</p>
      <ul>
        <li>
          <code>x-edwyz-event</code>: the event name.
        </li>
        <li>
          <code>x-edwyz-delivery</code>: delivery id, the same across retries.
        </li>
        <li>
          <code>x-edwyz-timestamp</code>: seconds since the epoch when this attempt was signed.
        </li>
        <li>
          <code>x-edwyz-signature</code>: sha256= followed by the hex HMAC-SHA256 of the timestamp, a dot, and the exact raw body, keyed with your secret.
        </li>
      </ul>
      <p>Answer with any 2xx status within 10 seconds. Redirects are not followed. Failed deliveries are retried, so deduplicate on the id in the body.</p>
      <h2>Events</h2>
      <p>
        The <code>data</code> object of each event is shown below. Fields that can be missing are null, never absent. A person who messages you through a WhatsApp username has
        no phone number: use the contact&apos;s bsuid to recognise them.
      </p>
      <div className="space-y-4">
        {EVENT_CATALOG.map((e) => (
          <EventSection key={e.event} event={e} />
        ))}
      </div>
      <h2>Verify (Node.js)</h2>
      <Code>{NODE}</Code>
      <h2>Verify (Python)</h2>
      <Code>{PY}</Code>
      <p>Always compute the signature over the raw bytes you received, before any JSON parsing, compare in constant time, and reject timestamps more than five minutes old.</p>
    </DocShell>
  );
}
