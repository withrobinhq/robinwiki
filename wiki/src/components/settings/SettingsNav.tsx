"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Settings, Users, RefreshCw, Layers } from "lucide-react";
import { T } from "@/lib/typography";

// Stream U: Airbnb-style multi-panel side-nav. The three initial panels
// (Wikis, People, Backfill) cover per-wiki autoregen control, pending
// person triage, and gap detection for wiki_agent_schema.
//
// Future panels (Identity, Integrations) will compose into this same
// list. Keeping the registry inside the component (not a separate
// config) so a panel and its nav entry land in the same diff.

const PANELS: Array<{
  href: string;
  label: string;
  Icon: typeof Settings;
  description: string;
}> = [
  {
    href: "/settings/wikis",
    label: "Wikis",
    Icon: Settings,
    description: "Per-wiki autoregen and on-demand regen",
  },
  {
    href: "/settings/people",
    label: "People",
    Icon: Users,
    description: "Pending person triage",
  },
  {
    href: "/settings/wiki-types",
    label: "Wiki Types",
    Icon: Layers,
    description: "Manage wiki type definitions",
  },
  {
    href: "/settings/backfill",
    label: "Backfill",
    Icon: RefreshCw,
    description: "Detect and fill agent_schema gaps",
  },
];

export function SettingsNav() {
  const pathname = usePathname();

  return (
    <nav
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        width: 240,
        flexShrink: 0,
      }}
      aria-label="Settings navigation"
    >
      <p
        style={{
          ...T.micro,
          color: "var(--heading-secondary)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          marginBottom: 12,
          paddingLeft: 12,
        }}
      >
        Settings
      </p>
      {PANELS.map((panel) => {
        const active = pathname === panel.href || pathname.startsWith(panel.href + "/");
        return (
          <Link
            key={panel.href}
            href={panel.href}
            data-active={active ? "true" : "false"}
            className="settings-nav-item"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 12px",
              borderRadius: 6,
              textDecoration: "none",
              color: active ? "var(--heading-color)" : "var(--heading-secondary)",
              background: active ? "var(--card)" : "transparent",
              ...T.bodySmall,
              fontWeight: active ? 500 : 400,
            }}
          >
            <panel.Icon
              className="size-4"
              strokeWidth={1.5}
              aria-hidden
            />
            <span>{panel.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
