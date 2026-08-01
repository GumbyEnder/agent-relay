import { createFileRoute, redirect } from "@tanstack/react-router";

/** Bookmarks to /admin land on the main shell Live tab. */
export const Route = createFileRoute("/admin")({
  beforeLoad: () => {
    throw redirect({ to: "/", search: { view: "live" } });
  },
});
