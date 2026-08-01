import { useCallback, useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RelativeTime } from "@/components/relative-time";
import { useBoard } from "@/lib/store";
import { agentApi } from "@/lib/api-client";
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
    selectedProjectId,
  } = useBoard();
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [harness, setHarness] = useState<HarnessKind>("hermes");
  const [skills, setSkills] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [keys, setKeys] = useState<Array<Record<string, unknown>>>([]);
  const [lastSecret, setLastSecret] = useState<string | null>(null);
  const [keyName, setKeyName] = useState("");
  const [keyAgent, setKeyAgent] = useState("");
  const [settings, setSettings] = useState<{
    githubRepo?: string | null;
    replyWebhookUrl?: string | null;
    hasGithubSecret?: boolean;
  }>({});
  const [ghSecret, setGhSecret] = useState("");
  const [ghRepo, setGhRepo] = useState("");
  const [replyUrl, setReplyUrl] = useState("");

  const projectId = selectedProjectId ?? "proj_default";

  const reloadKeys = useCallback(async () => {
    try {
      const res = await agentApi.listKeys(projectId);
      setKeys(res.keys ?? []);
    } catch {
      setKeys([]);
    }
  }, [projectId]);

  const reloadSettings = useCallback(async () => {
    try {
      const res = await agentApi.getSettings(projectId);
      setSettings(res.settings ?? {});
      setGhRepo(String(res.settings?.githubRepo ?? ""));
      setReplyUrl(String(res.settings?.replyWebhookUrl ?? ""));
    } catch {
      /* ignore */
    }
  }, [projectId]);

  useEffect(() => {
    void reloadKeys();
    void reloadSettings();
  }, [reloadKeys, reloadSettings]);

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

      <div className="border-t border-border p-4 space-y-3">
        <h3 className="text-xs font-medium uppercase tracking-wider text-fg-subtle">API keys</h3>
        <p className="text-[11px] text-fg-muted">
          Scoped keys for agents/harnesses (machine auth only — never browser OAuth). Secret shown once at create. Admin role required.
        </p>
        <div className="flex flex-wrap gap-2">
          <Input
            placeholder="key name"
            value={keyName}
            onChange={(e) => setKeyName(e.target.value)}
            className="h-8 flex-1 min-w-[6rem]"
          />
          <select
            className="h-8 rounded-[var(--radius-sm)] bg-bg-subtle px-2 text-xs shadow-[var(--shadow-border)]"
            value={keyAgent}
            onChange={(e) => setKeyAgent(e.target.value)}
          >
            <option value="">project-wide</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            onClick={async () => {
              try {
                const res = await agentApi.createApiKey({
                  projectId,
                  name: keyName || "agent-key",
                  agentId: keyAgent || null,
                });
                setLastSecret(String(res.key.secret ?? ""));
                setKeyName("");
                await reloadKeys();
                toast.success("API key created — copy secret now");
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "create failed");
              }
            }}
          >
            Create key
          </Button>
        </div>
        {lastSecret && (
          <div className="rounded-[var(--radius-sm)] border border-status-human/40 bg-status-human/10 p-2 text-[11px] font-mono break-all">
            {lastSecret}
            <Button
              size="sm"
              variant="secondary"
              className="mt-2 w-full"
              onClick={async () => {
                await navigator.clipboard.writeText(lastSecret);
                toast.success("Secret copied");
              }}
            >
              Copy secret
            </Button>
          </div>
        )}
        <ul className="space-y-1.5">
          {keys.map((k) => (
            <li
              key={String(k.id)}
              className="flex items-center justify-between gap-2 rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-2 py-1.5 text-[11px]"
            >
              <div className="min-w-0">
                <div className="font-medium truncate">{String(k.name)}</div>
                <div className="font-mono text-fg-subtle">{String(k.keyPrefix)}…</div>
              </div>
              {k.revokedAt ? (
                <Badge variant="done">revoked</Badge>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    await agentApi.revokeApiKey(String(k.id));
                    await reloadKeys();
                    toast.message("Key revoked");
                  }}
                >
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>

        <h3 className="pt-2 text-xs font-medium uppercase tracking-wider text-fg-subtle">
          GitHub connect
        </h3>
        <p className="text-[11px] text-fg-muted leading-relaxed">
          Map a repo to this project, set the webhook secret, then point GitHub
          (App or repo webhook) at the URL below. Issues create one mission with
          stable <code className="text-fg-subtle">external_id</code>{" "}
          <code className="text-fg-subtle">github:owner/repo#n</code>.
        </p>
        <Input
          placeholder="GitHub repo org/name"
          value={ghRepo}
          onChange={(e) => setGhRepo(e.target.value)}
          className="h-8"
        />
        <Input
          placeholder="GitHub webhook secret"
          value={ghSecret}
          onChange={(e) => setGhSecret(e.target.value)}
          className="h-8"
          type="password"
        />
        <Input
          placeholder="Reply webhook URL (on Call resolve)"
          value={replyUrl}
          onChange={(e) => setReplyUrl(e.target.value)}
          className="h-8"
        />
        <p className="text-[10px] text-fg-subtle break-all">
          Payload URL: POST /api/agent/webhooks/github?project={projectId}
          <br />
          Events: issues, issue_comment, pull_request, check_run (JSON)
          <br />
          {settings.hasGithubSecret ? "Secret configured ✓" : "No secret yet — webhooks accepted unsigned (dev only)"}
        </p>
        <Button
          size="sm"
          variant="secondary"
          className="w-full"
          onClick={async () => {
            try {
              await agentApi.updateSettings(projectId, {
                githubRepo: ghRepo || null,
                githubWebhookSecret: ghSecret || undefined,
                replyWebhookUrl: replyUrl || null,
              });
              setGhSecret("");
              await reloadSettings();
              toast.success("Settings saved");
            } catch (e) {
              toast.error(e instanceof Error ? e.message : "save failed");
            }
          }}
        >
          Save integration settings
        </Button>
      </div>
    </div>
  );
}
