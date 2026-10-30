import { notFound } from "next/navigation";

export const metadata = { title: "Page not found" };

/**
 * Catches every address under /app that no page claims. Without it Next answers those with the public site's 404 outside the
 * workspace shell; with it the request reaches the workspace's own not-found page, which offers the way back to /app.
 */
export default function AppCatchAll(): never {
  notFound();
}
