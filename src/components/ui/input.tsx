import * as React from "react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, type, ...props }, ref) => (
  <input
    type={type}
    className={cn(
      "flex h-10 w-full rounded-[var(--radius-sm)] bg-bg-subtle px-3 py-2 text-sm text-fg shadow-[var(--shadow-border)] placeholder:text-fg-subtle outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
      className,
    )}
    ref={ref}
    {...props}
  />
));
Input.displayName = "Input";

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    className={cn(
      "flex min-h-24 w-full rounded-[var(--radius-sm)] bg-bg-subtle px-3 py-2 text-sm text-fg shadow-[var(--shadow-border)] placeholder:text-fg-subtle outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 resize-y",
      className,
    )}
    ref={ref}
    {...props}
  />
));
Textarea.displayName = "Textarea";
