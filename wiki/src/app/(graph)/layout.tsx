import { AuthGuard } from "@/components/AuthGuard";

export default function GraphLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AuthGuard>{children}</AuthGuard>;
}
