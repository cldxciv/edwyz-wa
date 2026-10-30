import "./site.css";
import type { ReactNode } from "react";
import { serializeJsonLd } from "./seo";

/** Marks a page as one of the public pages that follows the light and dark theme in site.css. */
export function Pub({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`pub ${className}`.trim()}>{children}</div>;
}

export function JsonLd({ data }: { data: unknown }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }} />;
}
