import { createHash } from "node:crypto";
import { getActor } from "@/lib/auth";
import { siteUrl } from "@/lib/config";
import { completeConnect, CONNECT_POPUP, splitConnectState, type ConnectPopupOutcome } from "@/lib/meta-connect/service";
import { errorResponse, HttpError, requireRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/**
 * next.config.ts leaves this one /api path out of its locked-down policy, because Next would keep that header and drop the
 * closing page's own. So every answer from here carries a policy of its own: this one, or the closing page's, which adds only
 * the hash of its script.
 */
const CALLBACK_LOCKED_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const back = (query: string) =>
  new Response(null, { status: 303, headers: { Location: `${siteUrl()}/app/settings/connections?${query}`, "Cache-Control": "no-store", "Content-Security-Policy": CALLBACK_LOCKED_CSP } });

/** Holds whether or not the page's script could close the window. */
const POPUP_TEXT: Record<ConnectPopupOutcome, string> = {
  connected: "Facebook is connected. You can close this window.",
  cancelled: "Facebook was closed before it finished, so nothing changed. You can close this window.",
  failed: "Facebook could not finish connecting. Go back to Edwyz and try again.",
};

/** JSON for inside a <script>: no "<", so a value can never close the script element. */
const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");
const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The page a popup attempt ends on (docs/EDDY-SPEC.md 12.1a decision 11, docs/IG-PAGE-ADS-SPEC.md 3.2 and D20). It tells the
 * opener the outcome three ways: postMessage to this site's own origin, a BroadcastChannel, and the localStorage key
 * CONNECT_POPUP.storage (the opener's storage event hears it even when the browser cut window.opener). Then it closes itself;
 * a window the browser won't let it close goes on to the same Connections page the full-page redirect uses. It carries only
 * the outcome word (and, in storage, the time it was written), never Meta's error text, a code or a token.
 *
 * The script is allowed by its own hash; next.config.ts leaves this path out of its /api policy so that this one applies
 * (Next keeps a header the config set and drops the route's). Completion still never depends on this script or on
 * window.opener: the opener also reads the outcome from the meta tag once the popup is back on this origin, and polls the
 * connections list, and either way it closes the window itself (useFacebookLoginPopup.ts).
 */
function popupPage(outcome: ConnectPopupOutcome): Response {
  const site = siteUrl();
  const origin = new URL(site).origin;
  const fallback = `${site}/app/settings/connections?status=${outcome}`;
  const message = { source: CONNECT_POPUP.source, outcome };
  const script =
    `(function(){var m=${scriptJson(message)},o=${scriptJson(origin)};` +
    `try{if(window.opener&&!window.opener.closed)window.opener.postMessage(m,o)}catch(e){}` +
    `try{var c=new BroadcastChannel(${scriptJson(CONNECT_POPUP.channel)});c.postMessage(m);c.close()}catch(e){}` +
    `try{window.localStorage.setItem(${scriptJson(CONNECT_POPUP.storage)},JSON.stringify({source:m.source,outcome:m.outcome,at:Date.now()}))}catch(e){}` +
    `if(window.opener){window.close()}else{try{window.close()}catch(e){}setTimeout(function(){location.replace(${scriptJson(fallback)})},400)}})();`;
  const hash = createHash("sha256").update(script, "utf8").digest("base64");
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">` +
    `<meta name="color-scheme" content="light dark"><meta name="${CONNECT_POPUP.meta}" content="${outcome}">` +
    `<title>Edwyz</title></head>` +
    `<body style="font-family:system-ui,sans-serif;margin:24px;line-height:1.5">` +
    `<p role="status">${POPUP_TEXT[outcome]}</p><p><a href="${attr(fallback)}">Back to Edwyz</a></p>` +
    `<script>${script}</script></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": CALLBACK_LOCKED_CSP.replace("default-src 'none';", `default-src 'none'; script-src 'sha256-${hash}';`),
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * Facebook Login for Business redirects the browser here with ?code and ?state (or ?error when the user cancels). A popup
 * attempt (its state ends with the popup marker) gets the small closing page; every other attempt keeps the full-page
 * redirect to the Connections page, which is also the fallback when the browser blocked the popup.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const { popup } = splitConnectState(params.get("state"));
  const finish = (outcome: ConnectPopupOutcome) => (popup ? popupPage(outcome) : back(`status=${outcome}`));
  try {
    const actor = await getActor(request);
    requireRole(actor, "admin");
    if (params.get("error")) return finish("cancelled");
    const code = params.get("code");
    if (!code) throw new HttpError(400, "Missing authorization code.");
    await completeConnect(actor, code, params.get("state"));
    return finish("connected");
  } catch (e) {
    if (e instanceof HttpError && e.status !== 401 && e.status !== 403) return finish("failed");
    // In a popup the member is on a page of its own: tell the opener it failed rather than show raw JSON.
    if (popup) return popupPage("failed");
    const res = errorResponse(e);
    res.headers.set("Content-Security-Policy", CALLBACK_LOCKED_CSP);
    return res;
  }
}
