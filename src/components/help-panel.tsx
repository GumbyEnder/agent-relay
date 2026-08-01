import { useMemo, useState } from "react";
import { Check, Copy, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  CLIENT_AGENT_BLURB,
  DEFAULT_PUBLIC_BASE,
  clientAgentGuideMarkdown,
} from "@/lib/agent-client-guide";

export function HelpPanel({ onClose }: { onClose: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  const base =
    typeof window !== "undefined" ? window.location.origin : DEFAULT_PUBLIC_BASE;
  const md = useMemo(() => clientAgentGuideMarkdown(base), [base]);

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
          <h2 className="text-sm font-medium text-fg">Help & client agents</h2>
          <p className="text-xs text-fg-subtle">{CLIENT_AGENT_BLURB}</p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
          <X className="h-4 w-4" />
        </Button>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto p-4 scrollbar-thin text-sm">
        <section className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wider text-fg-subtle">
            Humans
          </h3>
          <ol className="list-decimal space-y-1.5 pl-4 text-xs text-fg-muted leading-relaxed">
            <li>Create or pick a board (header + Board if needed).</li>
            <li>
              <strong className="text-fg">Agents</strong> → register agent → create API key → copy{" "}
              <code className="text-fg-subtle">ark_…</code> once.
            </li>
            <li>Put work in <strong className="text-fg">Ready</strong>.</li>
            <li>Give the client agent the base URL, key, and exact agent name.</li>
            <li>
              Watch <strong className="text-fg">Live</strong> and answer{" "}
              <strong className="text-fg">Calls</strong> when it escalates.
            </li>
          </ol>
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-medium uppercase tracking-wider text-fg-subtle">
              Client agent README
            </h3>
            <Button
              size="sm"
              variant="secondary"
              className="h-7 text-[11px]"
              onClick={() => void copy("guide", md)}
            >
              {copied === "guide" ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
              Copy full guide
            </Button>
          </div>
          <p className="text-[11px] text-fg-subtle">
            Base for this site:{" "}
            <code className="text-fg-muted">{base}</code>
          </p>
          <pre className="max-h-[50vh] overflow-auto rounded-[var(--radius-md)] border border-border bg-bg-subtle p-3 text-[11px] leading-relaxed text-fg-muted whitespace-pre-wrap font-mono">
            {md}
          </pre>
        </section>
      </div>
    </div>
  );
}
