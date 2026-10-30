import { requireAdminPage } from "@/lib/admin/page";
import { audit } from "@/lib/auth/audit";
import { listUsers, USER_PAGE_SIZE } from "@/lib/admin/users";
import { ActionForm } from "@/components/admin/ActionForm";
import { AdminShell, Pager, when } from "@/components/admin/AdminShell";
import { adminPageMetadata, emptyUsers } from "@/components/admin/helpers";
import { PageHeader } from "@/components/app/PageHeader";
import { Badge, Button, buttonSizes, buttonVariants, Card, cn, EmptyState, Field, Input } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = adminPageMetadata("Users");

export default async function UsersPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  const admin = await requireAdminPage();
  const sp = await searchParams;
  const q = (sp.q ?? "").slice(0, 100);
  const page = Math.max(1, Number(sp.page) || 1);
  await audit({ userId: admin.userId, action: "admin.view", meta: { page: "users" } });
  const { total, items } = await listUsers({ q, page });
  const none = emptyUsers(q);

  return (
    <AdminShell email={admin.email} current="/admin/users">
      <PageHeader title="Users" description="People who have signed up. There is no way to sign in as a user. To help someone get back in, create a password reset link for them." />
      <form role="search" aria-label="Find users" className="mb-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <Field label="Search users" htmlFor="q">
          <Input id="q" name="q" type="search" defaultValue={q} placeholder="Email address or name" maxLength={100} />
        </Field>
        <div className="flex gap-2">
          <Button type="submit">Search</Button>
          {q && (
            <a href="/admin/users" className={cn("inline-flex items-center justify-center rounded-full font-semibold", buttonVariants.ghost, buttonSizes.md)}>
              Clear
            </a>
          )}
        </div>
      </form>
      {items.length === 0 ? (
        <EmptyState title={none.title} body={none.body} />
      ) : (
        <ul className="space-y-4">
          {items.map((u) => {
            const endpoint = `/api/admin/users/${u.id}`;
            return (
              <li key={u.id}>
                <Card>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="font-semibold">{u.name}</h2>
                      <p className="break-all text-sm text-muted">{u.email}</p>
                      <p className="text-xs text-muted">Joined {when(u.createdAt)}</p>
                      <p className="mt-2 text-sm">{u.memberships.length === 0 ? "Not in any workspace" : u.memberships.map((m) => `${m.tenant.name} (${m.role})`).join(", ")}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {u.emailVerifiedAt ? <Badge tone="good" dot>Email verified</Badge> : <Badge tone="warn" dot>Email not verified</Badge>}
                      {u.disabledAt && <Badge tone="bad" dot>Disabled</Badge>}
                    </div>
                  </div>
                  <details className="mt-3 border-t border-border pt-3">
                    <summary className="flex min-h-10 cursor-pointer items-center text-sm font-medium text-accent-ink underline underline-offset-2">Manage this user</summary>
                    <div className="mt-3 space-y-3">
                      {u.disabledAt ? (
                        <ActionForm endpoint={endpoint} label="Enable user" body={{ action: "enable" }} description="Lets this person sign in again." />
                      ) : (
                        <ActionForm endpoint={endpoint} label="Disable user" danger body={{ action: "disable" }} confirmText={u.email} description="Blocks sign-in and signs the person out everywhere." />
                      )}
                      <ActionForm endpoint={endpoint} label="Sign out everywhere" body={{ action: "force_signout" }} description="Ends all of this person's sessions. They can sign in again." />
                      {!u.emailVerifiedAt && <ActionForm endpoint={endpoint} label="Resend verification email" body={{ action: "resend_verification" }} description="Sends a new email asking them to confirm their address." />}
                      {!u.emailVerifiedAt && <ActionForm endpoint={endpoint} label="Mark email as verified" body={{ action: "mark_verified" }} description="Use only after you have confirmed the person owns this address another way." />}
                      <ActionForm endpoint={endpoint} label="Create password reset link" body={{ action: "reset_link" }} description="You will see the link once. It expires in 1 hour." />
                    </div>
                  </details>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
      <Pager base={`/admin/users?q=${encodeURIComponent(q)}`} page={page} total={total} size={USER_PAGE_SIZE} />
    </AdminShell>
  );
}
