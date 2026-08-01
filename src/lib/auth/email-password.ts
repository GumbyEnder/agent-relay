/**
 * Human email/password auth (this app's Better Auth DB — not an external broker).
 *
 * Flow: register → verification email → sign in.
 * See `server.ts` emailVerification + `src/lib/mailer.ts`.
 * Agents still use API keys only.
 */
export const emailAndPasswordEnabled = true;
