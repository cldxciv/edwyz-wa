import Link from "next/link";
import { Button, Card } from "@/components/ui";
import { linkButton } from "@/components/automation/linkButton";
import { STARTERS, type Starter } from "./starters";

type Props = {
  /** Link to open the starter in the builder (used on the chatbot list). */
  hrefFor?: (starter: Starter) => string;
  /** Use the starter right here (used inside the builder). */
  onPick?: (starter: Starter) => void;
  headingLevel?: "h2" | "h3";
};

/** Ready-made chatbots. Each card says what the bot does so nobody has to open it to find out. */
export function StarterGallery({ hrefFor, onPick, headingLevel = "h3" }: Props) {
  return (
    <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {STARTERS.map((s) => (
        <li key={s.id} className="flex">
          <Card
            title={s.name}
            description={s.summary}
            headingLevel={headingLevel}
            className="flex w-full flex-col"
            footer={
              hrefFor ? (
                <Link href={hrefFor(s)} aria-label={`Use this template: ${s.name}`} className={linkButton("secondary", "md", "w-full")}>
                  Use this template
                </Link>
              ) : (
                <Button variant="secondary" className="w-full" aria-label={`Use this template: ${s.name}`} onClick={() => onPick?.(s)}>
                  Use this template
                </Button>
              )
            }
          >
            <ul className="space-y-1.5 text-sm text-muted">
              {s.steps.map((line) => (
                <li key={line} className="flex gap-2">
                  <span aria-hidden className="mt-2 h-1 w-1 shrink-0 rounded-full bg-muted" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </Card>
        </li>
      ))}
    </ul>
  );
}
