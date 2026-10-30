"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "@/components/app/PageHeader";
import { BusyButton } from "@/components/integrations/BusyButton";
import { Alert, Badge, Button, DataTable, EmptyState, ErrorState, Select, StatusPill, apiFetch, confirm, toast, type Column } from "@/components/ui";
import { InviteDialog } from "./InviteDialog";
import { TransferOwnershipDialog } from "./TransferOwnershipDialog";
import { ROLE_INFO, canRemoveMember, describeExpiry, removeConfirm, roleChangeConfirm, roleLabel, type Role } from "./helpers";

type Me = { user: { id: string }; role: Role };
type Member = { userId: string; email: string; name: string; role: Role };
type Invite = { id: string; email: string; role: Role; expiresAt: string };

const touch = "max-sm:min-h-10";
const fail = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
const TEAM_PATH = "/app/settings/team";

/**
 * Role picker for one person. Picking a role only changes the box; nothing is sent until "Change role" is pressed, so
 * arrow keys and screen reader browsing never change anyone's access by accident. Focus returns to the box afterwards.
 */
function RoleCell({ member, busy, onApply }: { member: Member; busy: boolean; onApply: (role: Role) => Promise<unknown> }) {
  const [pending, setPending] = useState<Role>(member.role);
  const selectRef = useRef<HTMLSelectElement>(null);
  useEffect(() => setPending(member.role), [member.role]);
  const changed = pending !== member.role;

  async function apply() {
    await onApply(pending);
    selectRef.current?.focus();
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        ref={selectRef}
        aria-label={`Role for ${member.name}`}
        aria-busy={busy || undefined}
        value={pending}
        className="max-w-40"
        onChange={(e) => {
          if (!busy) setPending(e.target.value as Role);
        }}
      >
        {/* Owner is only offered to someone who already is one; making an owner goes through Transfer ownership (it asks for a password). */}
        {(Object.keys(ROLE_INFO) as Role[]).filter((r) => r !== "owner" || member.role === "owner").map((r) => (
          <option key={r} value={r}>
            {ROLE_INFO[r].label}
          </option>
        ))}
      </Select>
      {changed && (
        <BusyButton size="sm" variant="secondary" className={touch} busy={busy} onClick={() => void apply()}>
          Change role<span className="sr-only"> for {member.name}</span>
        </BusyButton>
      )}
    </div>
  );
}

export function TeamView({ openInviteOnLoad = false }: { openInviteOnLoad?: boolean }) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [transferTo, setTransferTo] = useState<string>("");
  const [transferOpen, setTransferOpen] = useState(false);
  const membersHeading = useRef<HTMLHeadingElement>(null);
  const invitesHeading = useRef<HTMLHeadingElement>(null);

  const canManage = me?.role === "owner" || me?.role === "admin";
  const isOwner = me?.role === "owner";
  const person = useMemo(() => (me ? { userId: me.user.id, role: me.role } : null), [me]);

  const load = useCallback(async () => {
    try {
      const who = await apiFetch<Me>("/api/auth/me");
      const [m, inv] = await Promise.all([
        apiFetch<{ members: Member[] }>("/api/workspace/members"),
        who.role === "agent" ? Promise.resolve({ invites: [] as Invite[] }) : apiFetch<{ invites: Invite[] }>("/api/workspace/invites"),
      ]);
      setMe(who);
      setMembers(m.members);
      setInvites(inv.invites);
      setLoadError(null);
    } catch (e) {
      setLoadError(fail(e, "Check your connection and try again."));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Opens whenever the link carries ?invite=1. Closing the dialog removes the parameter, so the same command works again.
  useEffect(() => {
    if (openInviteOnLoad && canManage) setInviteOpen(true);
  }, [openInviteOnLoad, canManage]);

  const closeInvite = useCallback(() => {
    setInviteOpen(false);
    if (openInviteOnLoad) router.replace(TEAM_PATH, { scroll: false });
  }, [openInviteOnLoad, router]);

  const act = useCallback(
    async (id: string, action: () => Promise<unknown>, success: string, failure: string, reload = true): Promise<boolean> => {
      setBusyId(id);
      try {
        await action();
        toast.success(success);
        if (reload) await load();
        return true;
      } catch (e) {
        toast.error(failure, { description: fail(e, "Please try again.") });
        return false;
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  const changeRole = useCallback(
    async (m: Member, next: Role): Promise<boolean> => {
      const copy = roleChangeConfirm(person, m, next);
      if (copy && !(await confirm(copy))) return false;
      return act(m.userId, () => apiFetch(`/api/workspace/members/${m.userId}`, { method: "PATCH", body: { role: next } }), `${m.name} is now ${roleLabel(next).toLowerCase()}`, `We could not change the role for ${m.name}`);
    },
    [person, act],
  );

  const remove = useCallback(
    async (m: Member) => {
      if (!(await confirm(removeConfirm(person, m)))) return;
      const leaving = m.userId === person?.userId;
      const ok = await act(
        m.userId,
        () => apiFetch(`/api/workspace/members/${m.userId}`, { method: "DELETE" }),
        leaving ? "You left this workspace" : `${m.name} was removed`,
        leaving ? "We could not remove you from this workspace" : `We could not remove ${m.name}`,
        !leaving,
      );
      if (!ok) return;
      if (leaving) window.setTimeout(() => window.location.assign("/app"), 1200);
      else membersHeading.current?.focus();
    },
    [person, act],
  );

  const revoke = useCallback(
    async (i: Invite) => {
      const ok = await confirm({
        title: `Cancel the invite for ${i.email}?`,
        body: "The link they received will stop working.",
        confirmLabel: "Cancel invite",
        cancelLabel: "Keep invite",
        tone: "danger",
      });
      if (!ok) return;
      if (await act(i.id, () => apiFetch(`/api/workspace/invites/${i.id}`, { method: "DELETE" }), "Invite canceled", "We could not cancel the invite")) invitesHeading.current?.focus();
    },
    [act],
  );

  const memberColumns = useMemo<Column<Member>[]>(
    () => [
      {
        key: "name",
        header: "Name",
        primary: true,
        cell: (m) => (
          <span className="inline-flex flex-wrap items-center gap-2 font-medium">
            {m.name}
            {m.userId === me?.user.id && <Badge>You</Badge>}
          </span>
        ),
      },
      { key: "email", header: "Email", cell: (m) => <span className="break-all text-muted">{m.email}</span> },
      {
        key: "role",
        header: "Role",
        cell: (m) =>
          isOwner ? <RoleCell member={m} busy={busyId === m.userId} onApply={(next) => changeRole(m, next)} /> : <Badge tone={m.role === "agent" ? "neutral" : "info"}>{roleLabel(m.role)}</Badge>,
      },
      ...(canManage
        ? [
            {
              key: "actions",
              header: "Actions",
              srOnlyHeader: true,
              align: "right" as const,
              cell: (m: Member) =>
                person && canRemoveMember(person, m) ? (
                  <BusyButton variant="secondary" size="sm" className={touch} busy={busyId === m.userId} onClick={() => void remove(m)}>
                    {m.userId === me?.user.id ? "Leave workspace" : "Remove"}
                    {m.userId !== me?.user.id && <span className="sr-only"> {m.name}</span>}
                  </BusyButton>
                ) : null,
            },
          ]
        : []),
    ],
    [me, isOwner, canManage, busyId, person, changeRole, remove],
  );

  const inviteColumns = useMemo<Column<Invite>[]>(
    () => [
      { key: "email", header: "Email", primary: true, cell: (i) => <span className="break-all font-medium">{i.email}</span> },
      { key: "role", header: "Role", cell: (i) => <Badge tone={i.role === "agent" ? "neutral" : "info"}>{roleLabel(i.role)}</Badge> },
      {
        key: "status",
        header: "Status",
        cell: (i) => {
          const exp = describeExpiry(i.expiresAt);
          return (
            <span className="inline-flex flex-wrap items-center gap-2">
              <StatusPill status={exp.expired ? "expired" : "pending"} label={exp.expired ? "Expired" : "Waiting to join"} />
              <span className="text-xs text-muted">{exp.label}</span>
            </span>
          );
        },
      },
      {
        key: "actions",
        header: "Actions",
        srOnlyHeader: true,
        align: "right",
        cell: (i) => (
          <BusyButton variant="secondary" size="sm" className={touch} busy={busyId === i.id} onClick={() => void revoke(i)}>
            Cancel invite<span className="sr-only"> for {i.email}</span>
          </BusyButton>
        ),
      },
    ],
    [busyId, revoke],
  );

  if (loadError && !members) {
    return (
      <div className="max-w-4xl">
        <PageHeader title="Team" description="People who can use this workspace and what they can do." />
        <ErrorState title="We could not load your team" message={loadError} action={<Button onClick={() => void load()}>Try again</Button>} />
      </div>
    );
  }

  const loading = !members || !me;

  return (
    <div className="max-w-4xl space-y-8">
      <PageHeader
        title="Team"
        description="People who can use this workspace and what they can do."
        actions={canManage ? <Button onClick={() => setInviteOpen(true)}>Invite teammate</Button> : undefined}
      />

      {me?.role === "agent" && <Alert tone="info">Owners and admins manage the team. You can see who is here, but you cannot invite or remove people.</Alert>}
      {loadError && members && (
        <Alert
          tone="warn"
          action={
            <Button size="sm" variant="secondary" onClick={() => void load()}>
              Refresh
            </Button>
          }
        >
          We could not refresh the list. What you see may be out of date.
        </Alert>
      )}

      <section aria-labelledby="members-heading">
        <h2 id="members-heading" ref={membersHeading} tabIndex={-1} className="mb-3 text-lg font-semibold">
          People in this workspace
        </h2>
        {isOwner && <p className="-mt-1 mb-3 text-sm text-muted">To change someone&apos;s role, pick a new role, then select Change role.</p>}
        <DataTable caption="People in this workspace" columns={memberColumns} rows={members ?? []} rowKey={(m) => m.userId} loading={loading} skeletonRows={3} />
      </section>

      <section aria-labelledby="roles-heading">
        <h2 id="roles-heading" className="mb-3 text-lg font-semibold">What each role can do</h2>
        <dl className="grid gap-3 sm:grid-cols-3">
          {(Object.keys(ROLE_INFO) as Role[]).map((r) => (
            <div key={r} className="rounded-lg border border-border p-3">
              <dt className="font-medium">{ROLE_INFO[r].label}</dt>
              <dd className="mt-1 text-sm text-muted">{ROLE_INFO[r].description}</dd>
            </div>
          ))}
        </dl>
      </section>

      {canManage && (
        <section aria-labelledby="invites-heading">
          <h2 id="invites-heading" ref={invitesHeading} tabIndex={-1} className="mb-3 text-lg font-semibold">
            Invites waiting to be accepted
          </h2>
          <DataTable
            caption="Pending invites"
            columns={inviteColumns}
            rows={invites}
            rowKey={(i) => i.id}
            loading={loading}
            skeletonRows={2}
            empty={
              <EmptyState
                compact
                title="No pending invites"
                body="People you invite show up here until they join or the invite expires."
                action={
                  <Button variant="secondary" onClick={() => setInviteOpen(true)}>
                    Invite teammate
                  </Button>
                }
              />
            }
          />
        </section>
      )}

      {isOwner && (
        <section aria-labelledby="transfer-heading" className="rounded-lg border border-border p-4">
          <h2 id="transfer-heading" className="text-lg font-semibold">Hand over this workspace</h2>
          <p className="mt-1 text-sm text-muted">Make someone else the owner. You will become an admin unless you choose to stay an owner too.</p>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <Select aria-label="New owner" value={transferTo} className="max-w-64" onChange={(e) => setTransferTo(e.target.value)}>
              <option value="">Choose a teammate</option>
              {(members ?? []).filter((m) => m.userId !== me?.user.id && m.role !== "owner").map((m) => (
                <option key={m.userId} value={m.userId}>{m.name}</option>
              ))}
            </Select>
            <Button variant="secondary" className={touch} disabled={!transferTo} onClick={() => setTransferOpen(true)}>Transfer ownership</Button>
          </div>
        </section>
      )}

      {transferOpen && members?.find((m) => m.userId === transferTo) && (
        <TransferOwnershipDialog
          candidate={{ userId: transferTo, name: members.find((m) => m.userId === transferTo)!.name }}
          onClose={() => setTransferOpen(false)}
          onDone={() => {
            setTransferTo("");
            void load();
          }}
        />
      )}

      {inviteOpen && <InviteDialog isOwner={!!isOwner} onClose={closeInvite} onCreated={() => void load()} />}
    </div>
  );
}
