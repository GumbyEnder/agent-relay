import { useState } from "react";
import { createFileRoute, Link, Navigate } from "@tanstack/react-router";
import { authClient, authEnabled } from "@/lib/auth/client";
import { BZ_BRAND } from "@/lib/brand";
import { op } from "@/lib/analytics";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { AuthShell } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/register")({
  component: RegisterPage,
});

function RegisterPage() {
  const { user, isPending } = useCurrentUserState();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
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
    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    setBusy(true);
    try {
      const { error: err } = await authClient.signUp.email({
        email: email.trim(),
        password,
        name: name.trim() || email.trim().split("@")[0] || "Operator",
        callbackURL: "/login?verified=1",
      });
      op.track(err ? "register_failed" : "register_submitted", {
        error: err ? (err.message ?? "unknown") : undefined,
      });
      if (err) {
        setError(err.message ?? "Registration failed");
        return;
      }
      // requireEmailVerification: no session yet — go confirm email
      window.location.assign(
        `/check-email?email=${encodeURIComponent(email.trim())}&registered=1`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
    } finally {
      setBusy(false);
    }
  };

  const submitMagicLink = async () => {
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      const { error: err } = await authClient.signIn.magicLink({
        email: email.trim(),
        callbackURL: BZ_BRAND ? "/buzzy/" : "/",
      });
      op.track(err ? "register_magic_link_failed" : "register_magic_link_sent", {
        error: err ? (err.message ?? "unknown") : undefined,
      });
      if (err) {
        setError(err.message ?? "Could not send the magic link");
        return;
      }
      setInfo(
        `Magic link sent to ${email.trim()}. Open it in this browser — it signs you in (and registers you if you're new).`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the magic link");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title="Create account"
      subtitle="Register with email. We’ll send a verification link before you can sign in."
      footer={
        <p>
          Already registered?{" "}
          <Link to="/login" className="text-fg underline-offset-4 hover:underline">
            Sign in
          </Link>
        </p>
      }
    >
      <form className="space-y-3" onSubmit={(ev) => void submit(ev)}>
        <Input
          placeholder="Display name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="name"
          className="h-10"
        />
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
          autoComplete="new-password"
          className="h-10"
        />
        <Input
          type="password"
          required
          minLength={8}
          placeholder="Confirm password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          className="h-10"
        />
        {error && (
          <p className="text-xs text-status-human" role="alert">
            {error}
          </p>
        )}
        {info && (
          <p className="text-xs text-status-ready" role="status">
            {info}
          </p>
        )}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? "Creating…" : "Register"}
        </Button>
      </form>
      <div className="relative py-1 text-center text-[11px] text-fg-subtle">
        <span className="bg-bg-elevated px-2 relative z-[1]">or</span>
        <span className="absolute inset-x-0 top-1/2 border-t border-border" aria-hidden />
      </div>
      <Button
        type="button"
        variant="secondary"
        className="w-full"
        disabled={busy || !email.trim()}
        onClick={() => void submitMagicLink()}
      >
        {busy ? "Sending…" : "Email me a magic link instead"}
      </Button>
      <p className="text-[11px] text-fg-subtle">
        No password needed — we email a one-time sign-in link that registers
        you on first use.
      </p>
    </AuthShell>
  );
}
