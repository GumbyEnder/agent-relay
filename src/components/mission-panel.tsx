import { useState } from "react";
import {
  CheckCircle2,
  Copy,
  Hand,
  MessageSquareWarning,
  Radio,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { RelativeTime } from "@/components/relative-time";
import { useBoard } from "@/lib/store";
import type { Mission, MissionColumn, Priority } from "@/lib/types";
import {
  COLUMNS,
  HARNESS_LABELS,
  PRIORITY_LABELS,
} from "@/lib/types";
import { formatTime } from "@/lib/utils";

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-1.5">
      <h4 className="text-[11px] font-medium uppercase tracking-wider text-fg-subtle">
        {title}
      </h4>
      <div className="text-sm leading-relaxed text-fg-muted">{children}</div>
    </section>
  );
}

function buildAgentPrompt(mission: Mission) {
  return [
    `# Mission ${mission.id}`,
    `Title: ${mission.title}`,
    `Priority: ${mission.priority}`,
    `Column: ${mission.column}`,
    "",
    "## Objective",
    mission.objective,
    "",
    "## Context",
    mission.context || "(none)",
    "",
    "## Constraints",
    mission.constraints || "(none)",
    "",
    "## Acceptance",
    mission.acceptance || "(none)",
    "",
    "## Protocol",
    "1. Claim this mission before starting.",
    "2. Heartbeat every few minutes with a progress note.",
    "3. Escalate with a single clear question if blocked on a human.",
    "4. Deliver with a short summary when ready for review.",
    "",
    "Harness-agnostic — use whatever agent runner you have.",
  ].join("\n");
}

export function MissionPanel({ missionId }: { missionId: string }) {
  const {
    missions,
    agents,
    projects,
    historyByMission,
    loadHistory,
    closePanel,
    moveMission,
    claimMission,
    releaseMission,
    heartbeat,
    escalate,
    deliver,
    deleteMission,
    updateMission,
    transferMission,
  } = useBoard();
  const mission = missions.find((m) => m.id === missionId);
  const history = historyByMission[missionId] ?? [];
  if (missionId && !historyByMission[missionId]) {
    void loadHistory(missionId);
  }
  const [heartbeatNote, setHeartbeatNote] = useState("");
  const [escalateQ, setEscalateQ] = useState("");
  const [delivery, setDelivery] = useState("");
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftObjective, setDraftObjective] = useState("");
  const [draftContext, setDraftContext] = useState("");
  const [draftConstraints, setDraftConstraints] = useState("");
  const [draftAcceptance, setDraftAcceptance] = useState("");
  const [transferBoard, setTransferBoard] = useState("");
  const [claimAgent, setClaimAgent] = useState(
    agents.find((a) => a.status !== "offline")?.id ?? "",
  );

  if (!mission) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-fg-muted">
        Mission not found
      </div>
    );
  }

  const agent =
    agents.find((a) => a.id === mission.claimedBy) ||
    agents.find((a) => a.id === mission.assigneeId);

  const startEdit = () => {
    setDraftTitle(mission.title);
    setDraftObjective(mission.objective);
    setDraftContext(mission.context);
    setDraftConstraints(mission.constraints);
    setDraftAcceptance(mission.acceptance);
    setEditing(true);
  };

  const saveEdit = () => {
    if (!draftTitle.trim() || !draftObjective.trim()) {
      toast.error("Title and objective are required");
      return;
    }
    updateMission(mission.id, {
      title: draftTitle.trim(),
      objective: draftObjective.trim(),
      context: draftContext,
      constraints: draftConstraints,
      acceptance: draftAcceptance,
    });
    setEditing(false);
    toast.success("Mission saved");
  };

  const copyPrompt = async () => {
    await navigator.clipboard.writeText(buildAgentPrompt(mission));
    toast.success("Mission prompt copied — paste into any harness");
  };

  const copyJournal = async () => {
    try {
      const res = await fetch(`/api/agent/missions/${mission.id}/journal`);
      const data = (await res.json()) as { ok?: boolean; markdown?: string; error?: string };
      if (!res.ok || !data.markdown) throw new Error(data.error ?? "journal failed");
      await navigator.clipboard.writeText(data.markdown);
      toast.success("Journal markdown copied");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Journal failed");
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap gap-1.5">
            <Badge
              variant={
                mission.priority === "p0"
                  ? "p0"
                  : mission.priority === "p1"
                    ? "p1"
                    : mission.priority === "p2"
                      ? "p2"
                      : "p3"
              }
            >
              {PRIORITY_LABELS[mission.priority]}
            </Badge>
            <Badge variant="default">{mission.column.replace("_", " ")}</Badge>
          </div>
          {!editing ? (
            <h2 className="text-base font-semibold leading-snug tracking-tight text-fg">
              {mission.title}
            </h2>
          ) : (
            <Input
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              className="h-9 text-base font-semibold"
              aria-label="Title"
            />
          )}
          <p className="font-mono text-[11px] text-fg-subtle">{mission.id}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!editing ? (
            <Button size="sm" variant="ghost" className="h-8 text-[11px]" onClick={startEdit}>
              Edit
            </Button>
          ) : (
            <>
              <Button size="sm" variant="secondary" className="h-8 text-[11px]" onClick={saveEdit}>
                Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 text-[11px]"
                onClick={() => setEditing(false)}
              >
                Cancel
              </Button>
            </>
          )}
          <Button variant="ghost" size="icon-sm" onClick={closePanel} aria-label="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <div className="flex-1 space-y-5 overflow-y-auto p-4 scrollbar-thin">
        {!editing ? (
          <>
            <Section title="Objective">{mission.objective}</Section>
            {mission.context && <Section title="Context">{mission.context}</Section>}
            {mission.constraints && (
              <Section title="Constraints">{mission.constraints}</Section>
            )}
            {mission.acceptance && (
              <Section title="Acceptance">{mission.acceptance}</Section>
            )}
          </>
        ) : (
          <div className="space-y-3">
            <div>
              <label className="text-[11px] font-medium uppercase tracking-wider text-fg-subtle">
                Objective
              </label>
              <Textarea
                value={draftObjective}
                onChange={(e) => setDraftObjective(e.target.value)}
                className="mt-1 min-h-20"
              />
            </div>
            <div>
              <label className="text-[11px] font-medium uppercase tracking-wider text-fg-subtle">
                Context
              </label>
              <Textarea
                value={draftContext}
                onChange={(e) => setDraftContext(e.target.value)}
                className="mt-1 min-h-16"
              />
            </div>
            <div>
              <label className="text-[11px] font-medium uppercase tracking-wider text-fg-subtle">
                Constraints
              </label>
              <Textarea
                value={draftConstraints}
                onChange={(e) => setDraftConstraints(e.target.value)}
                className="mt-1 min-h-14"
              />
            </div>
            <div>
              <label className="text-[11px] font-medium uppercase tracking-wider text-fg-subtle">
                Acceptance
              </label>
              <Textarea
                value={draftAcceptance}
                onChange={(e) => setDraftAcceptance(e.target.value)}
                className="mt-1 min-h-14"
              />
            </div>
          </div>
        )}
        {mission.progressNote && (
          <Section title="Latest progress">{mission.progressNote}</Section>
        )}
        {mission.delivery && (
          <Section title="Delivery">{mission.delivery}</Section>
        )}
        {mission.usage && (
          <Section title="Usage (self-reported)">
            {[
              mission.usage.tokensIn != null && `in ${mission.usage.tokensIn}`,
              mission.usage.tokensOut != null && `out ${mission.usage.tokensOut}`,
              mission.usage.model && `model ${mission.usage.model}`,
              mission.usage.estimatedUsd != null &&
                `~$${mission.usage.estimatedUsd.toFixed(4)}`,
              typeof mission.usage.toolCalls === "number" &&
                `tools ${mission.usage.toolCalls}`,
            ]
              .filter(Boolean)
              .join(" · ") || "recorded"}
          </Section>
        )}

        <div className="grid grid-cols-2 gap-3 rounded-[var(--radius-md)] bg-bg-subtle p-3 text-xs">
          <div>
            <p className="text-fg-subtle">Claimed by</p>
            <p className="mt-0.5 font-mono text-fg">
              {agent ? agent.name : "—"}
            </p>
            {agent && (
              <p className="text-fg-subtle">{HARNESS_LABELS[agent.harness]}</p>
            )}
          </div>
          <div>
            <p className="text-fg-subtle">Last heartbeat</p>
            <p className="mt-0.5 text-fg tabular">
              <RelativeTime ts={mission.lastHeartbeat} />
            </p>
            <p className="text-fg-subtle" suppressHydrationWarning>
              Updated {formatTime(mission.updatedAt)}
            </p>
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-[11px] font-medium uppercase tracking-wider text-fg-subtle">
            Reassign board
          </label>
          <p className="text-[11px] text-fg-subtle">
            Current:{" "}
            <span className="font-medium text-fg">
              {projects.find((p) => p.id === mission.projectId)?.name ??
                mission.projectId}
            </span>
          </p>
          <div className="flex gap-2">
            <select
              className="h-10 min-w-0 flex-1 rounded-[var(--radius-sm)] bg-bg-subtle px-3 text-sm text-fg shadow-[var(--shadow-border)]"
              value={transferBoard || mission.projectId}
              onChange={(e) => setTransferBoard(e.target.value)}
              aria-label="Target board for reassignment"
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.id === mission.projectId ? " (current)" : ""}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="secondary"
              className="h-10 shrink-0"
              disabled={
                !transferBoard || transferBoard === mission.projectId
              }
              onClick={() => {
                if (!transferBoard || transferBoard === mission.projectId) return;
                const dest =
                  projects.find((p) => p.id === transferBoard)?.name ??
                  transferBoard;
                if (
                  !window.confirm(
                    `Reassign this mission to “${dest}”? History stays with the card.`,
                  )
                ) {
                  return;
                }
                transferMission(mission.id, transferBoard);
                setTransferBoard("");
              }}
            >
              Reassign
            </Button>
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-[11px] font-medium uppercase tracking-wider text-fg-subtle">
            Column
          </label>
          <select
            className="h-10 w-full rounded-[var(--radius-sm)] bg-bg-subtle px-3 text-sm text-fg shadow-[var(--shadow-border)] outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={mission.column}
            onChange={(e) =>
              moveMission(mission.id, e.target.value as MissionColumn)
            }
          >
            {COLUMNS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-2">
          <label className="text-[11px] font-medium uppercase tracking-wider text-fg-subtle">
            Priority
          </label>
          <select
            className="h-10 w-full rounded-[var(--radius-sm)] bg-bg-subtle px-3 text-sm text-fg shadow-[var(--shadow-border)] outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={mission.priority}
            onChange={(e) =>
              updateMission(mission.id, {
                priority: e.target.value as Priority,
              })
            }
          >
            {(Object.keys(PRIORITY_LABELS) as Priority[]).map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABELS[p]}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-2 rounded-[var(--radius-md)] border border-border p-3">
          <p className="text-xs font-medium text-fg">Agent actions</p>
          <div className="flex gap-2">
            <select
              className="h-9 flex-1 rounded-[var(--radius-sm)] bg-bg-subtle px-2 text-xs text-fg shadow-[var(--shadow-border)]"
              value={claimAgent}
              onChange={(e) => setClaimAgent(e.target.value)}
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {HARNESS_LABELS[a.harness]}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                if (!claimAgent) return;
                claimMission(mission.id, claimAgent);
                toast.success("Mission claimed");
              }}
            >
              <Hand className="h-3.5 w-3.5" />
              Claim
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={!mission.claimedBy}
              onClick={() => {
                releaseMission(mission.id);
                toast.message("Mission released to Ready");
              }}
            >
              Release
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void copyPrompt()}>
              <Copy className="h-3.5 w-3.5" />
              Copy for harness
            </Button>
          </div>

          <div className="flex gap-2 pt-1">
            <Input
              placeholder="Heartbeat note…"
              value={heartbeatNote}
              onChange={(e) => setHeartbeatNote(e.target.value)}
              className="h-9"
            />
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                heartbeat(mission.id, heartbeatNote);
                setHeartbeatNote("");
                toast.success("Heartbeat recorded");
              }}
            >
              <Radio className="h-3.5 w-3.5" />
              Ping
            </Button>
          </div>

          <div className="flex gap-2">
            <Input
              placeholder="Escalate to human…"
              value={escalateQ}
              onChange={(e) => setEscalateQ(e.target.value)}
              className="h-9"
            />
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                escalate(mission.id, escalateQ);
                setEscalateQ("");
                toast.message("Sent to Needs Human");
              }}
            >
              <MessageSquareWarning className="h-3.5 w-3.5" />
              Call
            </Button>
          </div>

          <div className="space-y-2">
            <Textarea
              placeholder="Delivery summary…"
              value={delivery}
              onChange={(e) => setDelivery(e.target.value)}
              className="min-h-16"
            />
            <Button
              size="sm"
              className="w-full"
              onClick={() => {
                deliver(mission.id, delivery || mission.progressNote);
                setDelivery("");
                toast.success("Moved to Review");
              }}
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              Deliver for review
            </Button>
          </div>
        </div>
      </div>


      <div className="border-t border-border px-4 py-3">
        <h4 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-fg-subtle">
          Status history
        </h4>
        {history.length === 0 ? (
          <p className="text-xs text-fg-subtle">No history yet.</p>
        ) : (
          <ul className="max-h-48 space-y-2 overflow-y-auto scrollbar-thin">
            {history.map((h) => (
              <li
                key={h.id}
                className="rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-2.5 py-2 text-xs"
              >
                <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-fg">
                  <span className="text-fg-subtle">{h.fromColumn ?? "—"}</span>
                  <span aria-hidden>→</span>
                  <span className="font-medium">{h.toColumn}</span>
                </div>
                <div className="mt-1 text-fg-muted">
                  {(h.actorName || h.actorId || "system") + ` · ${h.actorKind} · `}
                  <RelativeTime ts={h.at} />
                </div>
                {h.note ? <div className="mt-1 text-fg-subtle">{h.note}</div> : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="border-t border-border px-4 py-2">
        <Button size="sm" variant="secondary" className="w-full" onClick={() => void copyJournal()}>
          Copy journal markdown
        </Button>
      </div>
      <footer className="border-t border-border p-3">
        <Button
          variant="danger"
          size="sm"
          className="w-full"
          onClick={() => {
            deleteMission(mission.id);
            toast.message("Mission removed");
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete mission
        </Button>
      </footer>
    </div>
  );
}
