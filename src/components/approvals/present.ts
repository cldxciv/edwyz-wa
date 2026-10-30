import { GOAL_INFO, PLACEMENT_INFO } from "@/components/creative/wizard";

export type PlainRow = { label: string; value: string };

const sentence = (text: string): string => {
  const words = text.replace(/[_-]+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const FORMAT: Record<string, string> = { image: "Picture", video: "Video", copy: "Ad text" };

/** Words for the page heading. The kind label comes from the server and is shown as a small tag above the title. */
export function reviewIntro(kindLabel: string): { title: string; hint: string } {
  const noun =
    ({
      "Ad creative": "this ad",
      "Creative brief": "this offer",
      "Ad campaign": "this campaign",
      "Social post": "this post",
      "Optimiser suggestion": "this suggestion",
    } as Record<string, string>)[kindLabel] ?? "this";
  return { title: `Please review ${noun}`, hint: "Look it over, then tap Approve if it is good to go. If something needs to change, tell us what." };
}

/** The small tag above the title. Internal names become words a client would use. */
export function plainKind(kindLabel: string): string {
  return ({ "Creative brief": "Offer and goal", "Ad creative": "Ad", "Optimiser suggestion": "Suggestion" } as Record<string, string>)[kindLabel] ?? kindLabel;
}

/** A title that repeats the internal kind name ("Creative brief") reads as jargon, so it gets a plain one. */
export function plainTitle(kindLabel: string, title: string): string {
  return kindLabel === "Creative brief" && title === "Creative brief" ? "What we plan to promote" : title;
}

export type Notice = { title: string; text: string };

/**
 * Wording for the box above the buttons when a decision did not go through. The decide route sends the client back to the
 * page with ?notice=expired|busy|comment (?e=retry is accepted too). Unknown values show nothing.
 */
export function noticeCopy(code: string | null | undefined): Notice | null {
  switch (code) {
    case "expired":
    case "retry":
      return { title: "That did not go through", text: "Please tap the button again. If nothing happens, reload this page first." };
    case "busy":
      return { title: "Please wait a moment", text: "There were too many tries in a row. Wait a few minutes, then tap the button again." };
    case "comment":
      return { title: "Please tell us what to change", text: "Write a few words in the box, then tap Send my changes." };
    default:
      return null;
  }
}

/** Plain labels and values for the facts under the preview, so no internal names or raw codes reach the client. */
export function plainRow(row: PlainRow): PlainRow {
  const { label, value } = row;
  switch (label) {
    case "Format":
      return { label: "Type", value: FORMAT[value.toLowerCase()] ?? sentence(value) };
    case "Placement":
      return { label: "Where it will show", value: PLACEMENT_INFO[value.toLowerCase()]?.label ?? sentence(value) };
    case "Goal":
      return { label: "Goal", value: GOAL_INFO[value.toLowerCase()]?.label ?? sentence(value) };
    case "Objective":
      return { label: "Goal", value: sentence(value.replace(/^outcome[_\s-]*/i, "")) };
    case "Attachments":
      return { label: "Pictures or videos", value };
    default:
      return row;
  }
}

export const plainRows = (rows: PlainRow[]): PlainRow[] => rows.map(plainRow);

export type DecidedCopy = { tone: "good" | "warn" | "bad"; label: string; title: string; text: string };

export function decidedCopy(decision: string): DecidedCopy {
  switch (decision) {
    case "approved":
      return { tone: "good", label: "Approved", title: "Thank you, this is approved", text: "The team has been told and will go ahead. You can close this page." };
    case "changes_requested":
      return { tone: "warn", label: "Changes requested", title: "Thank you, we have your comments", text: "The team has been told. They will make the changes and may send you a new link. You can close this page." };
    case "rejected":
      return { tone: "bad", label: "Declined", title: "You declined this", text: "The team has been told. You can close this page." };
    case "revoked":
    case "expired":
      return { tone: "warn", label: "Withdrawn", title: "This request was withdrawn", text: "The sender cancelled it. If you still need to review it, ask them for a new link." };
    default:
      return { tone: "warn", label: "Already answered", title: "An answer was already recorded", text: "There is nothing more to do. You can close this page." };
  }
}
