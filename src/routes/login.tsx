import { useState } from "react";
import { createFileRoute, Link, Navigate } from "@tanstack/react-router";
import { z } from "zod";
import { authClient, authEnabled } from "@/lib/auth/client";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { AuthShell } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const searchSchema = z.object({
  verified: z.string().optional().catch(undefined),
  error: z.string().optional().catch(undefined),
  email: z.string().optional().catch(undefined),
});

export const Route = createFileRoute("/login")({
  validateSearch: searchSchema,
  component: LoginPage,
});

function LoginPage() {
  const search = Route.useSearch();
  const { user, isPending } = useCurrentUserState();
  const [email, setEmail] = useState(search.email ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(
    search.error ? decodeURIComponent(search.error) : null,
  );
  const [info, setInfo] = useState<string | null>(
    search.verified === "1"
      ? "Email verified. You can sign in now."
      : null,
  );
  const [busy, setBusy] = useState(false);

  if (!authEnabled) return <Navigate to="/" />;
  if (isPending) {
    return (
      <div className="grid min-h-dvh place-items-center bg-bg text-sm text-fg-muted">
        Checking session…
      </div>
    );
  }
  if (user) return <Navigate to="/" />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      const { error: err } = await authClient.signIn.email({
        email: email.trim(),
        password,
        callbackURL: "/",
      });
      if (err) {
        const msg = err.message ?? "Sign in failed";
        // Better Auth prompts verification when requireEmailVerification is on
        if (/verif/i.test(msg) || /not verified/i.test(msg)) {
          window.location.assign(
            `/check-email?email=${encodeURIComponent(email.trim())}&reason=unverified`,
          );
          return;
        }
        setError(msg);
        return;
      }
      window.location.assign("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title="Sign in"
      subtitle="Human operators (Dev Boards). Agents use API keys from the Agents tab."
      footer={
        <>
          <p>
            No account?{" "}
            <Link to="/register" className="text-fg underline-offset-4 hover:underline">
              Register
            </Link>
          </p>
          <p className="text-fg-subtle">
            Didn’t get a verification email?{" "}
            <Link
              to="/check-email"
              search={{ email: email.trim() || undefined }}
              className="underline-offset-4 hover:underline"
            >
              Resend
            </Link>
          </p>
        </>
      }
    >
      <form className="space-y-3" onSubmit={(ev) => void submit(ev)}>
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
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          className="h-10"
        />
        {info && (
          <p className="text-xs text-status-ready" role="status">
            {info}
          </p>
        )}
        {error && (
          <p className="text-xs text-status-human" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </AuthShell>
  );
}
