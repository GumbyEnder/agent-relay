import { useCallback, useEffect, useMemo, useState } from "react";
import { BookMarked, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RelativeTime } from "@/components/relative-time";
import { agentApi } from "@/lib/api-client";
import { useBoard } from "@/lib/store";
import { isAllBoardsScope } from "@/lib/board-scope";
import { COLUMN_STATUS_COLOR } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Read-only journal browser — markdown trails for missions in scope.
 */
export function JournalPanel() {
  const {
    missions,
    projects,
    selectedProjectId,
    openPanel,
  } = useBoard();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const boardName = useMemo(
    () => Object.fromEntries(projects.map((p) => [p.id, p.name])),
    [projects],
  );

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...missions]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .filter((m) => {
        if (!q) return true;
        return (
          m.title.toLowerCase().includes(q) ||
          m.id.toLowerCase().includes(q) ||
          m.objective.toLowerCase().includes(q)
        );
      });
  }, [missions, query]);

  const loadJournal = useCallback(async (missionId: string) => {
    setSelectedId(missionId);
    setLoading(true);
    setError(null);
    setMarkdown(null);
    try {
      const res = await agentApi.journal(missionId);
      setMarkdown(res.markdown ?? "(empty journal)");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedId && !missions.some((m) => m.id === selectedId)) {
      setSelectedId(null);
      setMarkdown(null);
    }
  }, [missions, selectedId]);

  const scopeLabel = isAllBoardsScope(selectedProjectId)
    ? "All boards"
    : projects.find((p) => p.id === selectedProjectId)?.name ?? "Board";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <BookMarked className="h-4 w-4 text-fg-muted" />
          <div>
            <h2 className="text-sm font-medium text-fg">Journal</h2>
            <p className="text-[11px] text-fg-subtle">
              Markdown trails · {scopeLabel} · {list.length} missions
            </p>
          </div>
        </div>
        <input
          className="ml-auto h-9 min-w-[10rem] flex-1 max-w-xs rounded-[var(--radius-sm)] bg-bg-subtle px-3 text-xs text-fg shadow-[var(--shadow-border)] sm:h-8"
          placeholder="Filter missions…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter journal missions"
        />
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-12">
        <ul className="min-h-0 overflow-y-auto border-b border-border md:col-span-4 md:border-b-0 md:border-r scrollbar-thin">
          {list.length === 0 && (
            <li className="px-4 py-12 text-center text-xs text-fg-subtle">
              No missions in scope
            </li>
          )}
          {list.map((m) => {
            const active = selectedId === m.id;
            return (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => void loadJournal(m.id)}
                  className={cn(
                    "flex w-full flex-col gap-1 border-b border-border/60 px-4 py-3 text-left transition-colors",
                    active ? "bg-accent/10" : "hover:bg-bg-subtle",
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-medium text-fg line-clamp-2">
                      {m.title}
                    </span>
                    <Badge variant="default" className="shrink-0 text-[10px]">
                      {m.priority.toUpperCase()}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-[10px] text-fg-subtle">
                    <span
                      className="rounded-full px-1.5 py-0.5"
                      style={{
                        background: `color-mix(in oklab, ${COLUMN_STATUS_COLOR[m.column]} 18%, transparent)`,
                        color: COLUMN_STATUS_COLOR[m.column],
                      }}
                    >
                      {m.column.replace(/_/g, " ")}
                    </span>
                    {isAllBoardsScope(selectedProjectId) && (
                      <span>{boardName[m.projectId] ?? m.projectId}</span>
                    )}
                    <span className="tabular">
                      <RelativeTime ts={m.updatedAt} />
                    </span>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>

        <div className="flex min-h-0 min-w-0 flex-col md:col-span-8">
          {!selectedId && (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-16 text-center">
              <BookMarked className="h-8 w-8 text-fg-subtle" />
              <p className="text-sm text-fg-muted">Select a mission to read its journal</p>
              <p className="max-w-sm text-xs text-fg-subtle">
                Journals are read-only projections of claim, move, heartbeat, and
                delivery history — same trail agents and humans share.
              </p>
            </div>
          )}
          {selectedId && (
            <>
              <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-8"
                  onClick={() => openPanel("mission", selectedId)}
                >
                  Open mission
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8"
                  disabled={loading}
                  onClick={() => void loadJournal(selectedId)}
                >
                  <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
                  Reload
                </Button>
                <span className="ml-auto font-mono text-[10px] text-fg-subtle">
                  {selectedId}
                </span>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-4 scrollbar-thin">
                {loading && (
                  <p className="text-xs text-fg-subtle">Loading journal…</p>
                )}
                {error && (
                  <p className="text-xs text-status-blocked">{error}</p>
                )}
                {markdown && !loading && (
                  <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-fg-muted">
                    {markdown}
                  </pre>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
