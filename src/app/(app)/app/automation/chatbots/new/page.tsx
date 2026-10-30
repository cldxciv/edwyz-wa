import { ChatbotBuilder } from "@/components/chatbots/ChatbotBuilder";

export const metadata = { title: "New chatbot" };

export default async function NewChatbotPage({ searchParams }: { searchParams: Promise<{ starter?: string | string[] }> }) {
  const { starter } = await searchParams;
  return <ChatbotBuilder starter={Array.isArray(starter) ? starter[0] : starter} />;
}
