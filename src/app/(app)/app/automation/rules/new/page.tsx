import { RuleBuilder } from "@/components/automation/RuleBuilder";

export const metadata = { title: "New rule" };

export default async function NewRulePage({ searchParams }: { searchParams: Promise<{ starter?: string | string[] }> }) {
  const { starter } = await searchParams;
  return <RuleBuilder starterId={Array.isArray(starter) ? starter[0] : starter} />;
}
