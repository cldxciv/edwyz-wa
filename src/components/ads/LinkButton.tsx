import Link from "next/link";
import type { ComponentProps } from "react";
import { buttonSizes, buttonVariants, cn } from "@/components/ui";

type Props = ComponentProps<typeof Link> & { variant?: keyof typeof buttonVariants; size?: keyof typeof buttonSizes };

/** A link that looks like a Button, for navigation (use Button for actions). */
export function LinkButton({ variant = "primary", size = "md", className, ...props }: Props) {
  return (
    <Link
      className={cn("inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-full font-semibold transition-colors duration-(--dur-fast)", buttonVariants[variant], buttonSizes[size], className)}
      {...props}
    />
  );
}
