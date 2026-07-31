import { useEffect, useState } from "react";
import { formatRelative } from "@/lib/utils";

/** Client-only relative time to avoid SSR/client Date.now() mismatches. */
export function RelativeTime({
  ts,
  className,
  empty = "—",
}: {
  ts: number | null | undefined;
  className?: string;
  empty?: string;
}) {
  const [label, setLabel] = useState(empty);

  useEffect(() => {
    if (ts == null) {
      setLabel(empty);
      return;
    }
    const tick = () => setLabel(formatRelative(ts));
    tick();
    const id = window.setInterval(tick, 15_000);
    return () => window.clearInterval(id);
  }, [ts, empty]);

  return (
    <span className={className} suppressHydrationWarning>
      {label}
    </span>
  );
}
