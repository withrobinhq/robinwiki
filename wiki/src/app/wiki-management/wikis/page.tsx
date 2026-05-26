"use client";

import { useState } from "react";
import { T } from "@/lib/typography";
import { Spinner } from "@/components/ui/spinner";
import { Toast } from "@/components/ui/toast";
import { SettingsShell } from "@/components/settings/SettingsShell";
import { WikiRow } from "@/components/settings/WikiRow";
import { useWikis } from "@/hooks/useWikis";

// Stream U: per-wiki control panel.
//
// The list mirrors GET /wikis and lets the operator flip autoregen,
// trigger an on-demand regen, and see when each wiki last rebuilt.
// The autoregen flag is the sole regen gate after T4 dropped the
// older `regenerate` boolean, so without this panel an operator
// running on the new defaults has no autoregenerating wikis.

export default function SettingsWikisPage() {
  const { data, isLoading, error } = useWikis();
  const [toast, setToast] = useState<{
    visible: boolean;
    message: string;
  }>({ visible: false, message: "" });

  const showToast = (message: string) => {
    setToast({ visible: true, message });
  };

  return (
    <SettingsShell
      title="Wikis"
      subtitle="Per-wiki autoregen toggle, on-demand regeneration, and agent_schema status."
    >
      {isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner className="size-5" />
        </div>
      ) : error ? (
        <p style={{ ...T.bodySmall, color: "var(--destructive)" }}>
          Failed to load wikis. Try refreshing the page.
        </p>
      ) : !data?.wikis?.length ? (
        <div
          style={{
            padding: "48px 16px",
            textAlign: "center",
            color: "var(--heading-secondary)",
          }}
        >
          <p style={{ ...T.body, margin: 0 }}>No wikis yet.</p>
          <p style={{ ...T.micro, marginTop: 8 }}>
            Capture an entry and the system will spawn its first wiki
            automatically, or create one from the sidebar.
          </p>
        </div>
      ) : (
        <ul
          style={{
            listStyle: "none",
            padding: 0,
            margin: 0,
            border: "1px solid var(--border)",
            borderBottom: "none",
            borderRadius: 6,
            overflow: "hidden",
          }}
        >
          {data.wikis.map((wiki) => (
            <WikiRow
              key={wiki.id}
              wiki={wiki}
              onRegenSuccess={(id) =>
                showToast(`Regen queued for ${wiki.name} (${id.slice(0, 8)})`)
              }
              onRegenError={(_id, msg) => showToast(`Regen failed: ${msg}`)}
            />
          ))}
        </ul>
      )}

      <Toast
        message={toast.message}
        visible={toast.visible}
        onDismiss={() => setToast({ visible: false, message: "" })}
      />
    </SettingsShell>
  );
}
