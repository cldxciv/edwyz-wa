import type { Metadata } from "next";
import { LegalPage } from "@/components/shell";
import { COMPANY } from "@/lib/config";
import { getDeletionRequest } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Data deletion status", robots: { index: false } };

export default async function DeletionStatusPage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const { code: raw } = await searchParams;
  const code = typeof raw === "string" ? raw.trim().toLowerCase() : undefined;
  const record = code ? await getDeletionRequest(code).catch(() => null) : null;

  return (
    <LegalPage title="Data deletion status">
      {record ? (
        <p>
          We received your request on {new Date(record.receivedAt).toUTCString()}. Status: <strong>{record.status}</strong>. We aim to complete
          deletion within 30 days.{record.status === "completed" && record.completedAt ? ` Completed on ${new Date(record.completedAt).toUTCString()}.` : ""} Questions: <a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a>.
        </p>
      ) : (
        <>
          <p>
            {code ? "We could not find a request with that code. Check it and try again, or email " : "Enter the confirmation code Facebook showed you, or email "}
            <a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a>.
          </p>
          <form method="get" action="/data-deletion/status" className="mt-4 flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="code" className="block text-sm font-medium">
                Confirmation code
              </label>
              <input
                id="code"
                name="code"
                type="text"
                required
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={64}
                defaultValue={code ?? ""}
                className="mt-1 w-72 max-w-full rounded-lg border border-border-strong bg-raised px-3 py-2 font-mono text-sm"
              />
            </div>
            <button type="submit" className="min-h-10 rounded-lg bg-accent px-4 text-sm font-medium text-on-accent shadow-raised hover:bg-accent-strong">
              Check status
            </button>
          </form>
        </>
      )}
    </LegalPage>
  );
}
