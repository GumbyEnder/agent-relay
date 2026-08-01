import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { RedirectToSignIn } from "@/lib/auth/gates";
import { authEnabled } from "@/lib/auth/client";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import type { OperatorRole } from "@/lib/auth/roles";
import { roleCan, type OperatorCapability } from "@/lib/auth/roles";

export type MeResponse = {
  ok: true;
  authRequired: boolean;
  user: { id: string; email: string | null } | null;
  role: OperatorRole | null;
  capabilities: Record<string, boolean>;
};

/**
 * Gate the operator shell when the server requires human sessions.
 * Uses GET /api/agent/me (authRequired) so local open mode works without
 * baking VITE_AUTH_ENABLED=false, while deploy with BETTER_AUTH_URL enforces login.
 */
export function OperatorGate({ children }: { children: ReactNode }) {
  const { user, isPending } = useCurrentUserState();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [meError, setMeError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/agent/me", { cache: "no-store" });
        const data = (await res.json()) as MeResponse;
        if (!cancelled) setMe(data);
      } catch {
        if (!cancelled) setMeError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Still loading me or session
  if (!me && !meError) {
    return (
      <div className="grid min-h-dvh place-items-center bg-bg text-sm text-fg-muted">
        Loading…
      </div>
    );
  }

  const requireAuth = me?.authRequired === true || (meError && authEnabled);

  if (!requireAuth) {
    return <>{children}</>;
  }

  if (authEnabled && isPending) {
    return (
      <div className="grid min-h-dvh place-items-center bg-bg text-sm text-fg-muted">
        Loading session…
      </div>
    );
  }

  if (!user) {
    return <RedirectToSignIn />;
  }

  return <>{children}</>;
}

/** Fetch /api/agent/me for role-aware UI chrome. */
export function useOperatorMe() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/agent/me", { cache: "no-store" });
        const data = (await res.json()) as MeResponse;
        if (!cancelled) setMe(data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "me failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const role = me?.role ?? (!me?.authRequired ? ("admin" as OperatorRole) : null);
  const can = (cap: OperatorCapability) => {
    if (me && !me.authRequired) return true;
    return role ? roleCan(role, cap) : false;
  };

  return { me, error, role, can };
}
