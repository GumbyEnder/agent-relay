import { createFileRoute, Navigate } from "@tanstack/react-router";
import { authEnabled, GROK_PROVIDERS, signIn } from "@/lib/auth/client";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

function LoginPage() {
  const { user, isPending } = useCurrentUserState();

  if (!authEnabled) {
    return <Navigate to="/" />;
  }
  if (isPending) {
    return (
      <div className="grid min-h-dvh place-items-center bg-bg text-fg-muted text-sm">
        Checking session…
      </div>
    );
  }
  if (user) {
    return <Navigate to="/" />;
  }

  return (
    <div className="grid min-h-dvh place-items-center bg-bg px-4 text-fg">
      <div className="w-full max-w-sm space-y-6 rounded-[var(--radius-md)] border border-border bg-bg-elevated p-6 shadow-[var(--shadow-panel)]">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold tracking-tight">Sign in</h1>
          <p className="text-sm text-fg-muted">
            Operator access for Agent Relay. Agents use API keys — not this page.
          </p>
        </div>
        <div className="space-y-2">
          {GROK_PROVIDERS.map((p) => (
            <Button
              key={p.providerId}
              className="w-full"
              variant={p.idp === "github" ? "default" : "secondary"}
              onClick={() => void signIn(p.providerId, { callbackURL: "/" })}
            >
              Continue with {p.label}
            </Button>
          ))}
        </div>
        <p className="text-[11px] text-fg-subtle leading-relaxed">
          GitHub sign-in is preferred when you also connect issue ingest. Roles
          (viewer / operator / admin) come from{" "}
          <code className="text-fg-muted">AGENT_RELAY_*_EMAILS</code> or admin
          assignment after first login.
        </p>
      </div>
    </div>
  );
}
