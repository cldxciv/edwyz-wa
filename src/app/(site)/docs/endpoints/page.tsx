import { pageMetadata } from "@/components/site/seo";
import { COMPAT_BASE_PATH, ENDPOINTS, endpointScopes, type EndpointSpec, type Field } from "@/lib/compat/spec";
import { acceptedScopes } from "@/lib/integrations/scopes";
import { DocShell } from "../parts";

export const metadata = pageMetadata({ title: "API endpoint reference", description: "Every endpoint, its scope, parameters and response.", path: "/docs/endpoints" });

const groups = [...new Set(ENDPOINTS.map((e) => e.group))];

function Fields({ title, fields }: { title: string; fields?: readonly Field[] }) {
  if (!fields?.length) return null;
  return (
    <div className="mt-3">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h4>
      <ul className="mt-1 space-y-1">
        {fields.map((f) => (
          <li key={f.name}>
            <code>{f.name}</code> <span className="text-muted">({f.type}{f.required ? ", required" : ""})</span> {f.description}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Endpoint({ e }: { e: EndpointSpec }) {
  return (
    <article id={e.id} className="rounded-lg border border-border p-4">
      <h3 className="font-mono text-sm font-semibold">
        {e.method} {COMPAT_BASE_PATH}
        {e.path}
      </h3>
      <p className="mt-1">{e.summary}</p>
      <p className="mt-1 text-xs text-muted">
        {acceptedScopes(endpointScopes(e)).length === 1 ? "Scope " : "Any of these scopes: "}
        {acceptedScopes(endpointScopes(e)).map((s, i) => (
          <span key={s}>
            {i > 0 ? ", " : ""}
            <code>{s}</code>
          </span>
        ))}{" "}
        &middot; returns <code>{e.returns}</code>
        {e.paginated ? " (paginated)" : ""}
      </p>
      <Fields title="Query" fields={e.query} />
      <Fields title="Body" fields={e.body} />
    </article>
  );
}

export default function EndpointsPage() {
  return (
    <DocShell title="Endpoint reference" intro="Generated from the same table the server uses to register routes, so it always matches what is live. Path segments in braces are parameters.">
      {groups.map((g) => (
        <section key={g} aria-labelledby={`g-${g}`} className="space-y-3">
          <h2 id={`g-${g}`}>{g}</h2>
          {ENDPOINTS.filter((e) => e.group === g).map((e) => (
            <Endpoint key={e.id} e={e} />
          ))}
        </section>
      ))}
    </DocShell>
  );
}
