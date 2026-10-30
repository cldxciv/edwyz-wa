import type { Channel } from "@/lib/content/limits";
import { statusTone, type Tone } from "@/components/ui/status";

export type Target = { id: string; assetId: string; channel: Channel; status: string; externalId: string | null; error: string | null; publishedAt: string | null };
export type Post = { id: string; body: string; mediaKeys: string[]; scheduledAt: string; status: string; createdAt: string; targets: Target[] };
export type AssetOption = { id: string; name: string | null; channel: Channel; status: string; available: boolean };
export type MediaItem = { key: string; kind: "image" | "video"; bytes: number; createdAt: string };
export type CalendarEntry = { id: string; name: string; status: string; at: string; channels: string[] };

/** Words a business owner would use. Statuses the shared map does not know get a tone here. */
const POST_STATUS: Record<string, { label: string; tone?: Tone }> = {
  draft: { label: "Draft" },
  scheduled: { label: "Scheduled" },
  publishing: { label: "Publishing now" },
  published: { label: "Published" },
  partial: { label: "Partly published" },
  failed: { label: "Did not publish" },
  canceled: { label: "Canceled" },
  pending: { label: "Waiting to publish" },
  processing: { label: "Publishing now" },
  container: { label: "Preparing media", tone: "info" },
  retry: { label: "Will try again" },
};

export function postStatus(status: string): { label: string; tone: Tone } {
  const known = POST_STATUS[status];
  if (!known) {
    const words = status.replace(/_/g, " ");
    return { label: words.charAt(0).toUpperCase() + words.slice(1), tone: statusTone(status) };
  }
  return { label: known.label, tone: known.tone ?? statusTone(status) };
}

export const CHANNEL_NAME: Record<Channel, string> = { facebook: "Facebook", instagram: "Instagram", threads: "Threads" };

export const channelName = (channel: string): string => CHANNEL_NAME[channel as Channel] ?? channel.charAt(0).toUpperCase() + channel.slice(1);

/** UTC ISO string to the value a datetime-local input expects, in the viewer's time zone. */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** datetime-local value (viewer's time zone) to a UTC ISO string. */
export const fromLocalInput = (value: string): string => new Date(value).toISOString();

export const formatWhen = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export const mediaUrl = (key: string) => `/api/content/media/${key}`;
