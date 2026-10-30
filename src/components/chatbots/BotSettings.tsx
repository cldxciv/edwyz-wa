"use client";

import { useState, type ReactNode } from "react";
import { FormField, Input, Select, Textarea } from "@/components/ui";
import { Toggle } from "@/components/automation/Toggle";
import type { Doc } from "./editor";
import { settingsOf, withSettings } from "./flow";
import type { MemberOption } from "./Inspector";
import { LIMITS, TEAM_QUEUE, type TriggerType } from "./types";

export type BotOptions = {
  teams: { id: string; name: string }[];
  phoneNumbers: { id: string; displayPhone: string; verifiedName: string | null }[];
};

type Props = {
  doc: Doc;
  triggerType: TriggerType;
  options: BotOptions | null;
  members: MemberOption[];
  apply: (fn: (d: Doc) => Doc, key?: string | null) => void;
};

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="space-y-4 border-t border-border pt-5">
      <div>
        <h3 className="text-base font-semibold">{title}</h3>
        {hint && <p className="mt-0.5 text-sm text-muted">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function Switch({ label, help, checked, onChange }: { label: string; help: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted">{help}</p>
      </div>
      <Toggle label={label} checked={checked} onChange={onChange} />
    </div>
  );
}

const parseWords = (text: string) =>
  [...new Set(text.split(/[,\n]/).map((w) => w.trim().slice(0, 64)).filter(Boolean))].slice(0, 30);

const TIMEOUT_CHOICES: [number, string][] = [
  [5, "5 minutes"],
  [15, "15 minutes"],
  [30, "30 minutes"],
  [60, "1 hour"],
  [180, "3 hours"],
  [360, "6 hours"],
  [720, "12 hours"],
  [1440, "24 hours (standard)"],
];

export function BotSettings({ doc, triggerType, options, members, apply }: Props) {
  const s = settingsOf(doc.flow);
  const esc = s.escalation;
  const [words, setWords] = useState(esc.keywords.join(", "));
  const [priority, setPriority] = useState(String(s.priority));
  const set = (patch: Parameters<typeof withSettings>[1]) => apply((d) => ({ ...d, flow: withSettings(d.flow, patch) }));
  const priorityValue = Number(priority);
  const priorityError = priority !== "" && (!Number.isInteger(priorityValue) || priorityValue < 1 || priorityValue > 999) ? "Use a whole number from 1 to 999." : null;
  const timeoutOption = TIMEOUT_CHOICES.some(([m]) => m === s.timeoutMinutes) ? s.timeoutMinutes : 1440;
  const teams = options?.teams ?? [];
  const numbers = options?.phoneNumbers ?? [];

  return (
    <>
      <Section title="Where it runs" hint="Choose one WhatsApp number, or let the chatbot answer on all of them.">
        <FormField label="WhatsApp number">
          <Select value={doc.phoneNumberId ?? ""} onChange={(e) => apply((d) => ({ ...d, phoneNumberId: e.target.value || null }))}>
            <option value="">All your numbers</option>
            {numbers.map((n) => (
              <option key={n.id} value={n.id}>
                {n.verifiedName ? `${n.verifiedName} (${n.displayPhone})` : n.displayPhone}
              </option>
            ))}
          </Select>
        </FormField>
        {triggerType !== "manual" && (
          <FormField label="Which chatbot goes first" hint="When more than one chatbot could start, the lowest number wins. 1 goes first." error={priorityError}>
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={999}
              value={priority}
              onChange={(e) => {
                setPriority(e.target.value);
                const n = Number(e.target.value);
                if (e.target.value !== "" && Number.isInteger(n) && n >= 1 && n <= 999) set({ priority: n });
              }}
              onBlur={() => priority === "" && setPriority(String(s.priority))}
            />
          </FormField>
        )}
        {triggerType === "keyword" && (
          <FormField label="How words are matched">
            <Select value={s.keywordMatch} onChange={(e) => set({ keywordMatch: e.target.value === "exact" ? "exact" : "contains" })}>
              <option value="contains">The message contains one of the words</option>
              <option value="exact">The whole message is one of the words</option>
            </Select>
          </FormField>
        )}
      </Section>

      <Section title="Working with your team" hint="Keeps the chatbot from talking over a teammate.">
        <Switch label="Skip chats a teammate owns" help="Never start this chatbot on a chat that is assigned to someone." checked={s.skipAssignedChats} onChange={(v) => set({ skipAssignedChats: v })} />
        <Switch label="Stop when a teammate replies" help="As soon as someone on your team sends a message in the chat, the chatbot stops. Only sending a message counts; opening or assigning the chat does not." checked={s.stopOnHumanReply} onChange={(v) => set({ stopOnHumanReply: v })} />
        <Switch
          label="Use WhatsApp buttons and menus"
          help="Customers tap real buttons and lists. Switch off to send numbered text instead."
          checked={s.interactive}
          onChange={(v) => set({ interactive: v })}
        />
        <FormField label="End the chatbot after silence of" hint="If the customer does not answer for this long, the chatbot ends. The longest is 24 hours, the time WhatsApp lets you reply freely.">
          <Select value={timeoutOption} onChange={(e) => set({ timeoutMinutes: Number(e.target.value) })}>
            {TIMEOUT_CHOICES.map(([minutes, label]) => (
              <option key={minutes} value={minutes}>
                {label}
              </option>
            ))}
          </Select>
        </FormField>
        {s.timeoutMinutes < 1440 && (
          <FormField label="Message when it ends from silence" optional hint={`${(s.timeoutMessage ?? "").length}/${LIMITS.text}. Sent once, only while you can still reply freely. Leave empty to end quietly.`}>
            <Textarea rows={2} maxLength={LIMITS.text} value={s.timeoutMessage ?? ""} onChange={(e) => set({ timeoutMessage: e.target.value || undefined })} />
          </FormField>
        )}
        <FormField label="When a reply is not one of the options" optional hint={`${(s.fallbackText ?? "").length}/${LIMITS.text}. Leave empty to use "Please reply with one of the options."`}>
          <Textarea rows={2} maxLength={LIMITS.text} value={s.fallbackText ?? ""} onChange={(e) => set({ fallbackText: e.target.value || undefined })} />
        </FormField>
      </Section>

      <Section title="When a customer wants a person" hint="The chatbot notices when someone asks for a person or sounds upset, hands the chat over and tells your team why.">
        <Switch label="Hand over automatically" help="Works in English, Spanish, French, German, Portuguese, Italian, Hindi and Arabic." checked={esc.enabled} onChange={(v) => set({ escalation: { enabled: v } })} />
        {esc.enabled && (
          <div className="space-y-4">
            <FormField label="Message to the customer" optional hint={`${(esc.message ?? "").length}/${LIMITS.text}. Leave empty to use a standard message.`}>
              <Textarea rows={2} maxLength={LIMITS.text} value={esc.message ?? ""} onChange={(e) => set({ escalation: { message: e.target.value || undefined } })} />
            </FormField>
            <FormField label="Hand the chat to" hint={teams.length === 0 ? "You have no teams yet, so your routing settings decide who gets the chat." : undefined}>
              <Select
                value={esc.teamId ?? ""}
                onChange={(e) => set({ escalation: { teamId: e.target.value || undefined, userId: e.target.value ? esc.userId : undefined } })}
              >
                <option value="">Whoever your routing settings choose</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Or a specific teammate" optional>
              <Select value={esc.userId ?? ""} onChange={(e) => set({ escalation: { userId: e.target.value || undefined } })}>
                <option value="">{esc.teamId ? "The next free teammate of the team" : "No one in particular"}</option>
                {esc.teamId && <option value={TEAM_QUEUE}>No one yet: leave it in the team's queue</option>}
                {members.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Extra words that ask for a person" optional hint="Separate with commas, for example: complaint, refund. Matching is not case sensitive.">
              <Input value={words} maxLength={400} onChange={(e) => (setWords(e.target.value), set({ escalation: { keywords: parseWords(e.target.value) } }))} />
            </FormField>
            <Switch
              label="Ask AI when unsure"
              help="When no word matched and a reply does not fit the question, or is a sentence typed as an answer to an open question, AI reads it once. This uses one AI credit and only works if AI is set up for your workspace."
              checked={esc.useAi}
              onChange={(v) => set({ escalation: { useAi: v } })}
            />
          </div>
        )}
      </Section>
    </>
  );
}
