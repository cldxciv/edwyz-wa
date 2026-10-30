import { ContactsView } from "@/components/contacts/ContactsView";

export const metadata = { title: "Contacts" };

type Search = { add?: string | string[]; segment?: string | string[] };
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function ContactsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const { add, segment } = await searchParams;
  return <ContactsView openAdd={first(add) === "1"} initialSegment={first(segment)?.slice(0, 100)} />;
}
