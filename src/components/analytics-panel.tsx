import { useMemo, useState } from "react";
import { BarChart3 } from "lucide-react";
import { useBoard } from "@/lib/store";
import { isAllBoardsScope } from "@/lib/board-scope";
import { cn } from "@/lib/utils";

type WindowH = 24 | 168;

function BarRow({
  label,
  value,
  max,
  color = "var(--color-accent)",
}: {
  label: string;
  value: number;
  max: number;
  color?: string;
}) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="truncate text-fg-muted">{label}</span>
        <span className="font-mono tabular text-fg">{value}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-bg-subtle">
        <div
          className="h-full rounded-full transition-[width] duration-300"
          style={{
            width: `${Math.max(pct, value > 0 ? 4 : 0)}%`,
            background: color,
          }}
        />
      </div>
    </div>
  );
}

function StatTile({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-[var(--radius-md)] border border-border bg-bg-elevated/60 px-3 py-3 shadow-[var(--shadow-border)]">
      <p className="text-[10px] font-medium uppercase tracking-wider text-fg-subtle">
        {label}
      </p>
      <p className="mt-1 font-mono text-2xl tabular text-fg">{value}</p>
      {hint ? <p className="mt-0.5 text-[10px] text-fg-subtle">{hint}</p> : null}
    </div>
  );
}

/**
 * High-polish analytics from board snapshot data (events, missions, usage).
 */
export function AnalyticsPanel() {
  const { missions, events, agents, projects, calls, selectedProjectId } = useBoard();
  const [windowH, setWindowH] = useState<WindowH>(24);

  const scopeLabel = isAllBoardsScope(selectedProjectId)
    ? "All boards"
    : projects.find((p) => p.id === selectedProjectId)?.name ?? "Board";

  const since = Date.now() - windowH * 3600_000;

  const stats = useMemo(() => {
    const ev = events.filter((e) => e.at >= since);
    const byKind: Record<string, number> = {};
    for (const e of ev) {
      byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    }
    const claims = byKind.mission_claimed ?? 0;
    const deliveries = byKind.delivery ?? 0;
    const escalations = byKind.escalation ?? 0;
    const heartbeats = (byKind.heartbeat ?? 0) + (byKind.progress ?? 0);
    const created = byKind.mission_created ?? 0;

    const agentActivity: Record<string, number> = {};
    for (const e of ev) {
      if (!e.agentId) continue;
      agentActivity[e.agentId] = (agentActivity[e.agentId] ?? 0) + 1;
    }
    const agentRows = Object.entries(agentActivity)
      .map(([id, n]) => ({
        id,
        name: agents.find((a) => a.id === id)?.name ?? id,
        n,
      }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 8);

    const byColumn: Record<string, number> = {};
    for (const m of missions) {
      byColumn[m.column] = (byColumn[m.column] ?? 0) + 1;
    }

    let tokensIn = 0;
    let tokensOut = 0;
    let usageN = 0;
    let usd = 0;
    for (const m of missions) {
      if (!m.usage) continue;
      usageN += 1;
      tokensIn += m.usage.tokensIn ?? 0;
      tokensOut += m.usage.tokensOut ?? 0;
      usd += m.usage.estimatedUsd ?? 0;
    }

    const openCalls = calls.filter((c) => !c.resolvedAt).length;
    const buckets = 12;
    const bucketMs = (windowH * 3600_000) / buckets;
    const series = Array.from({ length: buckets }, (_, i) => {
      const start = since + i * bucketMs;
      const end = start + bucketMs;
      const slice = ev.filter((e) => e.at >= start && e.at < end);
      return {
        i,
        claims: slice.filter((e) => e.kind === "mission_claimed").length,
        deliveries: slice.filter((e) => e.kind === "delivery").length,
        escalations: slice.filter((e) => e.kind === "escalation").length,
      };
    });
    const seriesMax = Math.max(
      1,
      ...series.flatMap((s) => [s.claims, s.deliveries, s.escalations]),
    );

    return {
      claims,
      deliveries,
      escalations,
      heartbeats,
      created,
      agentRows,
      byColumn,
      tokensIn,
      tokensOut,
      usageN,
      usd,
      openCalls,
      series,
      seriesMax,
      agentMax: Math.max(1, ...agentRows.map((r) => r.n)),
      columnMax: Math.max(1, ...Object.values(byColumn)),
    };
  }, [events, missions, agents, calls, since, windowH]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-thin">
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-fg-muted" />
          <div>
            <h2 className="text-sm font-medium text-fg">Analytics</h2>
            <p className="text-[11px] text-fg-subtle">
              {scopeLabel} · agent ops at a glance
            </p>
          </div>
        </div>
        <div
          className="ml-auto inline-flex rounded-[var(--radius-sm)] border border-border bg-bg-subtle p-0.5"
          role="group"
          aria-label="Analytics window"
        >
          {(
            [
              [24, "24h"],
              [168, "7d"],
            ] as const
          ).map(([h, label]) => (
            <button
              key={h}
              type="button"
              onClick={() => setWindowH(h)}
              className={cn(
                "rounded-[var(--radius-xs)] px-3 py-1.5 text-[11px] font-medium transition-colors",
                windowH === h
                  ? "bg-accent text-accent-fg"
                  : "text-fg-muted hover:text-fg",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      <div className="space-y-6 p-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <StatTile label="Claims" value={stats.claims} hint={`last ${windowH === 24 ? "24h" : "7d"}`} />
          <StatTile label="Deliveries" value={stats.deliveries} />
          <StatTile label="Escalations" value={stats.escalations} />
          <StatTile label="Heartbeats" value={stats.heartbeats} />
          <StatTile label="Created" value={stats.created} />
          <StatTile label="Open calls" value={stats.openCalls} hint="now" />
        </div>

        <section className="rounded-[var(--radius-lg)] border border-border bg-bg-elevated/40 p-4 shadow-[var(--shadow-border)]">
          <h3 className="text-xs font-medium uppercase tracking-wider text-fg-subtle">
            Throughput over time
          </h3>
          <p className="mt-0.5 text-[11px] text-fg-muted">
            Claims · deliveries · escalations
          </p>
          <div className="mt-4 flex h-36 items-end gap-1 sm:gap-1.5">
            {stats.series.map((s) => (
              <div
                key={s.i}
                className="flex min-w-0 flex-1 flex-col items-stretch justify-end gap-0.5"
                title={`c${s.claims} d${s.deliveries} e${s.escalations}`}
              >
                <div
                  className="w-full rounded-t-sm bg-status-ready/80"
                  style={{
                    height: `${(s.claims / stats.seriesMax) * 100}%`,
                    minHeight: s.claims ? 3 : 0,
                  }}
                />
                <div
                  className="w-full bg-status-running/80"
                  style={{
                    height: `${(s.deliveries / stats.seriesMax) * 100}%`,
                    minHeight: s.deliveries ? 3 : 0,
                  }}
                />
                <div
                  className="w-full rounded-b-sm bg-status-human/80"
                  style={{
                    height: `${(s.escalations / stats.seriesMax) * 100}%`,
                    minHeight: s.escalations ? 3 : 0,
                  }}
                />
              </div>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-fg-subtle">
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-sm bg-status-ready" /> claims
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-sm bg-status-running" /> deliveries
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-sm bg-status-human" /> escalations
            </span>
          </div>
        </section>

        <div className="grid gap-4 lg:grid-cols-2">
          <section className="rounded-[var(--radius-lg)] border border-border bg-bg-elevated/40 p-4 shadow-[var(--shadow-border)]">
            <h3 className="text-xs font-medium uppercase tracking-wider text-fg-subtle">
              Per-agent activity
            </h3>
            <div className="mt-3 space-y-2.5">
              {stats.agentRows.length === 0 && (
                <p className="text-xs text-fg-subtle">No agent events in window</p>
              )}
              {stats.agentRows.map((r) => (
                <BarRow
                  key={r.id}
                  label={r.name}
                  value={r.n}
                  max={stats.agentMax}
                  color="var(--color-status-ready)"
                />
              ))}
            </div>
          </section>

          <section className="rounded-[var(--radius-lg)] border border-border bg-bg-elevated/40 p-4 shadow-[var(--shadow-border)]">
            <h3 className="text-xs font-medium uppercase tracking-wider text-fg-subtle">
              Column mix
            </h3>
            <div className="mt-3 space-y-2.5">
              {Object.entries(stats.byColumn)
                .sort((a, b) => b[1] - a[1])
                .map(([col, n]) => (
                  <BarRow
                    key={col}
                    label={col.replace(/_/g, " ")}
                    value={n}
                    max={stats.columnMax}
                    color="var(--color-status-running)"
                  />
                ))}
              {Object.keys(stats.byColumn).length === 0 && (
                <p className="text-xs text-fg-subtle">No missions in scope</p>
              )}
            </div>
          </section>
        </div>

        <section className="rounded-[var(--radius-lg)] border border-border bg-bg-elevated/40 p-4 shadow-[var(--shadow-border)]">
          <h3 className="text-xs font-medium uppercase tracking-wider text-fg-subtle">
            Delivered usage
          </h3>
          <p className="mt-0.5 text-[11px] text-fg-muted">
            Self-reported on deliver · not billing truth
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <StatTile label="Missions w/ usage" value={stats.usageN} />
            <StatTile label="Tokens in" value={stats.tokensIn} />
            <StatTile label="Tokens out" value={stats.tokensOut} />
            <StatTile
              label="Est. USD"
              value={stats.usd ? `$${stats.usd.toFixed(2)}` : "—"}
            />
          </div>
        </section>
      </div>
    </div>
  );
}
