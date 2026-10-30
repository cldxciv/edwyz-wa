import { AiToolsView } from "@/components/byo-mcp/AiToolsView";
import { EddySettingsCard } from "@/components/eddy/EddySettingsCard";

export const metadata = { title: "AI tools" };

export default function AiToolsPage() {
  return (
    <div className="flex flex-col gap-8">
      <AiToolsView />
      {/* Eddy, the in-app AI helper: the owner's on/off switch (docs/EDDY-SPEC.md 12.1a decision 6). */}
      <EddySettingsCard />
    </div>
  );
}
