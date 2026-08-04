/**
 * Resolve a board ref (id or slug) against a project catalog.
 * Shared by poll/create paths so agents can use either shape.
 */
export function resolveProjectRef(
  ref: string | null | undefined,
  projects: ReadonlyArray<{ id: string; slug: string }>,
): string | null {
  const t = (ref ?? "").trim();
  if (!t) return null;
  // Unscoped sentinels — caller should treat as "no project filter"
  if (t === "all" || t === "*" || t === "__all__") return null;
  const byId = projects.find((p) => p.id === t);
  if (byId) return byId.id;
  const bySlug = projects.find((p) => p.slug === t);
  return bySlug ? bySlug.id : null;
}
