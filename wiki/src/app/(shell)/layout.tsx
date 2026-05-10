"use client";

import { useState } from "react";
import Header from "@/components/layout/Header";
import Sidebar from "@/components/layout/Sidebar";
import { AuthGuard } from "@/components/AuthGuard";
import AddWikiModal from "@/components/layout/AddWikiModal";
import { AddWikiProvider, useAddWiki } from "@/components/layout/AddWikiContext";

// H1: the Add Wiki modal is mounted ONCE here so Header (legacy) and
// Sidebar (canonical) can both dispatch open/close through context.
function SharedAddWikiModal() {
  const { open, closeModal } = useAddWiki();
  return <AddWikiModal open={open} onClose={closeModal} />;
}

export default function WikiLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(min-width: 1024px)").matches;
  });

  return (
    <AuthGuard>
    <AddWikiProvider>
    <div
      className="wiki-shell relative"
      data-sidebar={sidebarOpen ? "open" : "closed"}
      style={{ background: "var(--bg)" }}
    >
      {/* Portal slot for QuarantineTopbar: renders in document flow
          before the header so it pushes content down naturally. */}
      <div id="quarantine-banner-root" />

      {/* Header */}
      <div
        className="wiki-header-bar absolute z-20"
        style={{ top: 12, left: 44, right: 44, height: 50 }}
      >
        <Header onMenuToggle={() => setSidebarOpen((prev) => !prev)} />
      </div>

      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-20 lg:hidden"
          style={{ background: "rgba(0,0,0,0.4)" }}
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Desktop sidebar */}
      {sidebarOpen && (
        <aside
          className="wiki-desktop-sidebar hidden lg:block absolute z-10 overflow-y-auto"
          style={{
            top: 118,
            left: 24,
            width: 202,
            bottom: 0,
            scrollbarWidth: "none",
          }}
        >
          <Sidebar />
        </aside>
      )}

      {/* Mobile sidebar — drawer when open */}
      {sidebarOpen && (
        <aside
          className="lg:hidden fixed z-30 overflow-y-auto"
          style={{
            top: 0,
            left: 0,
            width: 250,
            height: "100%",
            paddingTop: 80,
            background: "var(--bg)",
            scrollbarWidth: "none",
          }}
        >
          <Sidebar />
        </aside>
      )}

      {/* Main content */}
      <main className="wiki-main">{children}</main>

      <SharedAddWikiModal />
    </div>
    </AddWikiProvider>
    </AuthGuard>
  );
}
