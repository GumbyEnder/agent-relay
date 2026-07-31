import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { useBoard } from "@/lib/store";
import type { Priority } from "@/lib/types";
import { PRIORITY_LABELS } from "@/lib/types";

export function NewMissionDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createMission = useBoard((s) => s.createMission);
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [context, setContext] = useState("");
  const [constraints, setConstraints] = useState("");
  const [acceptance, setAcceptance] = useState("");
  const [priority, setPriority] = useState<Priority>("p2");
  const [tags, setTags] = useState("");

  const reset = () => {
    setTitle("");
    setObjective("");
    setContext("");
    setConstraints("");
    setAcceptance("");
    setPriority("p2");
    setTags("");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New mission</DialogTitle>
          <DialogDescription>
            Structured for agents — objective, constraints, acceptance. Not a
            vague sticky note.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!title.trim() || !objective.trim()) return;
            createMission({
              title,
              objective,
              context,
              constraints,
              acceptance,
              priority,
              tags: tags
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean),
              column: "inbox",
            });
            reset();
            onOpenChange(false);
            toast.success("Mission in Inbox");
          }}
        >
          <Input
            placeholder="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
          />
          <Textarea
            placeholder="Objective"
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            required
            className="min-h-20"
          />
          <Textarea
            placeholder="Context (optional)"
            value={context}
            onChange={(e) => setContext(e.target.value)}
            className="min-h-16"
          />
          <Textarea
            placeholder="Constraints (optional)"
            value={constraints}
            onChange={(e) => setConstraints(e.target.value)}
            className="min-h-16"
          />
          <Textarea
            placeholder="Acceptance criteria (optional)"
            value={acceptance}
            onChange={(e) => setAcceptance(e.target.value)}
            className="min-h-16"
          />
          <div className="grid grid-cols-2 gap-2">
            <select
              className="h-10 rounded-[var(--radius-sm)] bg-bg-subtle px-3 text-sm text-fg shadow-[var(--shadow-border)]"
              value={priority}
              onChange={(e) => setPriority(e.target.value as Priority)}
            >
              {(Object.keys(PRIORITY_LABELS) as Priority[]).map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </option>
              ))}
            </select>
            <Input
              placeholder="tags, comma-sep"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit">Create mission</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
