import { useState } from "react";
import { Check, Copy, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useBoard } from "@/lib/store";
import { cn } from "@/lib/utils";

const VERBS = [
  {
    id: "poll",
    title: "Poll Ready",
    desc: "Any harness pulls claimable work. Prefer Ready over Inbox.",
    sample: `{
  "action": "poll",
  "column": "ready",
  "limit": 5,
  "agent": "forge"
}`,
  },
  {
    id: "claim",
    title: "Claim",
    desc: "Atomic claim so two agents never double-work a mission.",
    sample: `{
  "action": "claim",
  "mission_id": "msn_…",
  "agent": "forge"
}`,
  },
  {
    id: "heartbeat",
    title: "Heartbeat",
    desc: "Progress ping. Stale heartbeats surface as risk on the board.",
    sample: `{
  "action": "heartbeat",
  "mission_id": "msn_…",
  "agent": "forge",
  "note": "writing tests"
}`,
  },
  {
    id: "escalate",
    title: "Escalate",
    desc: "Single clear question → Needs Human call queue for the operator.",
    sample: `{
  "action": "escalate",
  "mission_id": "msn_…",
  "agent": "relay",
  "question": "Extend idle timeout to 6h?"
}`,
  },
  {
    id: "deliver",
    title: "Deliver",
    desc: "Hand off to Review with a short summary and artifacts.",
    sample: `{
  "action": "deliver",
  "mission_id": "msn_…",
  "agent": "forge",
  "summary": "cookie flags fixed; tests green",
  "artifacts": ["src/auth/cookies.ts"]
}`,
  },
] as const;

export function ProtocolPanel() {
  const { closePanel, exportActive } = useBoard();
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (id: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(id);
    toast.success("Copied");
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-medium text-fg">Agent protocol</h2>
          <p className="text-xs text-fg-subtle">
            Five verbs. Works with Claude Code, Codex, Cursor, MCP, or a shell
            script — the board does not care which harness runs the agent.
          </p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={closePanel} aria-label="Close">
          <X className="h-4 w-4" />
        </Button>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto p-4 scrollbar-thin">
        <div className="rounded-[var(--radius-md)] bg-bg-subtle p-3 text-xs leading-relaxed text-fg-muted">
          This surface is intentionally not Monday.com. No sprints, no human
          team calendar, no vanity fields. Missions, agents, claims, heartbeats,
          human calls, delivery. That is the product.
        </div>

        <div className="rounded-[var(--radius-md)] border border-border p-3 space-y-2">
          <h3 className="text-sm font-medium text-fg">HTTP API (v0.2)</h3>
          <p className="text-xs text-fg-muted">
            Live on this server. Optional auth: set{" "}
            <code className="font-mono text-[11px]">AGENT_RELAY_API_KEY</code> and
            send{" "}
            <code className="font-mono text-[11px]">Authorization: Bearer …</code>.
          </p>
          <pre className="overflow-x-auto rounded-[var(--radius-sm)] bg-bg p-3 font-mono text-[11px] leading-relaxed text-fg-muted shadow-[var(--shadow-border)]">
{`GET  /api/agent/health
GET  /api/agent/missions?column=ready&limit=5&agent=forge
POST /api/agent/missions/:id/claim
POST /api/agent/missions/:id/heartbeat
POST /api/agent/missions/:id/escalate
POST /api/agent/missions/:id/deliver
POST /api/agent/v1   # { action: poll|claim|… }`}
          </pre>
        </div>

        {VERBS.map((v, i) => (
          <article
            key={v.id}
            className="rounded-[var(--radius-md)] border border-border p-3"
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-bg-subtle font-mono text-[11px] text-fg-muted">
                  {i + 1}
                </span>
                <h3 className="text-sm font-medium text-fg">{v.title}</h3>
              </div>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => copy(v.id, v.sample)}
                aria-label={`Copy ${v.title}`}
              >
                {copied === v.id ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>
            <p className="mb-2 text-xs text-fg-muted">{v.desc}</p>
            <pre
              className={cn(
                "overflow-x-auto rounded-[var(--radius-sm)] bg-bg p-3 font-mono text-[11px] leading-relaxed text-fg-muted shadow-[var(--shadow-border)]",
              )}
            >
              {v.sample}
            </pre>
          </article>
        ))}

        <div className="space-y-2">
          <p className="text-xs text-fg-muted">
            Offline / air-gapped harnesses can pull the active board as JSON.
          </p>
          <Button
            variant="secondary"
            size="sm"
            className="w-full"
            onClick={async () => {
              const json = exportActive();
              await navigator.clipboard.writeText(json);
              toast.success("Active board JSON copied");
            }}
          >
            <Copy className="h-3.5 w-3.5" />
            Copy active board JSON
          </Button>
        </div>
      </div>
    </div>
  );
}
