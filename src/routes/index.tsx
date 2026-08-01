import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { z } from "zod";

const searchSchema = z.object({
  view: z
    .enum(["board", "live", "calls", "agents", "protocol"])
    .optional()
    .catch(undefined),
  project: z.string().optional().catch(undefined),
});

export const Route = createFileRoute("/")({
  validateSearch: searchSchema,
  component: Home,
});

function Home() {
  const search = Route.useSearch();
  return (
    <AppShell
      initialView={search.view ?? "board"}
      initialProjectSlug={search.project}
    />
  );
}
