export const BEEZILLA_HONCHO_WORKSPACE = "beezilla-clients";

/** Fields that must never be written to Honcho. */
export const HONCHO_FORBIDDEN = [
  "wallet",
  "payment",
  "api_key",
  "model_id",
  "token_count",
  "transcript",
] as const;

export function isForbiddenHonchoText(text: string): boolean {
  const lower = text.toLowerCase();
  return HONCHO_FORBIDDEN.some((k) => lower.includes(k.replace("_", " ")) || lower.includes(k));
}

export function factAllowed(text: string): boolean {
  return text.trim().length > 0 && !isForbiddenHonchoText(text);
}
