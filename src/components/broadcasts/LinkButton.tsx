import Link from "next/link";
import type { ComponentProps } from "react";
import { buttonSizes, buttonVariants, cn } from "@/components/ui";

/** A link that looks like a Button, for navigation that should read as an action. */
export function LinkButton({ variant = "primary", size = "md", className, ...props }: ComponentProps<typeof Link> & { variant?: keyof typeof buttonVariants; size?: keyof typeof buttonSizes }) {
  return (
    <Link
      className={cn("inline-flex items-center justify-center gap-2 rounded-full font-semibold whitespace-nowrap select-none transition-colors duration-(--dur-fast)", buttonVariants[variant], buttonSizes[size], className)}
      {...props}
    />
  );
}
