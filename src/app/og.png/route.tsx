import { ImageResponse } from "next/og";
import { OG_IMAGE, TAGLINE } from "@/components/site/seo";
import { COMPANY } from "@/lib/config";

/**
 * The preview image for shares on WhatsApp, LinkedIn and X. Every public page points its og:image and twitter:image here
 * (see pageMetadata in src/components/site/seo.ts). The picture carries no URL, so it is safe to generate at build time.
 */
export function GET() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: 72,
        background: "linear-gradient(135deg, #064e3b 0%, #065f46 60%, #047857 100%)",
        color: "#ffffff",
        fontFamily: "sans-serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
        <div style={{ display: "flex", width: 64, height: 64, borderRadius: 18, background: "#ffffff", alignItems: "center", justifyContent: "center" }}>
          <div style={{ display: "flex", width: 28, height: 28, borderRadius: 14, border: "4px solid #047857" }} />
        </div>
        <div style={{ display: "flex", fontSize: 44, fontWeight: 700 }}>{COMPANY.product}</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        <div style={{ display: "flex", fontSize: 68, fontWeight: 700, lineHeight: 1.1, letterSpacing: -1 }}>Run customer chats on WhatsApp as a team</div>
        <div style={{ display: "flex", fontSize: 30, color: "#d1fae5", lineHeight: 1.35 }}>{TAGLINE}</div>
      </div>
      <div style={{ display: "flex", fontSize: 26, color: "#a7f3d0" }}>Free trial. No card needed to start.</div>
    </div>,
    { width: OG_IMAGE.width, height: OG_IMAGE.height },
  );
}
