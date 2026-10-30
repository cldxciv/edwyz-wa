import { ChatbotBuilder } from "@/components/chatbots/ChatbotBuilder";

export const metadata = { title: "Edit chatbot" };

export default async function EditChatbotPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ChatbotBuilder id={id} />;
}
