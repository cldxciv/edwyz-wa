import { pageMetadata } from "@/components/site/seo";
import { ENDPOINTS, endpointScopes } from "@/lib/compat/spec";
import { acceptedScopes, API_SCOPES } from "@/lib/integrations/scopes";
import { Code, DocShell } from "../parts";

export const metadata = pageMetadata({ title: "API authentication", description: "Create a token, send it as a bearer header and choose scopes.", path: "/docs/authentication" });

export default function AuthPage() {
  return (
    <DocShell title="Authentication" intro="Every request carries a bearer token created in your workspace. Tokens belong to one workspace and can only see its data.">
      <h2>Create a token</h2>
      <p>
        In the app open Settings, then API and webhooks, and create a key. Choose only the scopes the integration needs. The token starts with wak_ and is shown once; we store only a
        hash, so a lost token must be replaced. Revoke a key at any time and it stops working immediately.
      </p>
      <h2>When a token stops working</h2>
      <p>A token is tied to the person who created it and to their workspace. It is refused with 401 when any of these is true. For the first three the key is also revoked for good:</p>
      <ul>
        <li>the person who created it is removed from the workspace, or leaves it;</li>
        <li>that person&apos;s account is disabled or erased;</li>
        <li>the token is revoked in the app;</li>
        <li>the workspace is closed or deleted (the key is refused; its record is removed when the workspace&apos;s data is erased).</li>
      </ul>
      <p>
        Revocation is permanent. If the person is invited back or their account is enabled again, create a new token; the old one stays dead. While a workspace is suspended
        its tokens answer 403 with a message saying so, and work again when the workspace is reinstated. Changing a member&apos;s role does not affect their tokens: a token never
        has more than agent-level access plus its own scopes.
      </p>
      <h2>Send it</h2>
      <Code>{`Authorization: Bearer wak_your_token`}</Code>
      <p>Cookies are ignored on this API. A missing, malformed or revoked token answers 401.</p>
      <h2>Scopes</h2>
      <p>
        A token that holds none of the scopes an endpoint accepts answers 403 and the message names them, for example &quot;This API key needs one of these scopes: messages:write,
        conversations:write.&quot; Some scopes include others: a write scope also allows the matching reads. Available scopes: {API_SCOPES.join(", ")}.
      </p>
      <p>
        <strong>Good to know:</strong>{" "}a key with conversations:write can also send free-form session text inside the 24-hour window, because replying is part of managing a chat.
        Keys created before this was added keep working the same way, so review the keys you hand to other systems and create a new one with only the scopes it needs.
        Template sends always need messages:write.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-border">
              <th className="py-2 pr-4">Endpoint</th>
              <th className="py-2">Accepted scopes</th>
            </tr>
          </thead>
          <tbody>
            {ENDPOINTS.map((e) => (
              <tr key={e.id} className="border-b border-border/50">
                <td className="py-1.5 pr-4 font-mono">
                  {e.method} {e.path}
                </td>
                <td className="py-1.5 font-mono">{acceptedScopes(endpointScopes(e)).join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2>Writes and billing</h2>
      <p>Write requests are refused with 402 when the trial or subscription has ended, and with 403 while the workspace is suspended. Reads keep working.</p>
    </DocShell>
  );
}
