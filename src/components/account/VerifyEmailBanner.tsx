"use client";

import { useState } from "react";
import { Button, apiFetch, cn, toast } from "@/components/ui";
import { resendOutcomeText } from "./verify-helpers";

/**
 * Shown above every workspace page while the signed-in user has not confirmed their email address.
 * The server decides who is unverified; this only explains why sending is paused and lets the person ask for a new link.
 */
export function VerifyEmailBanner({ email }: { email: string }) {
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");

  async function resend() {
    setState("sending");
    try {
      const res = await apiFetch<{ alreadyVerified?: boolean }>("/api/auth/resend-verification", { method: "POST", body: {} });
      if (res.alreadyVerified) {
        toast.success("Your email is already confirmed. Refreshing the page.");
        window.location.reload();
        return;
      }
      setState("sent");
      toast.success(resendOutcomeText("sent", email));
    } catch (e) {
      setState("idle");
      toast.error(resendOutcomeText("error", email, (e as Error).message));
    }
  }

  return (
    <div role="status" className={cn("flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-warn-line bg-warn-soft px-4 py-2 text-sm text-warn-fg print:hidden")}>
      <span className="min-w-0 flex-1">
        Confirm your email address ({email}) to send messages and connect WhatsApp. Until then you can look around and change settings.
      </span>
      <span className="flex flex-wrap items-center gap-2">
        {state === "sent" && <span aria-live="polite">Link sent. Check your inbox and spam folder.</span>}
        <Button size="sm" variant="secondary" loading={state === "sending"} onClick={resend} disabled={state === "sent"}>
          {state === "sent" ? "Email sent" : "Send me a new link"}
        </Button>
      </span>
    </div>
  );
}
