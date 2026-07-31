import type { HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium tracking-wide",
  {
    variants: {
      variant: {
        default: "bg-bg-subtle text-fg-muted",
        accent: "bg-accent/15 text-fg",
        ready: "bg-status-ready/15 text-status-ready",
        running: "bg-status-running/15 text-status-running",
        human: "bg-status-human/15 text-status-human",
        review: "bg-status-review/15 text-status-review",
        done: "bg-status-done/20 text-fg-muted",
        blocked: "bg-status-blocked/15 text-status-blocked",
        p0: "bg-status-blocked/20 text-status-blocked",
        p1: "bg-status-human/20 text-status-human",
        p2: "bg-status-ready/15 text-status-ready",
        p3: "bg-bg-subtle text-fg-subtle",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export function Badge({
  className,
  variant,
  ...props
}: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}
