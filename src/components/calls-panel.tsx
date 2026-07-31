import { useState } from "react";
import { MessageSquare, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { RelativeTime } from "@/components/relative-time";
import { useBoard } from "@/lib/store";

export function CallsPanel() {
  const { calls, missions, agents, replyToCall, closePanel, openPanel } =
    useBoard();
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const open = calls.filter((c) => !c.resolvedAt);
  const closed = calls.filter((c) => c.resolvedAt);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-medium text-fg">Human call queue</h2>
          <p className="text-xs text-fg-subtle">
            Fast answers so agents can keep moving
          </p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={closePanel} aria-label="Close">
          <X className="h-4 w-4" />
        </Button>
      </header>

      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {open.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
            <MessageSquare className="h-5 w-5 text-fg-subtle" />
            <p className="text-sm text-fg-muted">No open calls</p>
            <p className="text-xs text-fg-subtle">
              Agents escalate here when they need a decision
            </p>
          </div>
        )}

        <ul className="divide-y divide-border">
          {open.map((call) => {
            const mission = missions.find((m) => m.id === call.missionId);
            const agent = agents.find((a) => a.id === call.agentId);
            return (
              <li key={call.id} className="space-y-3 p-4">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge
                    variant={
                      call.urgency === "p0"
                        ? "p0"
                        : call.urgency === "p1"
                          ? "p1"
                          : "default"
                    }
                  >
                    {call.urgency.toUpperCase()}
                  </Badge>
                  <span className="text-[11px] text-fg-subtle tabular">
                    <RelativeTime ts={call.createdAt} />
                  </span>
                  {agent && (
                    <span className="font-mono text-[11px] text-fg-muted">
                      {agent.name}
                    </span>
                  )}
                </div>
                <p className="text-sm leading-relaxed text-fg">{call.question}</p>
                {mission && (
                  <button
                    type="button"
                    className="text-xs text-status-ready hover:underline"
                    onClick={() => openPanel("mission", mission.id)}
                  >
                    {mission.title}
                  </button>
                )}
                <Textarea
                  placeholder="Your answer…"
                  value={drafts[call.id] ?? ""}
                  onChange={(e) =>
                    setDrafts((d) => ({ ...d, [call.id]: e.target.value }))
                  }
                  className="min-h-16"
                />
                <Button
                  size="sm"
                  className="w-full"
                  onClick={() => {
                    const reply = drafts[call.id]?.trim();
                    if (!reply) return;
                    replyToCall(call.id, reply);
                    setDrafts((d) => {
                      const next = { ...d };
                      delete next[call.id];
                      return next;
                    });
                    toast.success("Reply sent — mission back to Running");
                  }}
                >
                  Reply & unstick
                </Button>
              </li>
            );
          })}
        </ul>

        {closed.length > 0 && (
          <div className="border-t border-border">
            <p className="px-4 py-2 text-[11px] font-medium uppercase tracking-wider text-fg-subtle">
              Resolved
            </p>
            <ul className="divide-y divide-border">
              {closed.slice(0, 8).map((call) => (
                <li key={call.id} className="space-y-1 px-4 py-3 opacity-70">
                  <p className="text-xs text-fg">{call.question}</p>
                  <p className="text-xs text-status-running">→ {call.reply}</p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
