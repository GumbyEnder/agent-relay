import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Bot,
  LayoutDashboard,
  MessageSquareWarning,
  Pause,
  Play,
  Radio,
  RefreshCw,
} from "lucide-react";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type {
  Agent,
  HumanCall,
  Mission,
  MissionColumn,
  MissionEvent,
  MissionHistoryEntry,
} from "@/lib/types";
import { COLUMN_STATUS_COLOR, COLUMNS, HARNESS_LABELS } from "@/lib/types";
import { cn, formatTime } from "@/lib/utils";
import { filterEvents, filterHistory } from "@/lib/filters";

interface AdminPayload {
  ok: boolean;
  serverTime: number;
  agents: Agent[];
  missions: Mission[];
  events: MissionEvent[];
  calls: HumanCall[];
  history: MissionHistoryEntry[];
  stats: {
    missions: number;
    agents: number;
    openCalls: number;
    events: number;
    history: number;
    byColumn: Record<string, number>;
  };
}

const POLL_MS = 1200;

function kindTone(kind: string): string {
  if (kind.includes("claim")) return "text-status-running";
  if (kind.includes("escalat") || kind.includes("human")) return "text-status-human";
  if (kind.includes("deliver") || kind.includes("review")) return "text-status-review";
  if (kind.includes("heartbeat") || kind.includes("progress")) return "text-status-ready";
  if (kind.includes("moved") || kind.includes("move")) return "text-fg";
  if (kind.includes("block")) return "text-status-blocked";
  return "text-fg-muted";
}

function columnLabel(id: string | null | undefined) {
  if (!id) return "—";
  return COLUMNS.find((c) => c.id === id)?.label ?? id.replace(/_/g, " ");
}

export function AdminPortal({
  projectId = null,
  embedded = false,
}: {
  projectId?: string | null;
  embedded?: boolean;
} = {}) {
  const [data, setData] = useState<AdminPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [lastOkAt, setLastOkAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const [flashIds, setFlashIds] = useState<Set<string>>(new Set());
  const seenEvents = useRef<Set<string>>(new Set());
  const seenHistory = useRef<Set<string>>(new Set());
  const bootstrapped = useRef(false);
  const [filterAgent, setFilterAgent] = useState<string>("");
  const [filterKind, setFilterKind] = useState<string>("");
  const [filterQuery, setFilterQuery] = useState("");

  const load = useCallback(async () => {
    try {
      const q = projectId ? `?project=${encodeURIComponent(projectId)}` : "";
      const res = await fetch(`/api/agent/admin${q}`, { cache: "no-store" });
      const json = (await res.json()) as AdminPayload & { error?: string };
      if (!res.ok || json.ok === false) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }

      const newEv: string[] = [];
      const newHist: string[] = [];
      if (bootstrapped.current) {
        for (const e of json.events ?? []) {
          if (!seenEvents.current.has(e.id)) newEv.push(e.id);
        }
        for (const h of json.history ?? []) {
          if (!seenHistory.current.has(h.id)) newHist.push(h.id);
        }
      }
      for (const e of json.events ?? []) seenEvents.current.add(e.id);
      for (const h of json.history ?? []) seenHistory.current.add(h.id);
      bootstrapped.current = true;

      if (newEv.length || newHist.length) {
        const flash = new Set([...newEv, ...newHist]);
        setFlashIds(flash);
        window.setTimeout(() => {
          setFlashIds((prev) => {
            const next = new Set(prev);
            for (const id of flash) next.delete(id);
            return next;
          });
        }, 2400);
      }

      setData(json);
      setLastOkAt(Date.now());
      setError(null);
      setTick((t) => t + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [projectId]);

  useEffect(() => {
    bootstrapped.current = false;
    seenEvents.current = new Set();
    seenHistory.current = new Set();
    void load();
  }, [load, projectId]);

  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(id);
  }, [live, load]);

  const openCalls = useMemo(
    () => (data?.calls ?? []).filter((c) => !c.resolvedAt),
    [data?.calls],
  );

  const liveFilter = useMemo(
    () => ({
      agentId: filterAgent || null,
      kind: filterKind || null,
      query: filterQuery || null,
    }),
    [filterAgent, filterKind, filterQuery],
  );

  const filteredEvents = useMemo(
    () => filterEvents(data?.events ?? [], liveFilter),
    [data?.events, liveFilter],
  );
  const filteredHistory = useMemo(
    () => filterHistory(data?.history ?? [], liveFilter),
    [data?.history, liveFilter],
  );

  const missionTitle = useMemo(() => {
    const map = new Map((data?.missions ?? []).map((m) => [m.id, m.title]));
    return (id: string | null | undefined) =>
      (id && map.get(id)) || id || "—";
  }, [data?.missions]);

  const agentName = useMemo(() => {
    const map = new Map((data?.agents ?? []).map((a) => [a.id, a.name]));
    return (id: string | null | undefined) =>
      (id && map.get(id)) || id || "—";
  }, [data?.agents]);

  const ageMs = lastOkAt ? Date.now() - lastOkAt : null;

  return (
    <div className={cn("flex flex-col overflow-hidden bg-bg text-fg", embedded ? "h-full min-h-0" : "h-dvh")}>
      <header className="shrink-0 border-b border-border bg-bg-elevated/90 backdrop-blur-sm">
        <div className="flex flex-wrap items-center gap-3 px-4 py-3">
          <div className="mr-auto flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-[var(--radius-sm)] bg-accent text-accent-fg">
              <LayoutDashboard className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-sm font-semibold tracking-tight sm:text-base">
                  Admin · Live board
                </h1>
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium",
                    live
                      ? "bg-status-running/15 text-status-running"
                      : "bg-bg-subtle text-fg-subtle",
                  )}
                >
                  <span
                    className={cn(
                      "h-1.5 w-1.5 rounded-full",
                      live ? "bg-status-running animate-pulse" : "bg-fg-subtle",
                    )}
                  />
                  {live ? "LIVE" : "PAUSED"}
                </span>
              </div>
              <p className="truncate text-[11px] text-fg-subtle sm:text-xs">
                Near real-time ops feed, column moves, claims, and human calls —
                no auth
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 text-xs text-fg-subtle">
            <span className="tabular hidden sm:inline">
              poll {POLL_MS}ms
              {ageMs != null ? ` · synced ${Math.round(ageMs / 100) / 10}s ago` : ""}
              {tick ? ` · #${tick}` : ""}
            </span>
            <Button
              size="sm"
              variant="default"
              className="h-9"
              onClick={() => setLive((v) => !v)}
            >
              {live ? (
                <>
                  <Pause className="h-3.5 w-3.5" /> Pause
                </>
              ) : (
                <>
                  <Play className="h-3.5 w-3.5" /> Resume
                </>
              )}
            </Button>
            <Button size="sm" variant="default" className="h-9" onClick={() => void load()}>
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
            {!embedded && (
              <Link
                to="/"
                className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-3 text-xs font-medium text-fg hover:bg-bg-hover"
              >
                <ArrowLeft className="h-3.5 w-3.5" /> Board
              </Link>
            )}
          </div>
        </div>

        {error && (
          <div className="border-t border-status-blocked/40 bg-status-blocked/10 px-4 py-2 text-xs text-status-blocked">
            Feed error: {error}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2 border-t border-border px-4 py-3 sm:grid-cols-4 lg:grid-cols-7">
          {(
            [
              ["Missions", data?.stats.missions ?? "—"],
              ["Agents", data?.stats.agents ?? "—"],
              ["Open calls", data?.stats.openCalls ?? "—"],
              ["Events", data?.stats.events ?? "—"],
              ...COLUMNS.slice(0, 3).map((c) => [
                c.label,
                data?.stats.byColumn?.[c.id] ?? 0,
              ]),
            ] as [string, string | number][]
          ).map(([label, value]) => (
            <div
              key={label}
              className="rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-3 py-2"
            >
              <div className="text-[10px] uppercase tracking-wider text-fg-subtle">
                {label}
              </div>
              <div className="mt-0.5 font-mono text-lg tabular text-fg">{value}</div>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2">
          <span className="text-[10px] uppercase tracking-wider text-fg-subtle">Filters</span>
          <select
            className="h-8 rounded-[var(--radius-sm)] bg-bg-subtle px-2 text-xs text-fg shadow-[var(--shadow-border)]"
            value={filterAgent}
            onChange={(e) => setFilterAgent(e.target.value)}
          >
            <option value="">All agents</option>
            {(data?.agents ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <select
            className="h-8 rounded-[var(--radius-sm)] bg-bg-subtle px-2 text-xs text-fg shadow-[var(--shadow-border)]"
            value={filterKind}
            onChange={(e) => setFilterKind(e.target.value)}
          >
            <option value="">All kinds</option>
            <option value="mission_claimed">claim</option>
            <option value="heartbeat">heartbeat</option>
            <option value="escalation">escalation</option>
            <option value="delivery">delivery</option>
            <option value="human_reply">human_reply</option>
            <option value="move">move</option>
            <option value="agent">actor:agent</option>
            <option value="operator">actor:operator</option>
          </select>
          <input
            className="h-8 min-w-[8rem] flex-1 rounded-[var(--radius-sm)] bg-bg-subtle px-2 text-xs text-fg shadow-[var(--shadow-border)]"
            placeholder="Search feed…"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
          />
        </div>

      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-12">
        {/* Live ops events */}
        <section className="flex min-h-0 flex-col border-b border-border lg:col-span-4 lg:border-b-0 lg:border-r">
          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
            <Activity className="h-4 w-4 text-fg-muted" />
            <div>
              <h2 className="text-sm font-medium">Ops stream</h2>
              <p className="text-[11px] text-fg-subtle">
                Claims, heartbeats, escalations, deliveries
              </p>
            </div>
          </div>
          <ul className="flex-1 space-y-0 overflow-y-auto scrollbar-thin">
            {filteredEvents.slice(0, 80).map((ev) => (
              <li
                key={ev.id}
                className={cn(
                  "border-b border-border/50 px-4 py-2.5 transition-colors",
                  flashIds.has(ev.id) && "bg-status-running/10",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <p className={cn("text-xs leading-relaxed", kindTone(ev.kind))}>
                    {ev.message}
                  </p>
                  {flashIds.has(ev.id) && (
                    <Badge variant="default" className="shrink-0 text-[10px]">
                      NEW
                    </Badge>
                  )}
                </div>
                <p className="mt-1 font-mono text-[10px] text-fg-subtle tabular">
                  <RelativeTime ts={ev.at} /> · {ev.kind.replace(/_/g, " ")}
                  {ev.missionId ? ` · ${ev.missionId}` : ""}
                  {ev.agentId ? ` · ${agentName(ev.agentId)}` : ""}
                </p>
              </li>
            ))}
            {!filteredEvents.length && (
              <li className="px-4 py-10 text-center text-xs text-fg-subtle">
                Waiting for activity…
              </li>
            )}
          </ul>
        </section>

        {/* Column move history */}
        <section className="flex min-h-0 flex-col border-b border-border lg:col-span-5 lg:border-b-0 lg:border-r">
          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
            <Radio className="h-4 w-4 text-fg-muted" />
            <div>
              <h2 className="text-sm font-medium">Status moves</h2>
              <p className="text-[11px] text-fg-subtle">
                Who moved what, from → to, when
              </p>
            </div>
          </div>
          <ul className="flex-1 space-y-0 overflow-y-auto scrollbar-thin">
            {filteredHistory.map((h) => (
              <li
                key={h.id}
                className={cn(
                  "border-b border-border/50 px-4 py-3 transition-colors",
                  flashIds.has(h.id) && "bg-accent/5",
                )}
              >
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="font-medium text-fg">
                    {missionTitle(h.missionId)}
                  </span>
                  {flashIds.has(h.id) && (
                    <Badge className="text-[10px]">NEW</Badge>
                  )}
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
                  <span
                    className="rounded px-1.5 py-0.5 text-fg-muted"
                    style={{
                      background: `color-mix(in oklab, ${
                        COLUMN_STATUS_COLOR[(h.fromColumn as MissionColumn) ?? "inbox"] ??
                        "var(--color-fg-subtle)"
                      } 18%, transparent)`,
                    }}
                  >
                    {columnLabel(h.fromColumn)}
                  </span>
                  <ArrowRight className="h-3 w-3 text-fg-subtle" />
                  <span
                    className="rounded px-1.5 py-0.5 font-medium text-fg"
                    style={{
                      background: `color-mix(in oklab, ${
                        COLUMN_STATUS_COLOR[h.toColumn] ?? "var(--color-fg-subtle)"
                      } 22%, transparent)`,
                    }}
                  >
                    {columnLabel(h.toColumn)}
                  </span>
                </div>
                <p className="mt-1.5 text-[11px] text-fg-muted">
                  <span className="text-fg">{h.actorName || h.actorId || "system"}</span>
                  {" · "}
                  {h.actorKind}
                  {" · "}
                  <RelativeTime ts={h.at} />
                  <span className="text-fg-subtle"> · {formatTime(h.at)}</span>
                </p>
                {h.note ? (
                  <p className="mt-1 text-[11px] text-fg-subtle">{h.note}</p>
                ) : null}
                <p className="mt-1 font-mono text-[10px] text-fg-subtle">{h.missionId}</p>
              </li>
            ))}
            {!filteredHistory.length && (
              <li className="px-4 py-10 text-center text-xs text-fg-subtle">
                No column history yet
              </li>
            )}
          </ul>
        </section>

        {/* Calls + agents + column strip */}
        <section className="flex min-h-0 flex-col overflow-y-auto lg:col-span-3">
          <div className="border-b border-border px-4 py-3">
            <div className="mb-2 flex items-center gap-2">
              <MessageSquareWarning className="h-4 w-4 text-status-human" />
              <h2 className="text-sm font-medium">
                Human calls
                {openCalls.length > 0 && (
                  <span className="ml-2 rounded-full bg-status-human/20 px-1.5 py-0.5 text-[10px] text-status-human tabular">
                    {openCalls.length} open
                  </span>
                )}
              </h2>
            </div>
            <ul className="space-y-2">
              {openCalls.slice(0, 12).map((c) => (
                <li
                  key={c.id}
                  className="rounded-[var(--radius-sm)] border border-status-human/30 bg-status-human/5 px-2.5 py-2 text-xs"
                >
                  <p className="font-medium text-fg">{c.question}</p>
                  <p className="mt-1 text-[11px] text-fg-subtle">
                    {missionTitle(c.missionId)} · {agentName(c.agentId)} ·{" "}
                    <RelativeTime ts={c.createdAt} />
                  </p>
                </li>
              ))}
              {openCalls.length === 0 && (
                <li className="text-[11px] text-fg-subtle">No open escalations</li>
              )}
            </ul>
          </div>

          <div className="border-b border-border px-4 py-3">
            <div className="mb-2 flex items-center gap-2">
              <Bot className="h-4 w-4 text-fg-muted" />
              <h2 className="text-sm font-medium">Agents</h2>
            </div>
            <ul className="space-y-1.5">
              {(data?.agents ?? []).map((a) => (
                <li
                  key={a.id}
                  className="flex items-center justify-between gap-2 rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-2.5 py-1.5 text-xs"
                >
                  <div className="min-w-0">
                    <div className="truncate font-mono font-medium">{a.name}</div>
                    <div className="truncate text-[10px] text-fg-subtle">
                      {HARNESS_LABELS[a.harness] ?? a.harness} · {a.role}
                    </div>
                  </div>
                  <Badge
                    variant="default"
                    className={cn(
                      "shrink-0 text-[10px]",
                      a.status === "busy" && "text-status-running",
                      a.status === "error" && "text-status-blocked",
                      a.status === "offline" && "text-fg-subtle",
                    )}
                  >
                    {a.status}
                  </Badge>
                </li>
              ))}
            </ul>
          </div>

          <div className="px-4 py-3">
            <h2 className="mb-2 text-sm font-medium">Columns</h2>
            <ul className="space-y-1.5">
              {COLUMNS.map((c) => {
                const n = data?.stats.byColumn?.[c.id] ?? 0;
                return (
                  <li key={c.id} className="flex items-center gap-2 text-xs">
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ background: COLUMN_STATUS_COLOR[c.id] }}
                    />
                    <span className="flex-1 text-fg-muted">{c.label}</span>
                    <span className="font-mono tabular text-fg">{n}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>
      </div>
    </div>
  );
}
