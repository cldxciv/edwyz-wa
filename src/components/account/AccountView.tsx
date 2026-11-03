"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/app/PageHeader";
import { Button, Card, ErrorState, FormField, Input, Skeleton, apiFetch, toast } from "@/components/ui";
import { COMPANY } from "@/lib/config";
import { MAX_NAME, MAX_NEW_PASSWORD, MIN_NEW_PASSWORD, PASSWORD_CHANGED, RENAME_OWNER_ONLY, hasErrors, nameError, passwordErrors, passwordRefusal, type PasswordForm } from "./account-helpers";

type Me = {
  user: { id: string; email: string; name: string; emailVerified: boolean };
  workspace: { id: string; name: string; slug: string; role: string } | null;
  role: "owner" | "admin" | "agent";
};

const fail = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

function AccountSkeleton() {
  return (
    <div role="status" className="space-y-6">
      <span className="sr-only">Loading your account</span>
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-64 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

/** Your own name and password, and the workspace name for an owner. Open to every member from the account menu. */
export function AccountView() {
  const [me, setMe] = useState<Me | null>(null);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    try {
      setMe(await apiFetch<Me>("/api/auth/me"));
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const header = <PageHeader title="Your account" description="Your name, your password and the name of this workspace." />;
  if (loadError) {
    return (
      <div>
        {header}
        <ErrorState title="We could not load your account" message="Check your connection and try again." action={<Button variant="secondary" onClick={() => void load()}>Try again</Button>} />
      </div>
    );
  }
  if (!me) {
    return (
      <div>
        {header}
        <AccountSkeleton />
      </div>
    );
  }
  return (
    <div className="max-w-2xl space-y-6">
      {header}
      <ProfileCard user={me.user} />
      <PasswordCard />
      <WorkspaceCard workspace={me.workspace} isOwner={me.role === "owner"} />
    </div>
  );
}

function ProfileCard({ user }: { user: Me["user"] }) {
  const router = useRouter();
  const [name, setName] = useState(user.name);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const error = nameError(name, "your name");

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (error) return;
    setSaving(true);
    try {
      await apiFetch("/api/account/profile", { method: "PATCH", body: { name: name.trim() } });
      toast.success("Your name was saved.");
      setTouched(false);
      // The menu and the team list are drawn on the server: refresh them so the new name shows everywhere.
      router.refresh();
    } catch (err) {
      toast.error(`We could not save your name. ${fail(err, "Check your connection and try again.")}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card title="Your details" description="Your name is what teammates see in the inbox and the team list.">
      <form onSubmit={save} noValidate className="space-y-4">
        <FormField label="Your name" required error={touched ? error : null}>
          <Input maxLength={MAX_NAME} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
        </FormField>
        <div className="text-sm">
          <p className="font-medium">Email</p>
          <p className="break-all text-muted">{user.email}</p>
          <p className="mt-1 text-xs text-muted">To sign in with a different email address, write to {COMPANY.email}.</p>
        </div>
        <Button type="submit" variant="secondary" loading={saving}>
          Save name
        </Button>
      </form>
    </Card>
  );
}

const EMPTY_PASSWORDS: PasswordForm = { current: "", next: "", confirm: "" };

function PasswordCard() {
  const [form, setForm] = useState<PasswordForm>(EMPTY_PASSWORDS);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  // What the server refused (a wrong current password, a new one it will not take), shown under that field until it is edited.
  const [refused, setRefused] = useState<Partial<Record<keyof PasswordForm, string>>>({});
  const currentRef = useRef<HTMLInputElement>(null);
  const nextRef = useRef<HTMLInputElement>(null);
  const errors = passwordErrors(form);
  const show = (k: keyof PasswordForm) => (touched ? errors[k] : null) ?? refused[k] ?? null;
  const set = (k: keyof PasswordForm) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm({ ...form, [k]: e.target.value });
    if (refused[k]) setRefused({ ...refused, [k]: undefined });
  };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    setRefused({});
    if (hasErrors(errors)) return;
    setSaving(true);
    try {
      await apiFetch("/api/account/password", { method: "POST", body: { currentPassword: form.current, newPassword: form.next } });
      toast.success(PASSWORD_CHANGED);
      setForm(EMPTY_PASSWORDS);
      setTouched(false);
    } catch (err) {
      const refusal = passwordRefusal(err);
      if (refusal) {
        setRefused({ [refusal.field]: refusal.message });
        (refusal.field === "current" ? currentRef : nextRef).current?.focus();
      } else {
        toast.error(`We could not change your password. ${fail(err, "Check your connection and try again.")}`);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card title="Password" description="Changing your password signs you out on your other devices. This one stays signed in.">
      <form onSubmit={save} noValidate className="space-y-4">
        <FormField label="Current password" required error={show("current")}>
          <Input ref={currentRef} type="password" name="current-password" autoComplete="current-password" maxLength={MAX_NEW_PASSWORD} value={form.current} onChange={set("current")} />
        </FormField>
        <FormField label="New password" required error={show("next")} hint={`At least ${MIN_NEW_PASSWORD} characters. A short sentence is easy to remember and hard to guess.`}>
          <Input ref={nextRef} type="password" name="new-password" autoComplete="new-password" maxLength={MAX_NEW_PASSWORD} value={form.next} onChange={set("next")} />
        </FormField>
        <FormField label="Type the new password again" required error={show("confirm")}>
          <Input type="password" name="confirm-password" autoComplete="new-password" maxLength={MAX_NEW_PASSWORD} value={form.confirm} onChange={set("confirm")} />
        </FormField>
        <Button type="submit" loading={saving}>
          Change password
        </Button>
      </form>
    </Card>
  );
}

function WorkspaceCard({ workspace, isOwner }: { workspace: Me["workspace"]; isOwner: boolean }) {
  const router = useRouter();
  const [name, setName] = useState(workspace?.name ?? "");
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const error = nameError(name, "a name for the workspace");
  if (!workspace) return null;

  if (!isOwner) {
    return (
      <Card title="Workspace" description={RENAME_OWNER_ONLY}>
        <p className="text-sm">
          <span className="font-medium">Name: </span>
          {workspace.name}
        </p>
      </Card>
    );
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (error) return;
    setSaving(true);
    try {
      await apiFetch("/api/workspace", { method: "PATCH", body: { name: name.trim() } });
      toast.success("The workspace name was saved.");
      setTouched(false);
      router.refresh();
    } catch (err) {
      toast.error(`We could not rename the workspace. ${fail(err, "Check your connection and try again.")}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card title="Workspace" description="The name everyone in this workspace sees in the app and in emails from us.">
      <form onSubmit={save} noValidate className="space-y-4">
        <FormField label="Workspace name" required error={touched ? error : null}>
          <Input maxLength={MAX_NAME} autoComplete="organization" value={name} onChange={(e) => setName(e.target.value)} />
        </FormField>
        <Button type="submit" variant="secondary" loading={saving}>
          Save workspace name
        </Button>
      </form>
    </Card>
  );
}
