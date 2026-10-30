export type Channel = "facebook" | "instagram" | "threads";
export type MediaKind = "image" | "video";

export const CHANNEL_LIMITS: Record<Channel, { label: string; maxChars: number; needsMedia: boolean; maxHashtags?: number }> = {
  facebook: { label: "Facebook Page", maxChars: 63206, needsMedia: false },
  instagram: { label: "Instagram", maxChars: 2200, needsMedia: true, maxHashtags: 30 },
  threads: { label: "Threads", maxChars: 500, needsMedia: false },
};

export const ASSET_CHANNEL: Record<string, Channel> = { page: "facebook", instagram: "instagram", threads: "threads" };

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
export const MEDIA_KEY_PATTERN = /^[a-f0-9]{32}\.(jpg|png|mp4|mov)$/;

export const mediaKind = (key: string): MediaKind => (/\.(mp4|mov)$/.test(key) ? "video" : "image");

/** Problems that stop a post from being valid on this channel. Used by the composer and the API. */
export function channelProblems(channel: Channel, body: string, mediaKeys: string[]): string[] {
  const rule = CHANNEL_LIMITS[channel];
  const problems: string[] = [];
  if (body.length > rule.maxChars) problems.push(`${rule.label} allows ${rule.maxChars} characters; this post has ${body.length}.`);
  if (rule.needsMedia && mediaKeys.length === 0) problems.push(`${rule.label} posts need an image or video.`);
  if (!rule.needsMedia && !body.trim() && mediaKeys.length === 0) problems.push(`${rule.label} posts need text or media.`);
  if (rule.maxHashtags && (body.match(/#[\p{L}\p{N}_]+/gu)?.length ?? 0) > rule.maxHashtags) problems.push(`${rule.label} allows at most ${rule.maxHashtags} hashtags.`);
  if (channel === "instagram" && mediaKeys.some((k) => k.endsWith(".png"))) problems.push("Instagram needs a JPEG image; PNG is not accepted.");
  return problems;
}
