import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { PlatformAdminShell } from "@/components/platform-admin-shell";
import { OperatorGate } from "@/components/operator-gate";
import { resolveSurface } from "@/lib/surface";
import { z } from "zod";

const searchSchema = z.object({
  view: z
    .enum([
      "board",
      "live",
      "calls",
      "agents",
      "protocol",
      "journal",
      "analytics",
    ])
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
  const surface = resolveSurface();
  if (surface === "admin") {
    return (
      <OperatorGate>
        <PlatformAdminShell />
      </OperatorGate>
    );
  }
  return (
    <OperatorGate>
      <AppShell
        initialView={search.view ?? "board"}
        initialProjectSlug={search.project}
      />
    </OperatorGate>
  );
}
