import { useCallback, useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { z } from "zod";
import { authClient } from "@/lib/auth/client";
import { AuthShell } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const searchSchema = z.object({
  email: z.string().optional().catch(undefined),
  registered: z.string().optional().catch(undefined),
  reason: z.string().optional().catch(undefined),
});

export const Route = createFileRoute("/check-email")({
  validateSearch: searchSchema,
  component: CheckEmailPage,
});

function CheckEmailPage() {
  const search = Route.useSearch();
  const [email, setEmail] = useState(search.email ?? "");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [devLink, setDevLink] = useState<string | null>(null);

  const loadDevMail = useCallback(async (addr: string) => {
    if (!addr.trim()) return;
    try {
      const res = await fetch(
        `/api/agent/dev/mail?email=${encodeURIComponent(addr.trim())}`,
        { cache: "no-store" },
      );
      if (!res.ok) {
        setDevLink(null);
        return;
      }
      const data = (await res.json()) as {
        ok?: boolean;
        latest?: { actionUrl?: string } | null;
      };
      setDevLink(data.latest?.actionUrl ?? null);
    } catch {
      setDevLink(null);
    }
  }, []);

  useEffect(() => {
    if (search.email) void loadDevMail(search.email);
  }, [search.email, loadDevMail]);

  const resend = async () => {
    setError(null);
    setStatus(null);
    if (!email.trim()) {
      setError("Enter the email you registered with");
      return;
    }
    setBusy(true);
    try {
      const { error: err } = await authClient.sendVerificationEmail({
        email: email.trim(),
        callbackURL: "/login?verified=1",
      });
      if (err) {
        setError(err.message ?? "Could not resend");
        return;
      }
      setStatus("Verification email sent. Check your inbox (and spam).");
      await loadDevMail(email.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not resend");
    } finally {
      setBusy(false);
    }
  };

  const headline =
    search.reason === "unverified"
      ? "Verify your email to sign in"
      : search.registered === "1"
        ? "Check your email"
        : "Email verification";

  const blurb =
    search.reason === "unverified"
      ? "That account exists but the email is not verified yet. Open the link we sent, or resend below."
      : "We sent a verification link to your address. Open it to activate the account, then sign in.";

  return (
    <AuthShell
      title={headline}
      subtitle={blurb}
      footer={
        <p>
          Ready?{" "}
          <Link
            to="/login"
            search={{ email: email.trim() || undefined }}
            className="text-fg underline-offset-4 hover:underline"
          >
            Sign in
          </Link>
          {" · "}
          <Link to="/register" className="underline-offset-4 hover:underline">
            Register again
          </Link>
        </p>
      }
    >
      <div className="space-y-3">
        <Input
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="h-10"
        />
        <Button
          type="button"
          className="w-full"
          variant="secondary"
          disabled={busy}
          onClick={() => void resend()}
        >
          {busy ? "Sending…" : "Resend verification email"}
        </Button>
        {status && (
          <p className="text-xs text-status-ready" role="status">
            {status}
          </p>
        )}
        {error && (
          <p className="text-xs text-status-human" role="alert">
            {error}
          </p>
        )}
        {devLink && (
          <div className="rounded-[var(--radius-sm)] border border-border bg-bg-subtle p-3 space-y-2">
            <p className="text-[11px] font-medium text-fg-muted">
              Dev mail inbox (no SMTP configured)
            </p>
            <a
              href={devLink}
              className="block break-all text-xs text-accent underline-offset-2 hover:underline"
            >
              {devLink}
            </a>
            <Button
              type="button"
              size="sm"
              className="w-full"
              onClick={() => {
                window.location.assign(devLink);
              }}
            >
              Open verification link
            </Button>
          </div>
        )}
        <p className="text-[11px] text-fg-subtle leading-relaxed">
          Production: set <code className="text-fg-muted">SMTP_HOST</code> /{" "}
          <code className="text-fg-muted">SMTP_URL</code> or{" "}
          <code className="text-fg-muted">RESEND_API_KEY</code> so mail leaves the
          server. Locally the link appears above when the dev inbox is enabled.
        </p>
      </div>
    </AuthShell>
  );
}
