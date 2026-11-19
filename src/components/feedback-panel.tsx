import { useCallback, useEffect, useMemo, useState } from "react";
import { Inbox, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { agentApi } from "@/lib/api-client";
import { cn } from "@/lib/utils";

type FeedbackRow = Awaited<ReturnType<typeof agentApi.listFeedback>>["feedback"][number];

const STATUSES = ["new", "triaged", "fixed", "wontfix", "duplicate"] as const;

const STATUS_STYLE: Record<string, string> = {
  new: "bg-status-human text-accent-fg",
  triaged: "bg-bg-subtle text-fg",
  fixed: "bg-status-running/20 text-status-running",
  wontfix: "bg-bg-subtle text-fg-muted",
  duplicate: "bg-bg-subtle text-fg-subtle",
};

function fmt(at: string | null): string {
  if (!at) return "—";
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? String(at) : d.toLocaleString();
}

/**
 * Admin triage for CR-6 feedback. The only screen that reads a feedback row —
 * the consumer host has no GET at all. Newest first, status filter, and a
 * detail pane that shows exactly what was stored (including the diagnostic
 * object as stored, not a hand-written blurb).
 */
export function FeedbackPanel() {
  const [rows, setRows] = useState<FeedbackRow[]>([]);
  const [status, setStatus] = useState<string>("");
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await agentApi.listFeedback({ status: status || undefined, limit: 100 });
      setRows(res.feedback);
      setSelected((cur) => (cur && res.feedback.some((r) => r.ref === cur) ? cur : res.feedback[0]?.ref ?? null));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load feedback");
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  const row = useMemo(() => rows.find((r) => r.ref === selected) ?? null, [rows, selected]);

  useEffect(() => {
    setNote(row?.admin_note ?? "");
  }, [row?.ref, row?.admin_note]);

  const save = async (patch: { status?: string; admin_note?: string }) => {
    if (!row) return;
    setSaving(true);
    try {
      await agentApi.updateFeedback(row.ref, patch);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col border-r border-border">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <Inbox className="h-4 w-4 text-fg-muted" />
          <span className="text-xs font-semibold text-fg">Feedback</span>
          <select
            className="h-7 rounded-[var(--radius-sm)] bg-bg-subtle px-2 text-[11px] text-fg"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">all statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <Button size="sm" variant="ghost" className="ml-auto h-7 text-[11px]" onClick={() => void load()}>
            <RefreshCw className={cn("mr-1 h-3 w-3", loading && "animate-spin")} /> Refresh
          </Button>
        </div>
        {error ? <p className="px-3 py-2 text-[11px] text-status-human">{error}</p> : null}
        <div className="min-h-0 flex-1 overflow-auto">
          {rows.length === 0 && !loading ? (
            <p className="px-3 py-6 text-center text-[12px] text-fg-muted">No feedback yet.</p>
          ) : null}
          {rows.map((r) => (
            <button
              key={r.ref}
              type="button"
              onClick={() => setSelected(r.ref)}
              className={cn(
                "block w-full border-b border-border px-3 py-2 text-left transition-colors hover:bg-bg-subtle",
                selected === r.ref && "bg-bg-subtle",
              )}
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-[11px] text-fg">{r.ref}</span>
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase",
                    STATUS_STYLE[r.status] ?? "bg-bg-subtle text-fg-muted",
                  )}
                >
                  {r.status}
                </span>
                <span className="ml-auto text-[10px] text-fg-subtle">{fmt(r.created_at)}</span>
              </div>
              <p className="mt-1 line-clamp-2 text-[12px] text-fg-muted">{r.body}</p>
              <p className="mt-0.5 text-[10px] text-fg-subtle">
                {r.route || "—"} · {r.user_id ? "signed in" : "anonymous"}
              </p>
            </button>
          ))}
        </div>
      </div>
      <div className="hidden w-[46%] min-w-[320px] flex-col overflow-auto px-4 py-3 sm:flex">
        {!row ? (
          <p className="text-[12px] text-fg-muted">Select a report.</p>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm text-fg">{row.ref}</span>
              <span className="text-[11px] text-fg-subtle">{fmt(row.created_at)}</span>
            </div>
            <p className="whitespace-pre-wrap break-words text-[13px] text-fg">{row.body}</p>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
              <dt className="text-fg-subtle">route</dt>
              <dd className="text-fg-muted">{row.route ?? "—"}</dd>
              <dt className="text-fg-subtle">page</dt>
              <dd className="break-all text-fg-muted">{row.page_url ?? "—"}</dd>
              <dt className="text-fg-subtle">build (stamped by the server)</dt>
              <dd className="font-mono text-fg-muted">{row.app_sha ? row.app_sha.slice(0, 12) : "—"}</dd>
              <dt className="text-fg-subtle">account</dt>
              <dd className="break-all text-fg-muted">{row.user_id ?? "anonymous"}</dd>
              <dt className="text-fg-subtle">ip hash</dt>
              <dd className="font-mono text-fg-muted">{row.ip_hash ?? "nulled"}</dd>
              <dt className="text-fg-subtle">user agent</dt>
              <dd className="break-all text-fg-muted">{row.ua ?? "—"}</dd>
            </dl>
            <div>
              <p className="mb-1 text-[11px] font-semibold text-fg-muted">
                Diagnostic {row.diag ? `(stored, ${row.diag_redactions} redaction${row.diag_redactions === 1 ? "" : "s"})` : "(not included)"}
              </p>
              {row.diag ? (
                <pre className="max-h-72 overflow-auto rounded-[var(--radius-sm)] bg-bg-subtle p-2 text-[10px] leading-snug text-fg-muted">
                  {JSON.stringify(row.diag, null, 2)}
                </pre>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-1">
              {STATUSES.map((s) => (
                <Button
                  key={s}
                  size="sm"
                  variant={row.status === s ? "default" : "ghost"}
                  className="h-7 text-[11px]"
                  disabled={saving}
                  onClick={() => void save({ status: s })}
                >
                  {s}
                </Button>
              ))}
            </div>
            <div>
              <textarea
                className="h-20 w-full rounded-[var(--radius-sm)] bg-bg-subtle p-2 text-[12px] text-fg"
                placeholder="Admin note (internal)"
                value={note}
                maxLength={4000}
                onChange={(e) => setNote(e.target.value)}
              />
              <Button
                size="sm"
                className="mt-1 h-7 text-[11px]"
                disabled={saving || note === (row.admin_note ?? "")}
                onClick={() => void save({ admin_note: note })}
              >
                Save note
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
