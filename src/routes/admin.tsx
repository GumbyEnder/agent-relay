import { createFileRoute } from "@tanstack/react-router";
import { AdminPortal } from "@/components/admin-portal";

export const Route = createFileRoute("/admin")({
  component: AdminPage,
});

function AdminPage() {
  return <AdminPortal />;
}
