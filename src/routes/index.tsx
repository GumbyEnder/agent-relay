import { createFileRoute } from "@tanstack/react-router";
import React from "react";
import { authEnabled } from "@/lib/auth/client";
import { AppShell } from "@/components/app-shell";
import { PlatformAdminShell } from "@/components/platform-admin-shell";
import { OperatorGate } from "@/components/operator-gate";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
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
  const surface = resolveSurface();

  // The session decides the surface; `authEnabled` only decides whether we have
  // to ask. Returning <SignedOutLanding/> whenever auth was on is what made the
  // operator console unreachable in production: every signed-in operator got the
  // landing, whose only links (/login, /register) bounce straight back to it.
  if (authEnabled) {
    return <SessionEntry search={search} surface={surface} />;
  }

  return <Console search={search} surface={surface} />;
}

type Search = z.infer<typeof searchSchema>;

function Console({ search, surface }: { search: Search; surface: "app" | "admin" }) {
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

/**
 * Session-aware entry. Renders nothing while the session resolves (the same
 * first paint the landing had), then: signed out → brand landing, signed in →
 * the console. BeeZilla-branded builds keep sending their people to /buzzy/,
 * because that deployment is civilian-facing and has no operator board.
 */
/**
 * `beezilla.net` is the consumer front door, `app.devboards.ai` is the operator
 * console. A visitor who types the consumer domain must land in BeeZilla — the
 * operator landing (board sign-in, Dev Boards copy) has no meaning for them.
 * Both domains are served by this same deployment, so the split is by host.
 */
function onConsumerDomain(): boolean {
  if (typeof window === "undefined") return false;
  const h = window.location.hostname.toLowerCase();
  return h === "beezilla.net" || h.endsWith(".beezilla.net");
}

function SessionEntry({ search, surface }: { search: Search; surface: "app" | "admin" }) {
  const { user, isPending } = useCurrentUserState();
  if (onConsumerDomain()) {
    if (typeof window !== "undefined") window.location.replace("/buzzy/talk");
    return null;
  }
  if (isPending) return null;
  if (!user) return <SignedOutLanding />;
  if (BZ_BRAND) {
    if (typeof window !== "undefined") window.location.replace("/buzzy/");
    return null;
  }
  return <Console search={search} surface={surface} />;
}

function SignedOutLanding() {
  // Brand separation is rule zero: BeeZilla's mascot and yellow do not belong on
  // a Dev Boards surface, so each build gets its own front door.
  if (BZ_BRAND) {
    return (
      <div className="bz-landing">
        <img src="/buzzy/brand/revision6_expressions_16-smiling.png" alt="BeeZilla" className="bz-landing-logo" />
        <h1 className="bz-landing-title">BeeZilla</h1>
        <div className="bz-landing-actions">
          <a href="/register" className="bz-landing-btn primary">Register</a>
          <a href="/login" className="bz-landing-btn">Login</a>
        </div>
      </div>
    );
  }
  return (
    <div className="db-landing">
      <div className="db-landing-inner">
        <p className="db-landing-kicker">Dev Boards</p>
        <h1 className="db-landing-title">Mission control for AI agents &amp; humans</h1>
        <p className="db-landing-copy">
          Kanban automation without the PM theater. Poll, claim, heartbeat, escalate, deliver —
          every human gets their own board.
        </p>
        <div className="db-landing-actions">
          <a href="/register" className="db-landing-btn primary">Create an account</a>
          <a href="/login" className="db-landing-btn">Sign in</a>
          <a href="https://devboards.ai" className="db-landing-link">What is Dev Boards? →</a>
        </div>
      </div>
    </div>
  );
}
