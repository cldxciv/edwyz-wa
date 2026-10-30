import { pageMetadata } from "@/components/site/seo";
import { ERROR_CODES } from "@/lib/compat/spec";
import { Code, DocShell } from "../parts";

export const metadata = pageMetadata({ title: "API errors", description: "The error shape and the status codes the API uses.", path: "/docs/errors" });

export default function ErrorsPage() {
  return (
    <DocShell title="Errors" intro="Failures use one shape on every endpoint. Messages are written for people; branch on the code.">
      <Code>{`{
  "ok": false,
  "error": { "code": "not_found", "message": "Contact not found." },
  "timestamp": "2026-10-27T10:15:00.000Z"
}`}</Code>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-border">
              <th className="py-2 pr-4">Status</th>
              <th className="py-2 pr-4">Code</th>
              <th className="py-2">Meaning</th>
            </tr>
          </thead>
          <tbody>
            {ERROR_CODES.map((c) => (
              <tr key={c.code} className="border-b border-border/50">
                <td className="py-1.5 pr-4">{c.status}</td>
                <td className="py-1.5 pr-4 font-mono">{c.code}</td>
                <td className="py-1.5">{c.meaning}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2>Cases worth handling</h2>
      <ul>
        <li>
          400 invalid_request when a list asks for more than 10,000 records through paging (page_number x page_size above 10,000). The message says so; narrow the query with filters instead.
          There are no cursors yet.
        </li>
        <li>
          422 unprocessable when a local_message_id you already used is sent again with a different body. Nothing is sent. Use a new id for a new message, or resend the original body to
          get the original result back.
        </li>
        <li>409 conflict when a send with the same local_message_id is still being recorded. Wait a few seconds and retry with the same id.</li>
        <li>401 unauthorized when the token was revoked, including automatically when its creator left the workspace or was disabled.</li>
        <li>403 forbidden with a message about suspension when the workspace is suspended; the token works again once it is reinstated.</li>
      </ul>
      <p>
        Template sends to several recipients answer 200 even if some are refused; check each item&apos;s errors in the recipients array and the top-level success flag.
      </p>
    </DocShell>
  );
}
