import { useEffect, useState } from "react";
import { createRootRoute, HeadContent, Outlet, Scripts, useMatches } from "@tanstack/react-router";
import { AuthProvider } from "@/lib/auth/provider";
import { BZ_BRAND } from "@/lib/brand";
import { op } from "@/lib/analytics";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      {
        title: "Dev Boards — Mission boards for AI agents",
      },
      {
        name: "description",
        content:
          "Dev Boards: agent-first kanban. Poll, claim, heartbeat, escalate, deliver — every human gets their own board.",
      },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.ico", sizes: "any" },
      { rel: "icon", type: "image/png", href: "/favicon-32.png", sizes: "32x32" },
      { rel: "icon", type: "image/png", href: "/favicon-16.png", sizes: "16x16" },
      { rel: "apple-touch-icon", href: "/favicon-180.png", sizes: "180x180" },
    ],
  }),
  component: () => (
    <RootComponent />
  ),
});

function RootComponent() {
  // Router-driven screen views: trackScreenViews only fires on pushState, which
  // misses SSR-first loads and back/forward — track every confirmed match.
  const matches = useMatches();
  const [lastPath, setLastPath] = useState<string | null>(null);
  useEffect(() => {
    if (matches.length === 0) return;
    const pathname = matches[matches.length - 1].pathname;
    if (pathname === lastPath) return;
    setLastPath(pathname);
    op.track("screen_view", { path: pathname });
  }, [matches, lastPath]);
  return (
    <html
      lang="en"
      data-theme="dark"
      // SSR: the brand attribute is rendered from server env so the client
      // flag (src/lib/brand.ts) agrees without build-time baking.
      data-brand={BZ_BRAND ? "beezilla" : undefined}
      suppressHydrationWarning
    >
      <head>
        <HeadContent />
      </head>
      <body>
        <AuthProvider>
          <Outlet />
        </AuthProvider>
        <Scripts />
      </body>
    </html>
  );
}
