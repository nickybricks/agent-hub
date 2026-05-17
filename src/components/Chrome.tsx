"use client";

import { usePathname } from "next/navigation";
import Sidebar, { MobileTopBar } from "@/components/Sidebar";
import { PageTransition } from "@/components/ui/PageTransition";

/**
 * The split-screen shell at /app is full-bleed and owns its own layout, so the
 * global sidebar nav is suppressed there. Every other route keeps the sidebar.
 */
export default function Chrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const bare = pathname === "/app" || pathname.startsWith("/app/");

  if (bare) return <>{children}</>;

  return (
    <>
      <Sidebar />
      <MobileTopBar />
      <main className="md:ml-[296px]">
        <PageTransition>{children}</PageTransition>
      </main>
    </>
  );
}
