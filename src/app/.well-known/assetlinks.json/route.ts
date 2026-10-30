import { assetLinksResponse } from "@/lib/android/asset-links";

// Read per request so the fingerprints follow the server's .env (set or changed with a restart, no rebuild).
export const dynamic = "force-dynamic";

export function GET() {
  return assetLinksResponse();
}
