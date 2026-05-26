"use client";

import { SettingsShell } from "@/components/settings/SettingsShell";
import { BackfillPanel } from "@/components/settings/BackfillPanel";

// Stream U: Backfill panel page.
//
// Read-only audit + on-demand trigger for the wiki_agent_schema backfill.
// The cron pass remains audit-only (the heal worker writes hyde_synthetic
// rows incrementally), so manual full-bulk backfill stays an operator
// gesture rather than a background job that can spike model spend.

export default function SettingsBackfillPage() {
  return (
    <SettingsShell
      title="Backfill"
      subtitle="Detect gaps in wiki_agent_schema and trigger backfill on demand."
      backTo="/admin"
      backLabel="Back to admin"
    >
      <BackfillPanel />
    </SettingsShell>
  );
}
