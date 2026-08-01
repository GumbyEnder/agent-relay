/**
 * Local email/password sign-in (this app's Better Auth DB — not any external broker).
 *
 * Enabled for Agent Relay so operators can create an account and sign in without
 * Grok deployer / OAuth broker access. Agents still use API keys only.
 */
export const emailAndPasswordEnabled = true;
