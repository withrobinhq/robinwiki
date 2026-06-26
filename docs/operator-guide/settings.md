# Settings shell

The `/settings` route is an Airbnb-style multi-panel surface for the
operator. Three panels ship in v0.2.2: Wikis, People, and Backfill.
Hitting `/settings` redirects to `/settings/wikis`, the default.

## Layout

A side-nav on the left lists the three panels. The main content area on
the right renders the active panel. Every panel shares the same chrome
(back-to-profile button, serif title, secondary subtitle).

## Wikis panel

Path: `/settings/wikis`.

One row per wiki, sorted by most recently updated. Each row carries:

- The wiki name plus its slug (clickable, navigates to the wiki page).
- An autoregen switch that flips optimistically and reverts on error.
- The last-regen time as "Nm ago", with the absolute timestamp on hover.
- The editorial state (empty, learning, dreaming, filed) as a small badge.
- The fragment count.
- A "regen now" button that fires `POST /wikis/:id/regenerate` and
  surfaces the outcome in a toast.
- A yellow indicator dot when the wiki is missing description or
  hyde_synthetic rows in `wiki_agent_schema`. Clicking the dot opens
  the Backfill panel.

After T4 dropped the older `regenerate` boolean, `autoregen` is the sole
regen gate. Operators on default settings have no autoregenerating wikis
until they opt in here per wiki.

## People panel

Path: `/settings/people`.

Header: a toggle for the auto-accept-persons setting. When on, the
extractor lands new persons as verified. When off, they land as pending
and surface here for triage.

Body: one row per pending person, with the canonical name, aliases, the
source-fragment snippet, mention count, first-seen time, and Approve /
Reject buttons.

- Approve fires `POST /admin/people/:key/approve`. The row fades out and
  the person flips to status='verified'.
- Reject fires `POST /admin/people/:key/reject`. The default is a soft
  delete (status='rejected'); a hard delete confirm modal is reserved
  for a follow-up iteration.

When the operator opens a pending person's wiki page directly, a
full-width quarantine banner reminds them that the system has not
involved that person in retrieval, classification, or wiki generation
yet, and provides the same Approve / Reject affordances inline.

## Backfill panel

Path: `/settings/backfill`.

Reads the gap report from `GET /admin/backfill/audit`. Renders one card
per `wiki_agent_schema` kind:

- description: cheap (one embedding call per wiki). Has a "Run backfill"
  button that fires `POST /admin/backfill/wiki-agent-schema` and surfaces
  the result counts in a toast. Refreshes the audit on success.
- hyde_synthetic: an LLM round-trip per wiki. Read-only here. The heal
  worker picks these up on its 15-minute cron tick, bounded so a backlog
  spreads out over the day rather than burning a single block of model
  spend.

A third card lists recent runs from `scheduled_jobs` so operators see
the last time the backfill ran and its outcome.

## Quarantine contract

Pending persons are visible to operators in the Settings People panel
and in the QuarantineTopbar on their wiki page. They are excluded from:

- hybrid search (which filters to `status='verified'`).
- wiki citations.
- automatic wiki regen involvement.

Approving flips the row to status='verified' and brings the person back
into the regular retrieval and citation paths. Rejecting keeps them in
the database with status='rejected' so re-extraction will not re-create
them.

## Auth

All `/admin/*` endpoints (people, settings, backfill) require an
authenticated session. Robin is single-user, so the session check is the
only gate; there is no separate admin token.
