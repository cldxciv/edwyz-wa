import { ExecutionLog } from "@/components/automation/ExecutionLog";

export const metadata = { title: "Rule history" };

export default async function RuleHistoryPage({ searchParams }: { searchParams: Promise<{ rule?: string | string[] }> }) {
  const { rule } = await searchParams;
  return <ExecutionLog initialRuleId={Array.isArray(rule) ? rule[0] : rule} />;
}
