import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { HttpError } from "@/lib/tenancy";

export const ALLOWED_PORTS = [443, 8443];

export type Resolver = (hostname: string) => Promise<string[]>;

export const defaultResolver: Resolver = async (hostname) => (await dnsLookup(hostname, { all: true, verbatim: true })).map((r) => r.address);

function ipv4ToNumbers(ip: string): number[] | null {
  const parts = ip.split(".").map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? parts : null;
}

function isPrivateV4(ip: string): boolean {
  const p = ipv4ToNumbers(ip);
  if (!p) return true;
  const [a, b, c] = p;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

/** Expands any IPv6 text form into 8 sixteen-bit groups; null when malformed. */
function expandV6(ip: string): number[] | null {
  let text = ip.split("%")[0].toLowerCase();
  const tail = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const v4 = ipv4ToNumbers(tail[1]);
    if (!v4) return null;
    text = text.slice(0, -tail[1].length) + ((v4[0] << 8) | v4[1]).toString(16) + ":" + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest].map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return groups.length === 8 && groups.every((g) => !Number.isNaN(g)) ? groups : null;
}

const v4FromGroups = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

function isPrivateV6(ip: string): boolean {
  const g = expandV6(ip);
  if (!g) return true;
  const allZeroUntil = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (allZeroUntil(7) && g[7] <= 1) return true; // :: and ::1
  if (allZeroUntil(5) && g[5] === 0xffff) return isPrivateV4(v4FromGroups(g[6], g[7])); // IPv4-mapped
  if (allZeroUntil(6)) return isPrivateV4(v4FromGroups(g[6], g[7])); // IPv4-compatible
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPrivateV4(v4FromGroups(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return isPrivateV4(v4FromGroups(g[1], g[2])); // 6to4
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // link local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  return false;
}

/** True for any address that must never be reached from a webhook delivery. Unparseable input counts as private. */
export function isPrivateAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "");
  const kind = isIP(ip);
  if (kind === 4) return isPrivateV4(ip);
  if (kind === 6) return isPrivateV6(ip);
  return true;
}

const BLOCKED_NAMES = [/^localhost$/, /\.localhost$/, /\.local$/, /\.internal$/, /\.localdomain$/, /^metadata(\.|$)/];

export type SafeUrl = { url: URL; hostname: string; port: number };

/** Static checks on the URL itself: https only, allowed port, no credentials, no obviously internal host names. `noun` names what the URL is for in messages. */
export function parseWebhookUrl(raw: string, noun = "Webhook URLs"): SafeUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, "Enter a valid URL.");
  }
  if (url.protocol !== "https:") throw new HttpError(400, `${noun} must use https.`);
  if (url.username || url.password) throw new HttpError(400, `${noun} cannot contain credentials.`);
  const port = url.port ? Number(url.port) : 443;
  if (!ALLOWED_PORTS.includes(port)) throw new HttpError(400, `${noun} must use port 443 or 8443.`);
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (!hostname || BLOCKED_NAMES.some((re) => re.test(hostname))) throw new HttpError(400, "That host is not allowed.");
  if (isIP(hostname) && isPrivateAddress(hostname)) throw new HttpError(400, "That address is not allowed.");
  if (url.href.length > 2048) throw new HttpError(400, "The URL is too long.");
  return { url, hostname, port };
}

/** Resolves the host and rejects when ANY address is private. Returns the validated addresses for pinning. */
export async function assertPublicUrl(raw: string, resolve: Resolver = defaultResolver, noun?: string): Promise<SafeUrl & { addresses: string[] }> {
  const safe = parseWebhookUrl(raw, noun);
  if (isIP(safe.hostname)) return { ...safe, addresses: [safe.hostname] };
  let addresses: string[];
  try {
    addresses = await resolve(safe.hostname);
  } catch {
    throw new HttpError(400, "That host could not be resolved.");
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) throw new HttpError(400, "That host resolves to a private or internal address.");
  return { ...safe, addresses };
}
