import { GraphError, graphFetchAs } from "@/lib/graph";
import type { AssetAccess } from "@/lib/meta-connect";
import { sanitizeMessage } from "@/lib/safe-error";
import type { MediaKind } from "./limits";

/*
 * Every endpoint, field and limit below is marked VERIFY: confirm against the current Graph API reference before App Review.
 */

export type PublishMedia = { url: string; kind: MediaKind } | null;

/** retry: a later attempt may succeed. Otherwise the target fails for good. */
export class PublishError extends Error {
  constructor(
    message: string,
    public retry = false,
  ) {
    super(message);
  }
}

export type Deferred = { defer: { ms: number; message: string } };
export type Published = { externalId: string };

const IG_POLL_TRIES = 6;
const IG_POLL_MS = 5000;
const IG_LIMIT_DEFER_MS = 15 * 60_000;
const IG_PENDING_DEFER_MS = 60_000;
const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A step that creates the post (feed, photos, media_publish) must never be repeated after an unclear outcome,
 * so 5xx responses and network failures there end the target instead of retrying. Rate limits are safe to retry.
 */
function toPublishError(e: unknown, creates: boolean): PublishError {
  if (!(e instanceof GraphError)) return new PublishError("The post could not be published.");
  const message = sanitizeMessage(e.message, 250);
  if (creates && (e.ambiguous || e.status >= 500 || e.status === 0)) {
    return new PublishError("Meta did not confirm whether the post was published. Check the account before trying again.");
  }
  return new PublishError(message, e.retryable || e.status >= 500 || e.status === 0);
}

async function call<T>(token: string, creates: boolean, request: Parameters<typeof graphFetchAs>[1]): Promise<T> {
  try {
    return await graphFetchAs<T>(token, request);
  } catch (e) {
    throw toPublishError(e, creates);
  }
}

const firstUrl = (text: string) => text.match(/https?:\/\/[^\s<>"]+/)?.[0];

/** Page post: text or link through /feed, one photo through /photos, one video through /videos. */
export async function publishFacebook(asset: AssetAccess, body: string, media: PublishMedia): Promise<Published> {
  const page = asset.externalId;
  if (!media) {
    const link = firstUrl(body);
    const res = await call<{ id?: string }>(asset.token, true, { path: `${page}/feed`, method: "POST", body: { message: body, ...(link ? { link } : {}) } });
    return done(res.id);
  }
  if (media.kind === "image") {
    const res = await call<{ id?: string; post_id?: string }>(asset.token, true, { path: `${page}/photos`, method: "POST", body: { url: media.url, caption: body, published: true } });
    return done(res.post_id ?? res.id);
  }
  const res = await call<{ id?: string }>(asset.token, true, { path: `${page}/videos`, method: "POST", body: { file_url: media.url, description: body } });
  return done(res.id);
}

function done(id: string | undefined): Published {
  if (!id) throw new PublishError("Meta did not return a post id. Check the account before trying again.");
  return { externalId: id };
}

type LimitResponse = { data?: { quota_usage?: number; config?: { quota_total?: number } }[] };

async function igQuotaLeft(asset: AssetAccess): Promise<boolean> {
  const res = await call<LimitResponse>(asset.token, false, { path: `${asset.externalId}/content_publishing_limit`, query: { fields: "quota_usage,config" } });
  const row = res.data?.[0];
  const total = row?.config?.quota_total ?? 100;
  return (row?.quota_usage ?? 0) < total;
}

export type InstagramState = { containerId: string | null; saveContainer: (id: string) => Promise<void>; sleep?: (ms: number) => Promise<void> };

/** Image or Reel: create container, poll status, publish. The container id is saved before polling so a retry never creates a second one. */
export async function publishInstagram(asset: AssetAccess, caption: string, media: PublishMedia, state: InstagramState): Promise<Published | Deferred> {
  if (!media) throw new PublishError("Instagram posts need an image or video.");
  const ig = asset.externalId;
  let containerId = state.containerId;
  if (!containerId) {
    if (!(await igQuotaLeft(asset))) return { defer: { ms: IG_LIMIT_DEFER_MS, message: "Instagram's daily publishing limit is reached. Will retry later." } };
    const body = media.kind === "image" ? { image_url: media.url, caption } : { media_type: "REELS", video_url: media.url, caption };
    const created = await call<{ id?: string }>(asset.token, false, { path: `${ig}/media`, method: "POST", body });
    if (!created.id) throw new PublishError("Instagram did not create the media container.", true);
    containerId = created.id;
    await state.saveContainer(containerId);
  }
  const ready = await waitForContainer(asset, containerId, state.sleep ?? sleepReal);
  if (!ready) return { defer: { ms: IG_PENDING_DEFER_MS, message: "Instagram is still processing the media." } };
  const res = await call<{ id?: string }>(asset.token, true, { path: `${ig}/media_publish`, method: "POST", body: { creation_id: containerId } });
  return done(res.id);
}

async function waitForContainer(asset: AssetAccess, containerId: string, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  for (let i = 0; i < IG_POLL_TRIES; i++) {
    const res = await call<{ status_code?: string }>(asset.token, false, { path: containerId, query: { fields: "status_code" } });
    if (res.status_code === "FINISHED") return true;
    if (res.status_code === "ERROR" || res.status_code === "EXPIRED") throw new PublishError(`Instagram could not process the media (${res.status_code.toLowerCase()}).`);
    if (i < IG_POLL_TRIES - 1) await sleep(IG_POLL_MS);
  }
  return false;
}

export async function publishThreads(): Promise<never> {
  throw new PublishError("Threads publishing is not available yet.");
}
