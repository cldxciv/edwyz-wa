"use client";

import { PageHeader } from "@/components/app/PageHeader";
import { RoleGate } from "@/components/team/RoleGate";
import { Card, EmptyState } from "@/components/ui";
import { ConnectWhatsApp } from "./ConnectWhatsApp";
import { MessagingLimitCard } from "./MessagingLimitCard";
import { TROUBLE_TOPICS } from "./helpers";

function HelpCard() {
  return (
    <Card title="If something goes wrong" description="The most common reasons, and what to do.">
      <div className="divide-y divide-border">
        {TROUBLE_TOPICS.map((t) => (
          <details key={t.question} className="py-1">
            <summary className="min-h-10 cursor-pointer py-2 text-sm font-medium">{t.question}</summary>
            <p className="pb-2 text-sm text-muted">{t.answer}</p>
          </details>
        ))}
      </div>
    </Card>
  );
}

export function ConnectGuide() {
  return (
    <div className="max-w-6xl">
      <PageHeader title="Connect WhatsApp" description="Link your WhatsApp Business number to use the inbox, templates and broadcasts. It takes about 5 minutes." />
      <RoleGate
        loadingLabel="Loading"
        denied={<EmptyState title="Ask an owner or admin to connect WhatsApp" body="Connecting a number changes how the whole workspace sends messages, so only owners and admins can do it. Once it is connected, everyone can use the inbox." />}
      >
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <ConnectWhatsApp />
          <div className="space-y-6">
            <MessagingLimitCard />
            <HelpCard />
          </div>
        </div>
      </RoleGate>
    </div>
  );
}
