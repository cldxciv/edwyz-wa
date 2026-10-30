import { COMPANY, siteUrl } from "@/lib/config";

export type Rendered = { subject: string; text: string; html: string };

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const e = escapeHtml;
const safeUrl = (url: string) => (/^https?:\/\//i.test(url) ? url : siteUrl());
const appUrl = (path: string) => `${siteUrl()}${path}`;

type Block = { p: string } | { link: string; label: string };

function render(subject: string, greeting: string, blocks: Block[]): Rendered {
  const footerText = `${COMPANY.legalName}, ${COMPANY.address}. Questions: ${COMPANY.email}`;
  const text = [
    greeting,
    "",
    ...blocks.map((b) => ("p" in b ? b.p : `${b.label}: ${safeUrl(b.link)}`)),
    "",
    "--",
    footerText,
  ].join("\n");
  const body = blocks
    .map((b) =>
      "p" in b
        ? `<p>${e(b.p)}</p>`
        : `<p><a href="${e(safeUrl(b.link))}">${e(b.label)}</a><br><span style="color:#555;font-size:12px">${e(safeUrl(b.link))}</span></p>`,
    )
    .join("");
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;line-height:1.5;color:#111"><p>${e(greeting)}</p>${body}<hr><p style="color:#555;font-size:12px">${e(footerText)}</p></body></html>`;
  return { subject, text, html };
}

const hi = (name?: string) => (name ? `Hello ${name},` : "Hello,");

export function verifyEmailTemplate(p: { name: string; link: string }): Rendered {
  return render("Confirm your email address", hi(p.name), [
    { p: "Please confirm this email address for your Edwyz WA account." },
    { link: p.link, label: "Confirm email" },
    { p: "The link works once and expires in 48 hours. If you did not create an account, you can ignore this message." },
  ]);
}

export function passwordResetTemplate(p: { name: string; link: string }): Rendered {
  return render("Reset your Edwyz WA password", hi(p.name), [
    { p: "We received a request to reset the password for your account." },
    { link: p.link, label: "Choose a new password" },
    { p: "The link works once and expires in 1 hour. If you did not ask for this, ignore this message; your password has not changed." },
  ]);
}

export function inviteTemplate(p: { workspaceName: string; inviterName: string; role: string; link: string }): Rendered {
  return render(`${p.inviterName} invited you to ${p.workspaceName} on Edwyz WA`, "Hello,", [
    { p: `${p.inviterName} invited you to join the workspace "${p.workspaceName}" on Edwyz WA as ${p.role}.` },
    { link: p.link, label: "Accept the invite" },
    { p: "The invite works once and expires in 7 days. If you were not expecting it, you can ignore this message." },
  ]);
}

export function trialEndingTemplate(p: { workspaceName: string; daysLeft: 1 | 3 }): Rendered {
  const when = p.daysLeft === 1 ? "in 1 day" : "in 3 days";
  return render(`Your Edwyz WA trial ends ${when}`, "Hello,", [
    { p: `The free trial for "${p.workspaceName}" ends ${when}. After it ends you will need a paid plan to keep sending messages.` },
    { link: appUrl("/app/billing"), label: "Choose a plan" },
  ]);
}

export function trialEndedTemplate(p: { workspaceName: string }): Rendered {
  return render("Your Edwyz WA trial has ended", "Hello,", [
    { p: `The free trial for "${p.workspaceName}" has ended, so the workspace is now read-only: you can still open your conversations, contacts and reports, but sending messages and making changes are paused. Your data is kept. Choose a plan to switch everything back on.` },
    { link: appUrl("/app/billing"), label: "Choose a plan" },
  ]);
}

export function paymentFailedTemplate(p: { workspaceName: string; graceDaysLeft: number }): Rendered {
  const left =
    p.graceDaysLeft > 0
      ? `Your workspace keeps working for ${p.graceDaysLeft} more day${p.graceDaysLeft === 1 ? "" : "s"} while you fix this.`
      : "The grace period has ended, so the workspace may be restricted until payment succeeds.";
  return render("Your Edwyz WA payment did not go through", "Hello,", [
    { p: `We could not collect the latest payment for "${p.workspaceName}". ${left}` },
    { link: appUrl("/app/billing"), label: "Review billing" },
  ]);
}

export function paymentReceivedTemplate(p: { workspaceName: string; amountPaise?: number; invoiceUrl: string }): Rendered {
  const amount = typeof p.amountPaise === "number" ? ` of INR ${(p.amountPaise / 100).toFixed(2)}` : "";
  return render("Payment received for Edwyz WA", "Hello,", [
    { p: `We received your payment${amount} for "${p.workspaceName}". Thank you.` },
    { link: p.invoiceUrl, label: "View invoice" },
  ]);
}

export function workspaceSuspendedTemplate(p: { workspaceName: string; reason?: string }): Rendered {
  return render("Your Edwyz WA workspace has been suspended", "Hello,", [
    { p: `The workspace "${p.workspaceName}" has been suspended.${p.reason ? ` Reason given: ${p.reason}` : ""}` },
    { p: `If you think this is a mistake, reply to ${COMPANY.email} and we will look into it.` },
  ]);
}

export function numberQualityDroppedTemplate(p: { workspaceName: string; displayPhone: string; from: string; to: string }): Rendered {
  return render("WhatsApp number quality rating dropped", "Hello,", [
    { p: `The quality rating of ${p.displayPhone} in "${p.workspaceName}" changed from ${p.from} to ${p.to}, as reported by WhatsApp.` },
    { p: "A lower rating can limit how many people you can message. Review recent campaigns and make sure recipients opted in." },
  ]);
}

export function passwordChangedTemplate(p: { name: string }): Rendered {
  return render("Your Edwyz WA password was changed", hi(p.name), [
    { p: "The password for your account was just changed and you were signed out everywhere." },
    { p: `If this was not you, contact ${COMPANY.email} right away.` },
  ]);
}

export function usageAlertTemplate(p: { workspaceName: string; label: string; level: 80 | 100; used: number; limit: number; monthly: boolean }): Rendered {
  const n = (v: number) => v.toLocaleString("en-IN");
  const reset = p.monthly ? " It restarts on the 1st of next month." : "";
  const subject = p.level === 100 ? `You have reached your plan limit for ${p.label}` : `You have used 80% of your plan's ${p.label}`;
  const what =
    p.level === 100
      ? `"${p.workspaceName}" has used ${n(p.used)} of ${n(p.limit)} ${p.label}. New items of this kind are blocked until you upgrade.${reset}`
      : `"${p.workspaceName}" has used ${n(p.used)} of ${n(p.limit)} ${p.label}.${reset}`;
  return render(subject, "Hello,", [{ p: what }, { link: appUrl("/app/billing"), label: "Review your plan" }]);
}

export function workspaceDeletionRequestedTemplate(p: { workspaceName: string; days: number }): Rendered {
  return render("We received your request to delete your Edwyz WA workspace", "Hello,", [
    { p: `An owner of "${p.workspaceName}" asked us to delete the workspace and the data in it. We will do this within ${p.days} days.` },
    { p: "Until then nothing has been deleted. If you did not ask for this, or you changed your mind, open Billing in the app and choose Keep my workspace." },
    { p: "If you pay by subscription, cancel it from Billing so that you are not charged again. Invoices we must keep by law are retained." },
    { link: appUrl("/app/billing"), label: "Open billing" },
  ]);
}

export function workspaceDeletionCancelledTemplate(p: { workspaceName: string }): Rendered {
  return render("Your Edwyz WA workspace will be kept", "Hello,", [
    { p: `The request to delete "${p.workspaceName}" was withdrawn. Nothing was deleted and your workspace carries on as before.` },
  ]);
}

export function workspaceDeletionTeamTemplate(p: { workspaceId: string; workspaceName: string; days: number }): Rendered {
  return render("Workspace deletion request to handle", "Hello,", [
    { p: `The owner of "${p.workspaceName}" (${p.workspaceId}) asked for the workspace to be deleted. Erase it from the admin console within ${p.days} days of the request, after checking the request is still open.` },
    { link: appUrl("/admin"), label: "Open the admin console" },
  ]);
}
