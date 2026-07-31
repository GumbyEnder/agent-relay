import { useState } from "react";
import { Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RelativeTime } from "@/components/relative-time";
import { useBoard } from "@/lib/store";
import type { AgentStatus, HarnessKind } from "@/lib/types";
import { HARNESS_LABELS } from "@/lib/types";

const harnesses = Object.keys(HARNESS_LABELS) as HarnessKind[];
const statuses: AgentStatus[] = ["online", "busy", "idle", "offline", "error"];

export function AgentsPanel() {
  const {
    agents,
    missions,
    closePanel,
    registerAgent,
    setAgentStatus,
    removeAgent,
    openPanel,
  } = useBoard();
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [harness, setHarness] = useState<HarnessKind>("claude_code");
  const [skills, setSkills] = useState("");
  const [showForm, setShowForm] = useState(false);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-medium text-fg">Agent roster</h2>
          <p className="text-xs text-fg-subtle">
            Any harness. Identity only — no bundled runner.
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => setShowForm((v) => !v)}
            aria-label="Register agent"
          >
            <Plus className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={closePanel} aria-label="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {showForm && (
          <form
            className="space-y-2 border-b border-border p-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim() || !role.trim()) return;
              registerAgent({
                name,
                role,
                harness,
                skills: skills
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              });
              setName("");
              setRole("");
              setSkills("");
              setShowForm(false);
              toast.success("Agent registered");
            }}
          >
            <Input
              placeholder="name (e.g. forge)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
            <Input
              placeholder="role"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              required
            />
            <select
              className="h-10 w-full rounded-[var(--radius-sm)] bg-bg-subtle px-3 text-sm text-fg shadow-[var(--shadow-border)]"
              value={harness}
              onChange={(e) => setHarness(e.target.value as HarnessKind)}
            >
              {harnesses.map((h) => (
                <option key={h} value={h}>
                  {HARNESS_LABELS[h]}
                </option>
              ))}
            </select>
            <Input
              placeholder="skills (comma-separated)"
              value={skills}
              onChange={(e) => setSkills(e.target.value)}
            />
            <Button type="submit" size="sm" className="w-full">
              Register agent
            </Button>
          </form>
        )}

        <ul className="divide-y divide-border">
          {agents.map((a) => {
            const active = missions.find((m) => m.id === a.currentMissionId);
            return (
              <li key={a.id} className="space-y-2 px-4 py-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-mono text-sm text-fg">{a.name}</p>
                    <p className="text-xs text-fg-muted">{a.role}</p>
                  </div>
                  <Badge variant="default">{HARNESS_LABELS[a.harness]}</Badge>
                </div>
                <div className="flex flex-wrap gap-1">
                  {a.skills.map((s) => (
                    <Badge key={s} variant="default">
                      {s}
                    </Badge>
                  ))}
                </div>
                <div className="flex items-center justify-between gap-2 text-[11px] text-fg-subtle">
                  <span className="tabular">
                    HB <RelativeTime ts={a.lastHeartbeat} />
                  </span>
                  {active ? (
                    <button
                      type="button"
                      className="truncate text-left text-status-running hover:underline"
                      onClick={() => openPanel("mission", active.id)}
                    >
                      {active.title}
                    </button>
                  ) : (
                    <span>no mission</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <select
                    className="h-8 flex-1 rounded-[var(--radius-xs)] bg-bg-subtle px-2 text-xs text-fg shadow-[var(--shadow-border)]"
                    value={a.status}
                    onChange={(e) =>
                      setAgentStatus(a.id, e.target.value as AgentStatus)
                    }
                  >
                    {statuses.map((st) => (
                      <option key={st} value={st}>
                        {st}
                      </option>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      removeAgent(a.id);
                      toast.message("Agent removed");
                    }}
                  >
                    Remove
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
