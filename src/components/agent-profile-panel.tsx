import { useEffect, useState } from "react";
import {
  Activity,
  CheckCircle2,
  Hand,
  HeartPulse,
  KeyRound,
  MessageSquareWarning,
  Radio,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RelativeTime } from "@/components/relative-time";
import { agentApi } from "@/lib/api-client";
import { useBoard } from "@/lib/store";
import type { AgentProfile, AgentProfileStats } from "@/lib/types";
import { COLUMN_STATUS_COLOR, HARNESS_LABELS } from "@/lib/types";
import { cn, formatTime } from "@/lib/utils";

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: number | string;
  hint?: string;
}) {
  return (
    <div className="rounded-[var(--radius-sm)] border border-border bg-bg-subtle/50 px-2.5 py-2">
      <p className="text-[10px] font-medium uppercase tracking-wider text-fg-subtle">
        {label}
      </p>
      <p className="mt-0.5 font-mono text-lg tabular text-fg">{value}</p>
      {hint ? <p className="text-[10px] text-fg-subtle">{hint}</p> : null}
    </div>
  );
}

function StatsGrid({ stats, title }: { stats: AgentProfileStats; title: string }) {
  return (
    <section className="space-y-2">
      <h4 className="text-[11px] font-medium uppercase tracking-wider text-fg-subtle">
        {title}
      </h4>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <StatCard label="Claims" value={stats.claims} />
        <StatCard label="Heartbeats" value={stats.heartbeats} />
        <StatCard label="Deliveries" value={stats.deliveries} />
        <StatCard label="Escalations" value={stats.escalations} />
        <StatCard label="Releases" value={stats.releases} />
        <StatCard label="Done signals" value={stats.missionsDone} />
      </div>
      {stats.lastActivityAt ? (
        <p className="text-[11px] text-fg-subtle">
          Last activity{" "}
          <span className="text-fg-muted">
            <RelativeTime ts={stats.lastActivityAt} />
          </span>{" "}
          · {formatTime(stats.lastActivityAt)}
        </p>
      ) : (
        <p className="text-[11px] text-fg-subtle">No activity in this window</p>
      )}
    </section>
  );
}

function kindIcon(kind: string) {
  if (kind.includes("claim")) return Hand;
  if (kind.includes("heartbeat") || kind.includes("progress")) return HeartPulse;
  if (kind.includes("deliver")) return CheckCircle2;
  if (kind.includes("escalat") || kind.includes("human")) return MessageSquareWarning;
  return Activity;
}

export function AgentProfilePanel({ agentId }: { agentId: string }) {
  const { projects, closePanel, openPanel } = useBoard();
  const [profile, setProfile] = useState<AgentProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [window, setWindow] = useState<"24h" | "7d">("24h");
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void agentApi
      .agentProfile(agentId)
      .then((res) => {
        if (cancelled) return;
        setProfile(res);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setProfile(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, reloadToken]);

  const boardName = (id: string) =>
    projects.find((p) => p.id === id)?.name ?? id;

  if (loading) {
    return (
      <div className="flex h-full flex-col">
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <p className="text-sm text-fg-muted">Loading agent…</p>
          <Button variant="ghost" size="icon-sm" onClick={closePanel} aria-label="Close">
            <X className="h-4 w-4" />
          </Button>
        </header>
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="flex h-full flex-col">
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <p className="text-sm text-status-blocked">{error ?? "Agent not found"}</p>
          <Button variant="ghost" size="icon-sm" onClick={closePanel} aria-label="Close">
            <X className="h-4 w-4" />
          </Button>
        </header>
      </div>
    );
  }

  const { agent, keys, stats24h, stats7d, activeMissions, recentActivity } = profile;
  const stats = window === "24h" ? stats24h : stats7d;
  const activeKeys = keys.filter((k) => !k.revokedAt);
  const primaryTip = agent.keyTips?.[0] ?? activeKeys[0];

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-4 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-mono text-base font-medium text-fg">{agent.name}</h2>
              <Badge variant="default">
                {HARNESS_LABELS[agent.harness] ?? agent.harness}
              </Badge>
              <span className="inline-flex items-center gap-1 text-[11px] text-fg-subtle">
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    agent.status === "busy"
                      ? "bg-status-running"
                      : agent.status === "online" || agent.status === "idle"
                        ? "bg-status-ready"
                        : agent.status === "error"
                          ? "bg-status-blocked"
                          : "bg-fg-subtle",
                  )}
                />
                {agent.status}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-fg-muted">{agent.role || "client"}</p>
            {primaryTip ? (
              <p className="mt-1.5 flex items-center gap-1.5 font-mono text-[11px] text-fg-subtle">
                <KeyRound className="h-3 w-3" />
                <span title={`${primaryTip.prefix}…${primaryTip.suffix}`}>
                  {primaryTip.prefix}…{primaryTip.suffix}
                </span>
                {activeKeys.length > 1 ? (
                  <span className="text-fg-subtle">· {activeKeys.length} keys</span>
                ) : null}
              </p>
            ) : (
              <p className="mt-1.5 text-[11px] text-fg-subtle">No API key bound yet</p>
            )}
          </div>
          <Button variant="ghost" size="icon-sm" onClick={closePanel} aria-label="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 scrollbar-thin">
        {(agent.boardIds?.length ?? 0) > 0 && (
          <section>
            <h4 className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-fg-subtle">
              Boards
            </h4>
            <div className="flex flex-wrap gap-1">
              {agent.boardIds!.map((id) => (
                <span
                  key={id}
                  className="rounded bg-bg-subtle px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-fg-subtle"
                >
                  {boardName(id)}
                </span>
              ))}
            </div>
          </section>
        )}

        {agent.skills.length > 0 && (
          <section>
            <h4 className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-fg-subtle">
              Skills
            </h4>
            <div className="flex flex-wrap gap-1">
              {agent.skills.map((s) => (
                <Badge key={s} variant="default">
                  {s}
                </Badge>
              ))}
            </div>
          </section>
        )}

        <div className="flex items-center justify-between gap-2">
          <h4 className="text-[11px] font-medium uppercase tracking-wider text-fg-subtle">
            Work stats
          </h4>
          <div
            className="inline-flex rounded-[var(--radius-sm)] border border-border bg-bg-subtle p-0.5"
            role="group"
            aria-label="Stats window"
          >
            {(["24h", "7d"] as const).map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => setWindow(w)}
                className={cn(
                  "rounded-[var(--radius-xs)] px-2.5 py-1 text-[11px] font-medium transition-colors",
                  window === w
                    ? "bg-accent text-accent-fg"
                    : "text-fg-muted hover:text-fg",
                )}
              >
                {w === "24h" ? "Last 24h" : "Last 7d"}
              </button>
            ))}
          </div>
        </div>
        <StatsGrid
          stats={stats}
          title={window === "24h" ? "Last 24 hours" : "Last 7 days"}
        />

        <section className="space-y-2">
          <h4 className="text-[11px] font-medium uppercase tracking-wider text-fg-subtle">
            Active missions · {activeMissions.length}
          </h4>
          {activeMissions.length === 0 ? (
            <p className="text-xs text-fg-subtle">No active missions</p>
          ) : (
            <ul className="divide-y divide-border rounded-[var(--radius-sm)] border border-border">
              {activeMissions.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    className="flex w-full items-start justify-between gap-2 px-3 py-2.5 text-left hover:bg-bg-subtle"
                    onClick={() => openPanel("mission", m.id)}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm text-fg">{m.title}</p>
                      <p className="text-[10px] text-fg-subtle">
                        {boardName(m.projectId)} · {m.priority.toUpperCase()}
                      </p>
                    </div>
                    <span
                      className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium"
                      style={{
                        background: `color-mix(in oklab, ${COLUMN_STATUS_COLOR[m.column]} 18%, transparent)`,
                        color: COLUMN_STATUS_COLOR[m.column],
                      }}
                    >
                      {m.column.replace(/_/g, " ")}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-2">
          <h4 className="text-[11px] font-medium uppercase tracking-wider text-fg-subtle">
            API keys
          </h4>
          {keys.length === 0 ? (
            <p className="text-xs text-fg-subtle">No keys issued for this agent</p>
          ) : (
            <ul className="space-y-1.5">
              {keys.map((k) => (
                <li
                  key={k.id}
                  className={cn(
                    "rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-2.5 py-2 text-[11px]",
                    k.revokedAt && "opacity-50",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-fg">
                      {k.prefix}…{k.suffix}
                    </span>
                    {k.revokedAt ? (
                      <Badge variant="done">revoked</Badge>
                    ) : (
                      <Badge variant="default">active</Badge>
                    )}
                  </div>
                  <p className="mt-0.5 text-fg-subtle">
                    {boardName(k.projectId)}
                    {k.lastUsedAt ? (
                      <>
                        {" "}
                        · last used <RelativeTime ts={k.lastUsedAt} />
                      </>
                    ) : (
                      " · never used"
                    )}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-2">
          <h4 className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-fg-subtle">
            <Radio className="h-3 w-3" />
            Recent activity
          </h4>
          {recentActivity.length === 0 ? (
            <p className="text-xs text-fg-subtle">No events yet</p>
          ) : (
            <ul className="space-y-0">
              {recentActivity.map((ev) => {
                const Icon = kindIcon(ev.kind);
                return (
                  <li
                    key={ev.id}
                    className="flex gap-2 border-b border-border/60 py-2 last:border-0"
                  >
                    <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-subtle" />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs leading-snug text-fg-muted">{ev.message}</p>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10px] text-fg-subtle">
                        <span className="tabular">
                          <RelativeTime ts={ev.at} />
                        </span>
                        <span className="font-mono">{ev.kind}</span>
                        {ev.missionId && (
                          <button
                            type="button"
                            className="truncate text-status-ready hover:underline"
                            onClick={() => openPanel("mission", ev.missionId!)}
                          >
                            {ev.missionTitle ?? ev.missionId}
                          </button>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <p className="text-[10px] text-fg-subtle">
          Profile id <span className="font-mono">{agent.id}</span>
          {" · "}
          <button
            type="button"
            className="underline-offset-2 hover:underline"
            onClick={() => setReloadToken((n) => n + 1)}
          >
            Refresh
          </button>
        </p>
      </div>
    </div>
  );
}
