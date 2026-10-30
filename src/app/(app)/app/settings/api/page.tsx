import type { Metadata } from "next";
import { ApiSettings } from "@/components/integrations/ApiSettings";

export const metadata: Metadata = { title: "API and webhooks" };

export default function ApiSettingsPage() {
  return <ApiSettings />;
}
