"use client";

import { T } from "@/lib/typography";
import { Spinner } from "@/components/ui/spinner";
import { SettingsShell } from "@/components/settings/SettingsShell";
import { AutoAcceptToggle } from "@/components/settings/AutoAcceptToggle";
import { PersonRow } from "@/components/settings/PersonRow";
import { usePendingPersons } from "@/hooks/usePendingPersons";

// Stream U: People panel for pending-person triage.
//
// The list reads GET /admin/people?status=pending (Stream P). When
// Stream P is not yet merged the endpoint returns 404 and the hook
// surfaces the empty state. Approve and reject hit the matching POST
// /admin/people/:key/{approve,reject} routes.

export default function SettingsPeoplePage() {
  const { data, isLoading, error, refetch } = usePendingPersons();

  return (
    <SettingsShell
      title="People"
      subtitle="Pending-person triage. Approve to bring into retrieval, reject to keep out."
    >
      <AutoAcceptToggle />

      {isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner className="size-5" />
        </div>
      ) : error ? (
        <p style={{ ...T.bodySmall, color: "var(--destructive)" }}>
          Failed to load pending people. Try refreshing the page.
        </p>
      ) : !data?.persons?.length ? (
        <div
          style={{
            padding: "48px 16px",
            textAlign: "center",
            color: "var(--heading-secondary)",
          }}
        >
          <p style={{ ...T.body, margin: 0 }}>No pending people.</p>
          <p style={{ ...T.micro, marginTop: 8 }}>
            Either nothing was extracted recently or auto-accept is on.
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
          {data.persons.map((person) => (
            <PersonRow
              key={person.lookupKey}
              person={person}
              onSettled={() => refetch()}
            />
          ))}
        </ul>
      )}
    </SettingsShell>
  );
}
