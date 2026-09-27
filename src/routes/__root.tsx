import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import { AuthProvider } from "@/lib/auth/provider";
import { BZ_BRAND } from "@/lib/brand";
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
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: () => (
    <RootComponent />
  ),
});

function RootComponent() {
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
