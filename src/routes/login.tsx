import { useState } from "react";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { authClient, authEnabled } from "@/lib/auth/client";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

function LoginPage() {
  const { user, isPending } = useCurrentUserState();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "signup") {
        const { error: err } = await authClient.signUp.email({
          email: email.trim(),
          password,
          name: name.trim() || email.trim().split("@")[0] || "Operator",
          callbackURL: "/",
        });
        if (err) {
          setError(err.message ?? "Sign up failed");
          return;
        }
      } else {
        const { error: err } = await authClient.signIn.email({
          email: email.trim(),
          password,
          callbackURL: "/",
        });
        if (err) {
          setError(err.message ?? "Sign in failed");
          return;
        }
      }
      // Session cookie is set; hard navigate so shell + /me pick it up.
      window.location.assign("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Auth failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-dvh place-items-center bg-bg px-4 text-fg">
      <div className="w-full max-w-sm space-y-6 rounded-[var(--radius-md)] border border-border bg-bg-elevated p-6 shadow-[var(--shadow-panel)]">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold tracking-tight">
            {mode === "signin" ? "Sign in" : "Create operator account"}
          </h1>
          <p className="text-sm text-fg-muted">
            Human access to Agent Relay. Agents use API keys from the Agents tab — not this form.
          </p>
        </div>

        <form className="space-y-3" onSubmit={(e) => void submit(e)}>
          {mode === "signup" && (
            <Input
              placeholder="Display name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              className="h-10"
            />
          )}
          <Input
            type="email"
            required
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            className="h-10"
          />
          <Input
            type="password"
            required
            minLength={8}
            placeholder="Password (8+ characters)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            className="h-10"
          />
          {error && (
            <p className="text-xs text-status-human" role="alert">
              {error}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "Working…" : mode === "signin" ? "Sign in" : "Create account"}
          </Button>
        </form>

        <button
          type="button"
          className="w-full text-center text-xs text-fg-muted underline-offset-4 hover:underline"
          onClick={() => {
            setMode((m) => (m === "signin" ? "signup" : "signin"));
            setError(null);
          }}
        >
          {mode === "signin" ? "Need an account? Create one" : "Already have an account? Sign in"}
        </button>

        <p className="text-[11px] text-fg-subtle leading-relaxed">
          First account: put your email in{" "}
          <code className="text-fg-muted">AGENT_RELAY_ADMIN_EMAILS</code> (env) so you get admin
          (API keys + GitHub settings). Then open Agents → Create key for harnesses.
        </p>
      </div>
    </div>
  );
}
