import { pageMetadata } from "@/components/site/seo";
import { IDEMPOTENCY_HOURS, MAX_PAGE_SIZE, MAX_TEMPLATE_RECIPIENTS, RATE_LIMIT_REQUESTS, RATE_LIMIT_WINDOW_SECONDS } from "@/lib/compat/spec";
import { DocShell } from "../parts";

export const metadata = pageMetadata({ title: "API rate limits", description: "Request limits per token and how to stay within them.", path: "/docs/rate-limits" });

export default function RateLimitsPage() {
  return (
    <DocShell title="Rate limits" intro="Limits protect shared infrastructure and apply per token, not per workspace.">
      <ul>
        <li>
          Each token may make {RATE_LIMIT_REQUESTS} requests in any {RATE_LIMIT_WINDOW_SECONDS}-second window. Beyond that the API answers 429 with a Retry-After header (seconds).
        </li>
        <li>Lists return at most {MAX_PAGE_SIZE} items per page.</li>
        <li>
          Paging is offset based and capped: page_number x page_size must not exceed 10,000. A request beyond that answers 400 with the message &quot;page_number x page_size must not
          exceed 10000. Narrow the list with filters instead of paging that deep.&quot; Cursors do not exist yet, so to read more than 10,000 records narrow the query with the
          endpoint&apos;s filters (for example tag or search on contacts, or status on conversations, templates and broadcast recipients; the Endpoints page lists each one) and read each slice separately. When a list reaches the
          cap the response sets window_exhausted to true and has_more to false even though more records exist.
        </li>
        <li>One template send call accepts at most {MAX_TEMPLATE_RECIPIENTS} recipients. Send several calls for larger audiences, or use a broadcast in the app.</li>
        <li>
          A local_message_id is remembered for {IDEMPOTENCY_HOURS}{" "}hours per recipient, so a retry after a timeout never sends twice. Reusing the same local_message_id with a different body answers 422 and sends nothing; use a new local_message_id for a
          different message. If an earlier call with the id is still being recorded the API answers 409; wait a few seconds and retry with the same id. A call that never
          finished is treated as abandoned after about a minute, and the next retry sends normally.
        </li>
        <li>WhatsApp&apos;s own limits (24-hour window, your number&apos;s messaging tier, template approval) are enforced separately and can refuse a send even when the API accepts the call.</li>
      </ul>
      <p>When you receive 429, wait for Retry-After, then retry with the same local_message_id values.</p>
    </DocShell>
  );
}
