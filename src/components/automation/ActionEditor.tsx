"use client";

import { useState } from "react";
import Link from "next/link";
import { Button, FormField, Input, Select, Textarea } from "@/components/ui";
import { LIMITS, type Action, type Trigger } from "@/lib/automation/v2/model";
import { PLACEHOLDER_HELP, unknownPlaceholders } from "@/lib/automation/v2/variables";
import { MaterialDialog, type Material } from "./MaterialDialog";
import { actionGroupsFor, actionProblem, defaultAction, STATUS_CHOICES, templateFillProblem, templatesForNumber, type Options } from "./rulesV2";

/**
 * showErrors: the person pressed Create rule or Save changes, so each step shows its problem under the field it is about.
 * phoneNumberId: the rule's own number (null for all numbers); Send template then lists only that number's account's templates.
 */
type Ctx = { trigger: Trigger; options: Options; onMaterialCreated: (m: Material) => void; showErrors?: boolean; phoneNumberId?: string | null };

/**
 * A template choice as /api/automation/options sends it. sendable is false (with a short reason, and instead: what to do) when a
 * rule can never send it, such as a template with a coupon code or too many values; older answers without the field count as
 * sendable. needs says what the step fills in besides the text values: a heading value, a heading picture, video or file, a link
 * button value.
 */
type RuleTemplate = Options["templates"][number] & { sendable?: boolean; reason?: string; instead?: string };

const placeholderHint = `You can use ${PLACEHOLDER_HELP.map((p) => p.token).join(", ")}.`;
const MEDIA_WORD = { image: "picture", video: "video", document: "file" } as const;

/** The step after choosing another template: text values resized, heading and button values kept only where the new template has a gap. */
export function withTemplate(a: Extract<Action, { type: "send_template" }>, template: RuleTemplate | undefined): Extract<Action, { type: "send_template" }> {
  const needs = template?.needs;
  return {
    type: "send_template",
    templateId: template?.id ?? "",
    variables: Array.from({ length: template?.variables ?? 0 }, (_, i) => a.variables[i] ?? ""),
    ...(needs?.headerText && a.headerVariable ? { headerVariable: a.headerVariable } : {}),
    ...(needs?.headerMedia && a.headerMediaUrl ? { headerMediaUrl: a.headerMediaUrl } : {}),
    ...(needs?.buttonValue && a.buttonVariable ? { buttonVariable: a.buttonVariable } : {}),
  };
}

function Missing({ what, href, link }: { what: string; href: string; link: string }) {
  return (
    <p className="text-xs text-muted">
      You have no {what} yet.{" "}
      <Link href={href} className="font-medium text-accent-ink underline" target="_blank">
        {link}
      </Link>
    </p>
  );
}

function ActionFields({ a, onChange, ctx }: { a: Action; onChange: (next: Action) => void; ctx: Ctx }) {
  const { options } = ctx;
  const [creating, setCreating] = useState(false);
  const problem = ctx.showErrors ? actionProblem(a) : null;
  const err = (field: string) => (problem?.field === field ? problem.message : undefined);
  switch (a.type) {
    case "send_text": {
      const unknown = unknownPlaceholders(a.text);
      return (
        <FormField label="Message" required hint={`${a.text.length}/${LIMITS.text}. ${placeholderHint}`} error={err("text") ?? (unknown.length ? `${unknown.map((u) => `{{${u}}}`).join(", ")} is not a known placeholder and will be left blank.` : undefined)}>
          <Textarea rows={4} value={a.text} maxLength={LIMITS.text} onChange={(e) => onChange({ ...a, text: e.target.value })} placeholder="e.g. Hi {{first_name|there}}, thanks for getting in touch." />
        </FormField>
      );
    }
    case "send_template": {
      const all = options.templates as RuleTemplate[];
      const template = all.find((t) => t.id === a.templateId);
      // Only the rule's number's account; a chosen template of another account stays listed so the select can show it.
      const fitting = templatesForNumber(options, ctx.phoneNumberId) as RuleTemplate[];
      const templates = template && !fitting.includes(template) ? [...fitting, template] : fitting;
      const count = template?.variables ?? 0;
      const needs = template?.needs;
      const fill = ctx.showErrors ? templateFillProblem(a, options, ctx.phoneNumberId) : null;
      const fieldError = (field: string) => err(field) ?? (fill?.field === field ? fill.message : undefined);
      const blocked =
        template && template.sendable === false
          ? `A rule cannot send "${template.name}": it ${template.reason ?? "needs values a rule cannot add"}. ${template.instead ?? "Choose another template, or send this one from a broadcast or a chatbot."}`
          : undefined;
      const oneNumber = Boolean(ctx.phoneNumberId && fitting.length !== all.length);
      return (
        <div className="space-y-3">
          <FormField
            label="Template"
            required
            hint={`Only approved templates${oneNumber ? " of this number's WhatsApp Business account" : ""} are listed. If a template has a picture, video or file at the top, or a value in its heading or button link, you fill it in below.`}
            error={fieldError("template") ?? blocked}
          >
            <Select value={a.templateId} onChange={(e) => onChange(withTemplate(a, all.find((t) => t.id === e.target.value)))}>
              <option value="">Choose a template</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id} disabled={t.sendable === false && t.id !== a.templateId}>
                  {t.name} ({t.language}){t.sendable === false ? `: rules cannot send it, it ${t.reason ?? "needs values a rule cannot add"}` : ""}
                </option>
              ))}
            </Select>
          </FormField>
          {options.templates.length === 0 && <Missing what="approved templates" href="/app/templates" link="Create a template" />}
          {options.templates.length > 0 && fitting.length === 0 && <Missing what="approved templates for this number's WhatsApp Business account" href="/app/templates" link="Create a template" />}
          {template && needs?.headerMedia && (
            <FormField
              label={`Link to the ${MEDIA_WORD[needs.headerMedia]} at the top`}
              required
              hint={`A secure link that starts with https://. You can use a contact detail, for example {{attribute.photo}}.`}
              error={fieldError("headerMediaUrl")}
            >
              <Input inputMode="url" value={a.headerMediaUrl ?? ""} maxLength={LIMITS.mediaUrl} placeholder="https://example.com/picture.jpg" onChange={(e) => onChange({ ...a, headerMediaUrl: e.target.value })} />
            </FormField>
          )}
          {template && needs?.headerText && (
            <FormField label="Value for the heading" required hint={`The heading of this template has a gap. ${placeholderHint}`} error={fieldError("headerVariable")}>
              <Input value={a.headerVariable ?? ""} maxLength={LIMITS.variableLength} onChange={(e) => onChange({ ...a, headerVariable: e.target.value })} />
            </FormField>
          )}
          {Array.from({ length: count }, (_, i) => (
            <FormField key={i} label={`Value for {{${i + 1}}}`} required hint={i === 0 ? placeholderHint : undefined}>
              <Input
                value={a.variables[i] ?? ""}
                maxLength={LIMITS.variableLength}
                placeholder={i === 0 ? "e.g. {{first_name|there}}" : ""}
                onChange={(e) => onChange({ ...a, variables: Array.from({ length: count }, (_, j) => (j === i ? e.target.value : (a.variables[j] ?? ""))) })}
              />
            </FormField>
          ))}
          {template && needs?.buttonValue && (
            <FormField label="Value for the button link" required hint={`The web address on the button has a gap, for example for an order number. ${placeholderHint}`} error={fieldError("buttonVariable")}>
              <Input value={a.buttonVariable ?? ""} maxLength={LIMITS.variableLength} onChange={(e) => onChange({ ...a, buttonVariable: e.target.value })} />
            </FormField>
          )}
        </div>
      );
    }
    case "send_material":
      return (
        <div className="space-y-3">
          <FormField label="Reply material" required error={err("material")}>
            <Select value={a.materialId} onChange={(e) => onChange({ ...a, materialId: e.target.value })}>
              <option value="">Choose a material</option>
              {options.materials.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.kind === "text" ? "text" : m.kind === "document" ? "document" : "photo, video or audio"})
                </option>
              ))}
            </Select>
          </FormField>
          <Button type="button" variant="secondary" size="sm" className="max-sm:min-h-10" onClick={() => setCreating(true)}>
            Add a new reply material
          </Button>
          {creating && (
            <MaterialDialog
              material={null}
              onClose={() => setCreating(false)}
              onSaved={(m) => {
                ctx.onMaterialCreated(m);
                onChange({ ...a, materialId: m.id });
                setCreating(false);
              }}
            />
          )}
        </div>
      );
    case "assign_user":
      return (
        <FormField label="Person" required error={err("user")}>
          <Select value={a.userId} onChange={(e) => onChange({ ...a, userId: e.target.value })}>
            <option value="">Choose a person</option>
            {options.members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name}
              </option>
            ))}
          </Select>
        </FormField>
      );
    case "assign_team":
      return (
        <div className="space-y-3">
          <FormField label="Team" required error={err("team")}>
            <Select value={a.teamId} onChange={(e) => onChange({ ...a, teamId: e.target.value })}>
              <option value="">Choose a team</option>
              {options.teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </FormField>
          {options.teams.length === 0 && <Missing what="teams" href="/app/settings/team" link="Set up teams" />}
          <label className="flex min-h-10 items-center gap-2.5 text-sm">
            <input type="checkbox" className="h-5 w-5 accent-accent" checked={a.pickAgent} onChange={(e) => onChange({ ...a, pickAgent: e.target.checked })} />
            Also pick an available agent from the team
          </label>
        </div>
      );
    case "assign_round_robin":
      return <p className="text-sm text-muted">The chat goes to the next available agent, using your chat routing settings. Nothing to set up here.</p>;
    case "start_chatbot":
      return (
        <FormField label="Chatbot" required hint="Only published chatbots are listed." error={err("chatbot")}>
          <Select value={a.chatbotId} onChange={(e) => onChange({ ...a, chatbotId: e.target.value })}>
            <option value="">Choose a chatbot</option>
            {options.chatbots.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </FormField>
      );
    case "start_ai_agent":
      return (
        <p className="text-sm text-muted">
          The AI agent answers this customer, even if it was stopped earlier in this chat and whatever its Reply when setting says. It must be switched on in AI agent settings. To have it answer only when a rule asks, set its Reply when to Only when an automation rule starts it.
        </p>
      );
    case "start_lead_sequence":
      return (
        <FormField label="Follow-up sequence" required error={err("sequence")}>
          <Select value={a.sequenceId} onChange={(e) => onChange({ ...a, sequenceId: e.target.value })}>
            <option value="">Choose a sequence</option>
            {options.sequences.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </FormField>
      );
    case "update_attribute":
      return (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Contact detail" required hint="For example city or plan" error={err("name")}>
              <Input value={a.name} maxLength={LIMITS.attribute} onChange={(e) => onChange({ ...a, name: e.target.value })} />
            </FormField>
            {!a.remove && (
              <FormField label="New value" required error={err("value")}>
                <Input value={a.value} maxLength={LIMITS.attributeValue} onChange={(e) => onChange({ ...a, value: e.target.value })} />
              </FormField>
            )}
          </div>
          <label className="flex min-h-10 items-center gap-2.5 text-sm">
            <input type="checkbox" className="h-5 w-5 accent-accent" checked={a.remove} onChange={(e) => onChange({ ...a, remove: e.target.checked })} />
            Clear this detail instead
          </label>
        </div>
      );
    case "add_tag":
    case "remove_tag":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Tag" required error={err("tag")}>
            <Input value={a.tag} maxLength={LIMITS.tag} onChange={(e) => onChange({ ...a, tag: e.target.value })} />
          </FormField>
          <FormField label={a.type === "add_tag" ? "Add it to" : "Remove it from"}>
            <Select value={a.scope} onChange={(e) => onChange({ ...a, scope: e.target.value as typeof a.scope })}>
              <option value="both">The contact and the chat</option>
              <option value="contact">The contact</option>
              <option value="chat">The chat</option>
            </Select>
          </FormField>
        </div>
      );
    case "set_status":
      return (
        <FormField label="Mark the chat as" error={err("status")}>
          <Select value={a.status} onChange={(e) => onChange({ ...a, status: e.target.value as typeof a.status })}>
            {STATUS_CHOICES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
        </FormField>
      );
    case "notify":
      return (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Tell">
              <Select value={a.target} onChange={(e) => onChange({ ...a, target: e.target.value as typeof a.target, userId: e.target.value === "user" ? a.userId : null })}>
                <option value="assigned">The agent the chat is assigned to</option>
                <option value="admins">All owners and admins</option>
                <option value="user">A specific person</option>
              </Select>
            </FormField>
            {a.target === "user" && (
              <FormField label="Person" required error={err("user")}>
                <Select value={a.userId ?? ""} onChange={(e) => onChange({ ...a, userId: e.target.value || null })}>
                  <option value="">Choose a person</option>
                  {options.members.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.name}
                    </option>
                  ))}
                </Select>
              </FormField>
            )}
          </div>
          <FormField label="Note" optional hint="Added to the chat as an internal note and sent by email. The customer never sees it." error={err("note")}>
            <Textarea rows={2} value={a.message} maxLength={LIMITS.note} onChange={(e) => onChange({ ...a, message: e.target.value })} />
          </FormField>
        </div>
      );
  }
}

type RowProps = { index: number; count: number; action: Action; ctx: Ctx; onChange: (a: Action) => void; onRemove: () => void; onMove: (delta: -1 | 1) => void };

function ActionRow({ index, count, action, ctx, onChange, onRemove, onMove }: RowProps) {
  const groups = actionGroupsFor(ctx.trigger);
  return (
    <li className="rounded-card border border-border bg-surface p-3">
      <div className="flex flex-wrap items-end gap-3">
        <FormField label={`Step ${index + 1}`} className="min-w-0 flex-1">
          <Select value={action.type} onChange={(e) => onChange(defaultAction(e.target.value as Action["type"]))}>
            {groups.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.items.map((i) => (
                  <option key={i.value} value={i.value}>
                    {i.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </FormField>
        <div className="flex gap-1">
          <Button type="button" variant="ghost" size="sm" className="max-sm:min-h-10" aria-label={`Up: Move step ${index + 1} earlier`} disabled={index === 0} onClick={() => onMove(-1)}>
            Up
          </Button>
          <Button type="button" variant="ghost" size="sm" className="max-sm:min-h-10" aria-label={`Down: Move step ${index + 1} later`} disabled={index === count - 1} onClick={() => onMove(1)}>
            Down
          </Button>
          <Button type="button" variant="ghost" size="sm" className="max-sm:min-h-10 text-bad-fg" aria-label={`Remove step ${index + 1}`} onClick={onRemove}>
            Remove
          </Button>
        </div>
      </div>
      <div className="mt-3">
        <ActionFields a={action} onChange={onChange} ctx={ctx} />
      </div>
    </li>
  );
}

type Props = { actions: Action[]; onChange: (next: Action[]) => void } & Ctx;

export function ActionList({ actions, onChange, trigger, options, onMaterialCreated, showErrors, phoneNumberId }: Props) {
  const ctx: Ctx = { trigger, options, onMaterialCreated, showErrors, phoneNumberId };
  const move = (index: number, delta: -1 | 1) => {
    const next = [...actions];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    onChange(next);
  };
  return (
    <div className="space-y-3">
      {actions.length > 0 && (
        <ol className="space-y-3">
          {actions.map((a, i) => (
            <ActionRow key={i} index={i} count={actions.length} action={a} ctx={ctx} onChange={(next) => onChange(actions.map((x, j) => (j === i ? next : x)))} onRemove={() => onChange(actions.filter((_, j) => j !== i))} onMove={(d) => move(i, d)} />
          ))}
        </ol>
      )}
      {actions.length < LIMITS.actions && (
        <Button type="button" variant="secondary" size="sm" className="max-sm:min-h-10" onClick={() => onChange([...actions, defaultAction(actions.length === 0 ? "send_text" : "add_tag")])}>
          {actions.length === 0 ? "Add the first step" : "Add another step"}
        </Button>
      )}
    </div>
  );
}
