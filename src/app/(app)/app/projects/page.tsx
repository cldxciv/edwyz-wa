import type { Metadata } from "next";
import { ProjectsView } from "@/components/projects/ProjectsView";

export const metadata: Metadata = { title: "All projects" };

/** Every workspace the person belongs to (one per project or client). ?new=1 opens the New project form. */
export default async function ProjectsPage({ searchParams }: { searchParams: Promise<{ new?: string | string[] }> }) {
  const { new: fresh } = await searchParams;
  return <ProjectsView startNew={(Array.isArray(fresh) ? fresh[0] : fresh) === "1"} />;
}
