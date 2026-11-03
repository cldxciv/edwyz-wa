import { TemplateDetail } from "@/components/templates/TemplateDetail";

export const metadata = { title: "Template" };

export default async function TemplatePage({ params }: { params: Promise<{ id: string }> }) {
  return <TemplateDetail id={(await params).id} />;
}
