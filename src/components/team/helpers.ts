export type Role = "owner" | "admin" | "agent";

export const ROLE_INFO: Record<Role, { label: string; description: string }> = {
  owner: { label: "Owner", description: "Full control, including who is on the team and billing." },
  admin: { label: "Admin", description: "Manages settings, templates, broadcasts and the team's agents." },
  agent: { label: "Agent", description: "Replies to chats and works with contacts. Cannot change settings." },
};

export const roleLabel = (role: string): string => ROLE_INFO[role as Role]?.label ?? "Member";

export type Person = { userId: string; role: Role };

/** True for ?invite=1 (or true/yes). Used to open the invite dialog straight from a link or shortcut. */
export function shouldOpenInvite(value: string | string[] | null | undefined): boolean {
  const v = Array.isArray(value) ? value[0] : value;
  return ["1", "true", "yes"].includes((v ?? "").trim().toLowerCase());
}

export function emailError(value: string): string | null {
  const v = value.trim();
  if (!v) return "Enter their email address.";
  if (v.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) return "Enter a full email address, like name@company.com.";
  return null;
}

/** True when this person is the workspace's only owner. The server refuses to remove or demote them (lastOwnerGuard), so the page offers neither. */
export function isOnlyOwner(members: readonly Person[] | null | undefined, userId: string): boolean {
  const owners = (members ?? []).filter((m) => m.role === "owner");
  return owners.length === 1 && owners[0].userId === userId;
}

export const ONLY_OWNER_NOTE = "You are the only owner, so you can't leave or change your own role. Make someone else the owner first.";
export const NO_TRANSFER_CANDIDATE_NOTE = "Invite a teammate first. Once they join, you can make them the owner here.";
export const ALL_OWNERS_NOTE = "Everyone else here is already an owner.";

/** Why the hand-over picker is empty, or null when someone can take over. Pure. */
export function noTransferNote(members: readonly Person[], myId: string): string | null {
  const others = members.filter((m) => m.userId !== myId);
  if (others.some((m) => m.role !== "owner")) return null;
  return others.length === 0 ? NO_TRANSFER_CANDIDATE_NOTE : ALL_OWNERS_NOTE;
}

/** With `members`, the only owner can't be removed (not even by leaving), matching the server. */
export function canRemoveMember(me: Person | null, target: Person, members?: readonly Person[]): boolean {
  if (!me || me.role === "agent") return false;
  if (members && isOnlyOwner(members, target.userId)) return false;
  return me.role === "owner" || target.role === "agent" || target.userId === me.userId;
}

const RANK: Record<Role, number> = { agent: 1, admin: 2, owner: 3 };

export type ConfirmCopy = { title: string; body: string; confirmLabel: string; tone: "default" | "danger" };

/** Returns the confirmation to show before a role change, or null when the change is safe to apply straight away. */
export function roleChangeConfirm(me: Person | null, target: Person & { name: string }, next: Role): ConfirmCopy | null {
  if (next === target.role) return null;
  if (next === "owner") {
    return {
      title: `Make ${target.name} an owner?`,
      body: "Owners have full control, including removing other owners and changing anyone's role.",
      confirmLabel: "Make owner",
      tone: "default",
    };
  }
  if (me && me.userId === target.userId && RANK[next] < RANK[target.role]) {
    return {
      title: `Change your own role to ${roleLabel(next).toLowerCase()}?`,
      body: "You will lose some of your access right away, and only an owner can give it back.",
      confirmLabel: `Change to ${roleLabel(next).toLowerCase()}`,
      tone: "danger",
    };
  }
  return null;
}

export function removeConfirm(me: Person | null, target: Person & { name: string }): ConfirmCopy {
  const self = me?.userId === target.userId;
  return self
    ? { title: "Leave this workspace?", body: "You will lose access right away. Another owner or admin would need to invite you again.", confirmLabel: "Leave workspace", tone: "danger" }
    : { title: `Remove ${target.name}?`, body: `${target.name} will lose access to this workspace right away. You can invite them again later.`, confirmLabel: "Remove from team", tone: "danger" };
}

const DAY = 86_400_000;

export function describeExpiry(expiresAt: string | Date, now: Date = new Date()): { expired: boolean; label: string } {
  const left = new Date(expiresAt).getTime() - now.getTime();
  if (Number.isNaN(left)) return { expired: false, label: "Unknown" };
  if (left <= 0) return { expired: true, label: "Expired. Create a new invite." };
  const days = Math.ceil(left / DAY);
  if (days <= 1) return { expired: false, label: "Expires in less than a day" };
  return { expired: false, label: `Expires in ${days} days` };
}
