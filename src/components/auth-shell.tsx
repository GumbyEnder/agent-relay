import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { BZ_BRAND } from "@/lib/brand";

/** BeeZilla mascot expression mapped to auth surfaces (brief: 16-smiling → default/empty). */
function BeeZillaMark() {
  return (
    <span className="relative inline-flex items-center gap-2">
      <span
        aria-hidden
        className="bz-hex grid h-7 w-7 shrink-0 place-items-center bg-accent text-[13px] font-black text-accent-fg"
      >
        B
      </span>
      <img
        src="/brand/beezilla/expressions/revision6_expressions_16-smiling.png"
        alt=""
        aria-hidden
        className="h-12 w-12 object-contain drop-shadow-[0_2px_6px_rgba(0,0,0,0.6)]"
      />
    </span>
  );
}

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
    <div className={"grid min-h-dvh place-items-center bg-bg px-4 text-fg" + (BZ_BRAND ? " bz-corner-lines" : "")}>
      <div className="w-full max-w-sm space-y-6 rounded-[var(--radius-md)] border border-border bg-bg-elevated p-6 shadow-[var(--shadow-panel)]">
        <div className="space-y-1">
          <Link
            to="/"
            className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-fg-subtle hover:text-fg"
          >
            {BZ_BRAND ? <BeeZillaMark /> : null}
            <span>{BZ_BRAND ? "BeeZilla" : "Dev Boards"}</span>
          </Link>
          <h1 className="pt-2 text-lg font-semibold tracking-tight">{title}</h1>
          {subtitle ? <p className="text-sm text-fg-muted">{subtitle}</p> : null}
        </div>
        {children}
        {footer ? <div className="space-y-2 text-center text-xs text-fg-muted">{footer}</div> : null}
      </div>
    </div>
  );
}
