import { useEffect, useState } from "react";
import { Command } from "cmdk";
import {
  Bot,
  BookOpen,
  MessageSquare,
  Plus,
  Radio,
  RotateCcw,
  Search,
} from "lucide-react";
import { useBoard } from "@/lib/store";
import { cn } from "@/lib/utils";

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const {
    missions,
    openPanel,
    selectMission,
    simulateAgentTick,
    resetDemo,
    createMission,
  } = useBoard();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/60 px-4 pt-[12vh]">
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        aria-label="Close command palette"
        onClick={() => setOpen(false)}
      />
      <Command
        className={cn(
          "relative z-10 w-full max-w-lg overflow-hidden rounded-[var(--radius-xl)] bg-bg-elevated shadow-[var(--shadow-panel),var(--shadow-border)]",
        )}
        label="Command palette"
      >
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="h-4 w-4 text-fg-subtle" />
          <Command.Input
            placeholder="Jump to mission, open panels…"
            className="h-12 w-full bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle"
          />
        </div>
        <Command.List className="max-h-80 overflow-y-auto p-2 scrollbar-thin">
          <Command.Empty className="px-3 py-6 text-center text-sm text-fg-subtle">
            No matches
          </Command.Empty>

          <Command.Group
            heading="Actions"
            className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-fg-subtle"
          >
            <Item
              icon={<Plus className="h-4 w-4" />}
              onSelect={() => {
                setOpen(false);
                openPanel("new-mission");
              }}
            >
              New mission
            </Item>
            <Item
              icon={<MessageSquare className="h-4 w-4" />}
              onSelect={() => {
                setOpen(false);
                openPanel("calls");
              }}
            >
              Human call queue
            </Item>
            <Item
              icon={<Bot className="h-4 w-4" />}
              onSelect={() => {
                setOpen(false);
                openPanel("agents");
              }}
            >
              Agent roster
            </Item>
            <Item
              icon={<BookOpen className="h-4 w-4" />}
              onSelect={() => {
                setOpen(false);
                openPanel("protocol");
              }}
            >
              Agent protocol
            </Item>
            <Item
              icon={<Radio className="h-4 w-4" />}
              onSelect={() => {
                simulateAgentTick();
                setOpen(false);
              }}
            >
              Simulate agent tick
            </Item>
            <Item
              icon={<Plus className="h-4 w-4" />}
              onSelect={() => {
                createMission({
                  title: "Quick mission",
                  objective: "Operator quick-create — fill in details.",
                  priority: "p2",
                  column: "inbox",
                });
                setOpen(false);
              }}
            >
              Quick inbox mission
            </Item>
            <Item
              icon={<RotateCcw className="h-4 w-4" />}
              onSelect={() => {
                resetDemo();
                setOpen(false);
              }}
            >
              Reset demo data
            </Item>
          </Command.Group>

          <Command.Group
            heading="Missions"
            className="mt-2 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-fg-subtle"
          >
            {missions.slice(0, 12).map((m) => (
              <Item
                key={m.id}
                onSelect={() => {
                  selectMission(m.id);
                  setOpen(false);
                }}
              >
                <span className="truncate">{m.title}</span>
                <span className="ml-auto text-[11px] text-fg-subtle">
                  {m.column.replace("_", " ")}
                </span>
              </Item>
            ))}
          </Command.Group>
        </Command.List>
      </Command>
    </div>
  );
}

function Item({
  children,
  onSelect,
  icon,
}: {
  children: React.ReactNode;
  onSelect: () => void;
  icon?: React.ReactNode;
}) {
  return (
    <Command.Item
      onSelect={onSelect}
      className="flex cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] px-2 py-2 text-sm text-fg aria-selected:bg-bg-subtle"
    >
      {icon && <span className="text-fg-muted">{icon}</span>}
      {children}
    </Command.Item>
  );
}
