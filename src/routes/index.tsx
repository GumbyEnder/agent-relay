import { createFileRoute } from "@tanstack/react-router";
import React, { useState, useEffect } from "react";
import { authClient, authEnabled } from "@/lib/auth/client";
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
  // Signed-out visitors get a minimal brand landing (logo + Register + Login);
  // signed-in visitors go straight to the Buzzy console.
  if (authEnabled) {
    return <SignedOutLanding />;
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

function SignedOutLanding() {
  // Resolve the session, then either go to the console or show the landing.
  const [state, setState] = useState<{ user: { id: string } | null; pending: boolean }>({
    user: null,
    pending: true,
  });
  useEffect(() => {
    let alive = true;
    authClient
      .getSession()
      .then((res: { data?: { user?: { id: string } | null } | null }) => {
        if (!alive) return;
        setState({ user: res?.data?.user ?? null, pending: false });
      })
      .catch(() => alive && setState({ user: null, pending: false }));
    return () => {
      alive = false;
    };
  }, []);
  if (state.pending) return null;
  if (state.user) {
    // Signed in: brand deployments are civilian-facing — go to the Buzzy console.
    // (Non-brand operator builds keep the operator board below.)
    if (BZ_BRAND && typeof window !== "undefined") {
      window.location.replace("/buzzy/");
      return null;
    }
  }
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
