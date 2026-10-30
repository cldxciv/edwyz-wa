import { buttonSizes, buttonVariants, cn } from "@/components/ui";

const base = "inline-flex items-center justify-center gap-2 rounded-full font-semibold whitespace-nowrap select-none transition-colors duration-(--dur-fast)";

/** Class names that make a Next.js Link look and size like a Button, so navigation stays a real link. */
export function linkButton(variant: keyof typeof buttonVariants = "secondary", size: keyof typeof buttonSizes = "md", extra?: string): string {
  return cn(base, buttonVariants[variant], buttonSizes[size], extra);
}
