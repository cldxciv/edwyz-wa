const PREFIX = "meta-media:";
const MEDIA_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The value stored on Message.mediaUrl for a media object that lives at Meta. */
export function toMediaRef(mediaId: string): string {
  return `${PREFIX}${mediaId}`;
}

/** The Meta media id inside a stored reference, or null for anything that is not a plain meta-media reference. */
export function parseMediaRef(value: string | null | undefined): string | null {
  if (!value || !value.startsWith(PREFIX)) return null;
  const id = value.slice(PREFIX.length);
  return MEDIA_ID.test(id) ? id : null;
}
