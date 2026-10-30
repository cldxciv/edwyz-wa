import { RuleBuilder } from "@/components/automation/RuleBuilder";

export const metadata = { title: "Edit rule" };

export default async function EditRulePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RuleBuilder ruleId={id} />;
}
