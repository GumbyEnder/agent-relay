import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { PlatformAdminShell } from "@/components/platform-admin-shell";
import { OperatorGate } from "@/components/operator-gate";
import { BZ_BRAND } from "@/lib/brand";
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
  // BeeZilla brand deployments are civilian-facing: land on the Buzzy intake
  // console instead of the operator board. /buzzy/ is a static asset (not a
  // typed route), so redirect via location, not <Navigate>.
  if (BZ_BRAND) {
    if (typeof window !== "undefined") window.location.replace("/buzzy/");
    return null;
  }
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
