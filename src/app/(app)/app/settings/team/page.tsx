import type { Metadata } from "next";
import { TeamView } from "@/components/team/TeamView";
import { shouldOpenInvite } from "@/components/team/helpers";

export const metadata: Metadata = { title: "Team" };

export default async function TeamPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  return <TeamView openInviteOnLoad={shouldOpenInvite(params.invite)} />;
}
