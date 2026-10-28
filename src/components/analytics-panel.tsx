import { useEffect, useMemo, useState } from "react";
import { BarChart3 } from "lucide-react";
import { useBoard } from "@/lib/store";
import { isAllBoardsScope } from "@/lib/board-scope";
import { COLUMNS, type Mission } from "@/lib/types";
import { cn } from "@/lib/utils";

type WindowH = 24 | 168;

const BUCKETS = 12;

function fmtClock(at: number): string {
  const d = new Date(at);
  const sameDay = Date.now() - at < 24 * 3600_000;
  return sameDay
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function fmtDur(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

function BarRow({
  label,
  value,
  max,
  color = "var(--color-accent)",
  hint,
}: {
  label: string;
  value: number;
  max: number;
  color?: string;
  hint?: string;
}) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="truncate text-fg-muted">
          {label}
          {hint ? <span className="ml-1.5 text-fg-subtle">{hint}</span> : null}
        </span>
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

/** 100%-stacked outcome bar per agent: delivered / escalated / still open. */
function RateBar({
  delivered,
  escalated,
  other,
}: {
  delivered: number;
  escalated: number;
  other: number;
}) {
  const total = Math.max(1, delivered + escalated + other);
  const seg = (n: number) => `${(n / total) * 100}%`;
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-bg-subtle">
      <div
        className="h-full bg-status-ready"
        style={{ width: seg(delivered) }}
        title={`${delivered} delivered`}
      />
      <div
        className="h-full bg-status-human"
        style={{ width: seg(escalated) }}
        title={`${escalated} escalated`}
      />
      <div
        className="h-full bg-fg-subtle/40"
        style={{ width: seg(other) }}
        title={`${other} in flight / other`}
      />
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

interface AgentStats {
  id: string;
  name: string;
  claims: number;
  deliveries: number;
  escalations: number;
  activity: number; // work events, excludes heartbeat/progress
  tokensIn: number;
  tokensOut: number;
  usd: number;
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[s[mid - 1]] + s[s[mid]]) / 2;
}

/**
 * Analytics from board snapshot data (events, missions, usage).
 * All stats respect the selected window and board scope.
 */
export function AnalyticsPanel() {
  const { missions, events, agents, projects, calls, selectedProjectId } = useBoard();
  const [windowH, setWindowH] = useState<WindowH>(24);
  // Ticking `now` keeps the window honest on long-open tabs AND gives useMemo a
  // stable dep per interval (a raw Date.now() dep would defeat the memo).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const scopeLabel = isAllBoardsScope(selectedProjectId)
    ? "All boards"
    : projects.find((p) => p.id === selectedProjectId)?.name ?? "Board";

  const since = now - windowH * 3600_000;

  const stats = useMemo(() => {
    const ev = events.filter((e) => e.at >= since && e.at <= now);
    const byKind: Record<string, number> = {};
    for (const e of ev) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    const claims = byKind.mission_claimed ?? 0;
    const deliveries = byKind.delivery ?? 0;
    const escalations = byKind.escalation ?? 0;
    const created = byKind.mission_created ?? 0;

    // Completions + velocity: boards that move cards to done without an agent
    // claim/deliver lifecycle (e.g. ingest flows) have no delivery events, so
    // count done missions updated in-window instead.
    const days = windowH / 24;
    const doneMissions = missions.filter(
      (m) => m.column === "done" && m.updatedAt >= since && m.updatedAt <= now,
    );
    const completed = doneMissions.length;
    const velocity = completed / days;

    // Mission lookup for usage + cycle-time attribution.
    const missionById = new Map<string, Mission>(missions.map((m) => [m.id, m]));

    const perAgent: Record<string, AgentStats> = {};
    const agentStat = (id: string | null): AgentStats | null => {
      if (!id) return null;
      if (!perAgent[id])
        perAgent[id] = {
          id,
          name: agents.find((a) => a.id === id)?.name ?? id,
          claims: 0,
          deliveries: 0,
          escalations: 0,
          activity: 0,
          tokensIn: 0,
          tokensOut: 0,
          usd: 0,
        };
      return perAgent[id];
    };
    for (const e of ev) {
      const a = agentStat(e.agentId);
      if (!a) continue;
      if (e.kind !== "heartbeat" && e.kind !== "progress") a.activity += 1;
      if (e.kind === "mission_claimed") a.claims += 1;
      if (e.kind === "delivery") {
        a.deliveries += 1;
        const m = e.missionId ? missionById.get(e.missionId) : undefined;
        if (m?.usage) {
          a.tokensIn += m.usage.tokensIn ?? 0;
          a.tokensOut += m.usage.tokensOut ?? 0;
          a.usd += m.usage.estimatedUsd ?? 0;
        }
      }
      if (e.kind === "escalation") a.escalations += 1;
    }
    const agentRows = Object.values(perAgent)
      .sort((a, b) => b.deliveries - a.deliveries || b.activity - a.activity)
      .slice(0, 8);

    // Cycle time: delivery event -> its mission's claimedAt.
    const cycleMs: number[] = [];
    for (const e of ev) {
      if (e.kind !== "delivery" || !e.missionId) continue;
      const m = missionById.get(e.missionId);
      if (m?.claimedAt) {
        const dur = e.at - m.claimedAt;
        if (dur >= 0) cycleMs.push(dur);
      }
    }
    const medianCycle = median(cycleMs);

    // Windowed usage totals, attributed via delivery events.
    let tokensIn = 0;
    let tokensOut = 0;
    let usageN = 0;
    let usd = 0;
    for (const a of Object.values(perAgent)) {
      tokensIn += a.tokensIn;
      tokensOut += a.tokensOut;
      usd += a.usd;
      if (a.deliveries > 0) usageN += a.deliveries;
    }

    const openCalls = calls.filter((c) => !c.resolvedAt).length;

    // Buckets stacked by total volume so the column never overflows.
    const bucketMs = (now - since) / BUCKETS;
    const series = Array.from({ length: BUCKETS }, (_, i) => {
      const start = since + i * bucketMs;
      const end = start + bucketMs;
      const slice = ev.filter((e) => e.at >= start && e.at < end);
      return {
        i,
        start,
        end,
        created: slice.filter((e) => e.kind === "mission_created").length,
        claims: slice.filter((e) => e.kind === "mission_claimed").length,
        deliveries: slice.filter((e) => e.kind === "delivery").length,
        escalations: slice.filter((e) => e.kind === "escalation").length,
      };
    });
    const stackMax = Math.max(
      1,
      ...series.map((s) => s.created + s.claims + s.deliveries + s.escalations),
    );

    // Column mix is current board state (not windowed) — labeled "now" in UI.
    const byColumn: Record<string, number> = {};
    for (const m of missions) byColumn[m.column] = (byColumn[m.column] ?? 0) + 1;

    return {
      claims,
      deliveries,
      escalations,
      created,
      completed,
      velocity,
      agentRows,
      medianCycle,
      tokensIn,
      tokensOut,
      usageN,
      usd,
      openCalls,
      series,
      stackMax,
      byColumn,
      columnMax: Math.max(1, ...Object.values(byColumn)),
    };
  }, [events, missions, agents, calls, since, now]);

  const windowLabel = windowH === 24 ? "24h" : "7d";

  return (
    // Match Calls/Agents: h-full shell + scroll on the body. Parent clips with
    // overflow-hidden; putting overflow on a content-sized root never scrolls.
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <BarChart3 className="h-4 w-4 shrink-0 text-fg-muted" />
          <div className="min-w-0">
            <h2 className="text-sm font-medium text-fg">Analytics</h2>
            <p className="text-[11px] text-fg-subtle">
              {scopeLabel} · agent ops at a glance
            </p>
          </div>
          <button
            type="button"
            className="ml-2 shrink-0 rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-2.5 py-1 text-[11px] font-medium text-fg-muted hover:text-fg"
            onClick={() => {
              void (async () => {
                try {
                  const { agentApi } = await import("@/lib/api-client");
                  const res = await agentApi.boardSummary(
                    isAllBoardsScope(selectedProjectId) ? null : selectedProjectId,
                  );
                  await navigator.clipboard.writeText(res.markdown);
                  const { toast } = await import("sonner");
                  toast.success("Ticket summary copied (markdown)");
                } catch (e) {
                  const { toast } = await import("sonner");
                  toast.error(e instanceof Error ? e.message : "Summary failed");
                }
              })();
            }}
          >
            Copy AI summary
          </button>
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

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4 scrollbar-thin">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          <StatTile label="Total tickets" value={stats.created} hint={`created · last ${windowLabel}`} />
          <StatTile label="Completed" value={stats.completed} hint={`done · last ${windowLabel}`} />
          <StatTile
            label="Velocity"
            value={stats.velocity.toFixed(1)}
            hint="done / day"
          />
          <StatTile
            label="Median cycle"
            value={stats.medianCycle ? fmtDur(stats.medianCycle) : "—"}
            hint="claim → deliver"
          />
          <StatTile label="Claims" value={stats.claims} hint={`last ${windowLabel}`} />
          <StatTile label="Deliveries" value={stats.deliveries} hint={`last ${windowLabel}`} />
          <StatTile label="Escalations" value={stats.escalations} hint={`last ${windowLabel}`} />
          <StatTile label="Open calls" value={stats.openCalls} hint="now" />
        </div>

        <section className="rounded-[var(--radius-lg)] border border-border bg-bg-elevated/40 p-4 shadow-[var(--shadow-border)]">
          <h3 className="text-xs font-medium uppercase tracking-wider text-fg-subtle">
            Throughput over time
          </h3>
          <p className="mt-0.5 text-[11px] text-fg-muted">
            Created · claims · deliveries · escalations, last {windowLabel}
          </p>
          <div className="mt-4 flex h-36 items-stretch gap-1 sm:gap-1.5">
            {stats.series.map((s) => {
              // Each segment is a share of the bucket's stacked total relative
              // to the max bucket total, so a column can never exceed 100%.
              const seg = (n: number) =>
                n > 0 ? `${Math.max((n / stats.stackMax) * 100, 2)}%` : "0%";
              const tip = `${fmtClock(s.start)}–${fmtClock(s.end)} · ${s.created} created · ${s.claims} claims · ${s.deliveries} deliveries · ${s.escalations} escalations`;
              return (
                <div
                  key={s.i}
                  className="flex min-w-0 flex-1 flex-col justify-end gap-0.5"
                  title={tip}
                >
                  <div
                    className="w-full rounded-t-sm bg-accent/80"
                    style={{ height: seg(s.created) }}
                  />
                  <div
                    className="w-full bg-status-ready/80"
                    style={{ height: seg(s.claims) }}
                  />
                  <div
                    className="w-full bg-status-running/80"
                    style={{ height: seg(s.deliveries) }}
                  />
                  <div
                    className="w-full rounded-b-sm bg-status-human/80"
                    style={{ height: seg(s.escalations) }}
                  />
                </div>
              );
            })}
          </div>
          <div className="mt-1 flex justify-between text-[10px] text-fg-subtle">
            <span>{fmtClock(stats.series[0]?.start ?? since)}</span>
            <span>{fmtClock((since + now) / 2)}</span>
            <span>now</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-fg-subtle">
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-sm bg-accent" /> created
            </span>
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
              Agent outcomes
            </h3>
            <p className="mt-0.5 text-[11px] text-fg-muted">
              Deliveries ✓ · escalations ⚠ · in flight, last {windowLabel}
            </p>
            <div className="mt-3 space-y-3">
              {stats.agentRows.length === 0 && (
                <p className="text-xs text-fg-subtle">No agent events in window</p>
              )}
              {stats.agentRows.map((r) => (
                <div key={r.id} className="space-y-1">
                  <div className="flex items-baseline justify-between gap-2 text-[11px]">
                    <span className="truncate text-fg-muted">{r.name}</span>
                    <span className="font-mono tabular text-fg">
                      {r.deliveries}✓ {r.escalations}⚠ {r.activity} ev
                    </span>
                  </div>
                  <RateBar
                    delivered={r.deliveries}
                    escalated={r.escalations}
                    other={Math.max(0, r.claims - r.deliveries - r.escalations)}
                  />
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-[var(--radius-lg)] border border-border bg-bg-elevated/40 p-4 shadow-[var(--shadow-border)]">
            <h3 className="text-xs font-medium uppercase tracking-wider text-fg-subtle">
              Agent usage
            </h3>
            <p className="mt-0.5 text-[11px] text-fg-muted">
              Self-reported on deliver · last {windowLabel} · not billing truth
            </p>
            <div className="mt-3 space-y-2.5">
              {stats.agentRows.filter((r) => r.deliveries > 0).length === 0 && (
                <p className="text-xs text-fg-subtle">No delivered usage in window</p>
              )}
              {stats.agentRows
                .filter((r) => r.deliveries > 0)
                .map((r) => (
                  <BarRow
                    key={r.id}
                    label={r.name}
                    value={r.usd > 0 ? Math.round(r.usd * 100) / 100 : r.tokensIn + r.tokensOut}
                    max={Math.max(
                      1,
                      ...stats.agentRows.map((x) =>
                        x.usd > 0 ? Math.round(x.usd * 100) / 100 : x.tokensIn + x.tokensOut,
                      ),
                    )}
                    color="var(--color-status-running)"
                    hint={`$${r.usd.toFixed(2)} · ${(r.tokensIn + r.tokensOut).toLocaleString()} tok`}
                  />
                ))}
            </div>
          </section>
        </div>

        <section className="rounded-[var(--radius-lg)] border border-border bg-bg-elevated/40 p-4 shadow-[var(--shadow-border)]">
          <h3 className="text-xs font-medium uppercase tracking-wider text-fg-subtle">
            Delivered usage — totals
          </h3>
          <p className="mt-0.5 text-[11px] text-fg-muted">
            Self-reported on deliver · last {windowLabel} · not billing truth
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <StatTile label="Deliveries w/ usage" value={stats.usageN} />
            <StatTile label="Tokens in" value={stats.tokensIn.toLocaleString()} />
            <StatTile label="Tokens out" value={stats.tokensOut.toLocaleString()} />
            <StatTile
              label="Est. USD"
              value={stats.usd ? `$${stats.usd.toFixed(2)}` : "—"}
            />
          </div>
        </section>

        <section className="rounded-[var(--radius-lg)] border border-border bg-bg-elevated/40 p-4 shadow-[var(--shadow-border)]">
          <h3 className="text-xs font-medium uppercase tracking-wider text-fg-subtle">
            Column mix
          </h3>
          <p className="mt-0.5 text-[11px] text-fg-muted">Current board state (now)</p>
          <div className="mt-3 space-y-2.5">
            {Object.entries(stats.byColumn)
              .sort(
                (a, b) =>
                  COLUMNS.findIndex((c) => c.id === b[0]) -
                  COLUMNS.findIndex((c) => c.id === a[0]),
              )
              .map(([col, n]) => (
                <BarRow
                  key={col}
                  label={COLUMNS.find((c) => c.id === col)?.label ?? col}
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
    </div>
  );
}
