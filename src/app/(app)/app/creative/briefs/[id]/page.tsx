import { BriefWorkspace } from "@/components/creative/BriefWorkspace";

export const metadata = { title: "Creative brief" };

export default async function BriefPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <BriefWorkspace briefId={id} />;
}
