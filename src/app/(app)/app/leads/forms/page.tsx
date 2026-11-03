import { cookies } from "next/headers";
import { FormsView, type HiddenForm } from "@/components/leads/FormsView";
import { canBuildForms } from "@/components/promote/form-builder-helpers";
import { getActor } from "@/lib/auth";
import { listForms } from "@/lib/leads/service";
import { promoteEnabled } from "@/lib/promote/flags";
import { accessFor } from "@/lib/promote/route-guard";
import type { Actor } from "@/lib/tenancy";

export const dynamic = "force-dynamic";
export const metadata = { title: "Lead forms" };

type BuilderView = { canBuild: boolean; hiddenForms: HiddenForm[] };

/**
 * Whether this member may make, import, test, copy and hide forms here (docs/IG-PAGE-ADS-SPEC.md 7.1): Instagram and Facebook
 * Page ads are open to them (promoteAccess) and they are an owner or admin. Nothing is looked up while the feature is off.
 * Such a member also gets the workspace's hidden forms, so "Hidden forms (n)" can show each one again (D13: hidden here only;
 * a hidden form still takes in leads with its consent settings, so it must never be out of reach).
 */
async function builderView(): Promise<BuilderView> {
  const none: BuilderView = { canBuild: false, hiddenForms: [] };
  if (promoteEnabled() === "off") return none;
  let actor: Actor;
  try {
    const jar = await cookies();
    const cookie = jar
      .getAll()
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
    actor = await getActor(new Request("http://internal/", { headers: { cookie } }));
    if (!canBuildForms(await accessFor(actor))) return none;
  } catch {
    return none;
  }
  try {
    const all = await listForms(actor.tenantId, { includeHidden: true });
    const hiddenForms = all
      .filter((f) => f.hidden)
      .map((f) => ({ id: f.id, metaFormId: f.metaFormId, name: f.name, origin: f.origin, consentAssumed: f.consentAssumed }));
    return { canBuild: true, hiddenForms };
  } catch {
    // The page still works; the hidden list comes back on the next visit.
    return { canBuild: true, hiddenForms: [] };
  }
}

export default async function LeadFormsPage() {
  const view = await builderView();
  return <FormsView canBuild={view.canBuild} hiddenForms={view.hiddenForms} />;
}
