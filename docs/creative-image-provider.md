# Creative Studio: HTTP image provider contract

Creative Studio draws ad images through a provider. The default is the built-in placeholder (a flat SVG with the headline, free, marked PLACEHOLDER). To use a real image model, point Creative Studio at any service that follows the contract below. We do not name or endorse a vendor; a small adapter service in front of your chosen model is enough.

## Configuration

| Variable | Meaning |
|---|---|
| `CREATIVE_IMAGE_PROVIDER=http` | Selects this provider. Leave as `placeholder` to keep the free placeholder. |
| `CREATIVE_IMAGE_URL` | The https endpoint that receives the request. Port 443 or 8443, a public host name (private, loopback and link-local addresses are refused). |
| `CREATIVE_IMAGE_KEY` | Secret sent as `Authorization: Bearer <key>`. Never logged, never returned by any API. |

Restart the web process and the worker after changing them.

## Request

`POST CREATIVE_IMAGE_URL`, `content-type: application/json`, 60 second limit, no redirects followed.

```json
{
  "prompt": "Advertising image for \"Acme Dental\". Smiling family at the clinic door",
  "headline": "Free first check-up",
  "brand": { "name": "Acme Dental", "colors": ["#0a7d6e", "#ffffff"] },
  "placement": "feed",
  "width": 1080,
  "height": 1350
}
```

`placement` is `feed`, `square`, `story` or `reel`. The request never contains a workspace id, a user id or any contact data.

## Response

HTTP 200 with JSON, either the image inline:

```json
{ "image_base64": "<base64 of a PNG, JPEG or WebP file>" }
```

or a link to it:

```json
{ "image_url": "https://cdn.example.com/out/abc.png" }
```

A link is fetched with the same rules (https, public host, no redirects). Limits: the image must be at most 8 MB and the whole JSON answer at most about 11 MB. The real file type is read from the first bytes; only PNG, JPEG and WebP are accepted, whatever the service says in headers.

## Credits and fallback

A successful image costs the workspace 5 AI credits (`CREDIT_COST.image` in `src/lib/usage.ts`), after the file has been stored. Credits are checked against the plan before the call. If the service is not configured, times out, answers anything other than 200, sends something that is not a usable image, or the link is refused, Creative Studio stores the placeholder instead, records the asset as made by `placeholder` and charges nothing.

## Not covered

Video generation is not available (no video provider is configured). Meta rejects SVG files as ad images, so a placeholder asset must be replaced with a real picture before it can run as an ad.
