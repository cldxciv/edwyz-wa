import { cn } from "@/components/ui";
import type { Channel } from "@/lib/content/limits";
import { charCounter, firstLink, visibleText } from "./calendar-helpers";
import { CHANNEL_NAME, mediaUrl } from "./helpers";

/** A simple look-alike of how the post reads on one channel, with the character count for that channel. */
export function ChannelPreview({ channel, account, body, mediaKey, whenText }: { channel: Channel; account: string; body: string; mediaKey: string | undefined; whenText: string }) {
  const counter = charCounter(channel, body);
  const text = visibleText(channel, body);
  const isVideo = !!mediaKey && /\.(mp4|mov)$/.test(mediaKey);
  const link = channel === "facebook" && !mediaKey ? firstLink(body) : null;
  const media = mediaKey ? (
    isVideo ? (
      <video src={mediaUrl(mediaKey)} className="max-h-72 w-full bg-surface object-contain" controls preload="metadata" aria-label="Attached video" />
    ) : (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={mediaUrl(mediaKey)} alt="Attached picture" className={cn("w-full bg-surface object-cover", channel === "instagram" ? "aspect-square" : "max-h-72")} />
    )
  ) : null;

  const caption = text ? <p className="whitespace-pre-wrap break-words text-sm">{text}</p> : <p className="text-sm text-muted">Your text appears here.</p>;
  const header = (
    <div className="flex items-center gap-2.5 p-3">
      <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-sm font-semibold text-accent-ink">
        {account.charAt(0).toUpperCase() || "?"}
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold">{account}</p>
        <p className="text-xs text-muted">{whenText}</p>
      </div>
    </div>
  );

  return (
    <figure className="m-0" aria-label={`${CHANNEL_NAME[channel]} preview`}>
      <div className="overflow-hidden rounded-card border border-border bg-raised shadow-raised">
        {header}
        {channel === "instagram" ? (
          <>
            {media ?? (
              <div className="flex aspect-square items-center justify-center bg-surface-2 p-6 text-center text-sm text-muted">Instagram posts need a picture or video. Add one on the left.</div>
            )}
            <div className="p-3">
              <p className="mb-1 text-sm">
                <span className="font-semibold">{account}</span>
              </p>
              {caption}
            </div>
          </>
        ) : (
          <>
            <div className="px-3 pb-3">{caption}</div>
            {media}
            {link && (
              <p className="border-t border-border bg-surface px-3 py-2 text-xs text-muted">
                Facebook shows the first link as a link preview: <span className="break-all font-medium text-foreground">{link}</span>
              </p>
            )}
          </>
        )}
      </div>
      <figcaption className={cn("mt-2 text-xs", counter.over ? "font-medium text-bad-fg" : "text-muted")}>
        {counter.text}
        {counter.over && ". Shorten the text to schedule this post."}
      </figcaption>
    </figure>
  );
}
