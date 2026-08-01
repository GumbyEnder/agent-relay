import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";

export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="grid min-h-dvh place-items-center bg-bg px-4 text-fg">
      <div className="w-full max-w-sm space-y-6 rounded-[var(--radius-md)] border border-border bg-bg-elevated p-6 shadow-[var(--shadow-panel)]">
        <div className="space-y-1">
          <Link to="/" className="text-[11px] font-medium uppercase tracking-wider text-fg-subtle hover:text-fg">
            Dev Boards
          </Link>
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
          {subtitle ? <p className="text-sm text-fg-muted">{subtitle}</p> : null}
        </div>
        {children}
        {footer ? <div className="space-y-2 text-center text-xs text-fg-muted">{footer}</div> : null}
      </div>
    </div>
  );
}
