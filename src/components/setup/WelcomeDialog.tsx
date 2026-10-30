"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui";
import { actionLinkClass } from "./EmptyState";
import { Illustration } from "./Illustrations";
import { hasSeenWelcome, markWelcomeSeen, WELCOME_POINTS } from "./welcome";

/** Shown once per person on their first visit. Uses the native dialog element so focus is trapped and Escape closes it. */
export function WelcomeDialog({ userId, firstName, canSetUp }: { userId: string; firstName: string; canSetUp: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !userId || hasSeenWelcome(userId) || dialog.open) return;
    try {
      dialog.showModal();
      dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    } catch {
      // the dialog is a nicety; the dashboard works without it
    }
  }, [userId]);

  const close = () => ref.current?.close();

  return (
    <dialog
      ref={ref}
      aria-labelledby="welcome-title"
      aria-describedby="welcome-intro"
      onClose={() => markWelcomeSeen(userId)}
      onClick={(e) => e.target === ref.current && close()}
      className="m-auto w-[calc(100%-2rem)] max-w-xl rounded-2xl border border-border bg-background p-0 text-foreground shadow-xl backdrop:bg-black/50"
    >
      <div className="p-6 sm:p-8">
        <h2 id="welcome-title" className="text-xl font-semibold tracking-tight">
          {firstName ? `Welcome, ${firstName}` : "Welcome to Edwyz WA"}
        </h2>
        <p id="welcome-intro" className="mt-2 text-sm text-muted">
          Edwyz WA helps your business grow on WhatsApp. Here is what you can do with it.
        </p>
        <ul className="mt-6 space-y-5">
          {WELCOME_POINTS.map((p) => (
            <li key={p.title} className="flex items-center gap-4">
              <Illustration name={p.art} className="h-16 w-20 shrink-0" />
              <div>
                <h3 className="font-semibold">{p.title}</h3>
                <p className="mt-0.5 text-sm text-muted">{p.body}</p>
              </div>
            </li>
          ))}
        </ul>
        <div className="mt-8 flex flex-wrap items-center justify-end gap-3">
          {canSetUp ? (
            <>
              <Button variant="ghost" onClick={close}>
                I will explore first
              </Button>
              <Link href="/app/getting-started" onClick={close} className={actionLinkClass(true)} data-autofocus>
                Show me how to start
              </Link>
            </>
          ) : (
            <Button onClick={close} data-autofocus>
              Got it
            </Button>
          )}
        </div>
      </div>
    </dialog>
  );
}
