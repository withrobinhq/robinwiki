# Stream I — MCP / UI Symmetry + Gap Map

> Anchor for the v0.2.0 control-surface workstream. Captures the legibility
> matrix for the 16 registered MCP tools, the inverse list of UI-only
> writes, and the named gaps the workstream is closing this release.

## 1. MCP tools (registered in `core/src/mcp/server.ts`)

| #  | Tool name           | Verb (English)                     | UI surface                         | Legibility |
|----|---------------------|------------------------------------|------------------------------------|------------|
| 1  | `log_entry`         | Capture a thought                  | API only — no compose page         | 3          |
| 2  | `log_fragment`      | Send fragment to a wiki            | partial — section-edit only        | 3          |
| 3  | `attach_fragments`  | Attach existing fragments to wiki  | partial — UI per-fragment           | 3 (new)   |
| 4  | `create_wiki`       | Create a wiki (#232 strict)        | partial — no type-picker form       | 3          |
| 5  | `edit_wiki`         | Append edit record (regen-deferred)| yes — section editor               | 3          |
| 6  | `list_wikis`        | List wikis with previews + types   | yes                                | 3          |
| 7  | `get_wiki`          | Full wiki detail                   | yes                                | 3          |
| 8  | `get_fragment`      | Full fragment by slug              | yes                                | 3          |
| 9  | `find_person`       | Find by id or fuzzy query          | partial — id route only            | 3          |
| 10 | `brief_person`      | Markdown briefing                  | partial — no brief mode            | 2          |
| 11 | `search`            | Hybrid BM25 + semantic             | yes                                | 3          |
| 12 | `get_wiki_types`    | List wiki types                    | partial — pickers only             | 3          |
| 13 | `create_wiki_type`  | Create custom wiki type            | UI gap (#10)                        | 3          |
| 14 | `get_timeline`      | Audit timeline for a wiki          | UI gap                             | 3          |
| 15 | `list_groups`       | List groups w/ wiki counts         | partial — nav only                 | 3          |
| 16 | `create_group`      | Create a group                     | UI gap                             | 3          |
| 17 | `add_wiki_to_group` | Attach wiki to group               | UI gap                             | 2          |
| 18 | `publish_wiki`      | Publish a wiki                     | yes — settings modal               | 3 (new)   |
| 19 | `unpublish_wiki`    | Revoke a published link            | yes — settings modal               | 3 (new)   |

Aliases (registered post-install per skill pack) surface as the user-facing
layer; canonical names above stay registered for backward compatibility.

## 2. Web-UI writes that have no MCP equivalent

| UI affordance              | HTTP route                       | Notes                                   |
|----------------------------|----------------------------------|-----------------------------------------|
| Delete wiki                | `DELETE /api/wikis/:id`          | Intentionally MCP-suppressed (#179)     |
| Regenerate wiki            | `POST /api/wikis/:id/regenerate` | Operator-side; no MCP equivalent yet    |
| Bouncer-mode toggle        | `PATCH /api/wikis/:id/bouncer`   | Per-wiki control; UI-only by design     |
| Edit wiki metadata         | `PATCH /api/wikis/:id`           | UI-only; `edit_wiki` covers body only   |
| Member-fragments un-attach | `PUT /api/wikis/:id/...`         | UI gap *and* MCP gap (Phase 8 + I3)     |
| Merge wikis                | `POST /api/wikis/:targetId/merge`| Not implemented either side             |

## 3. Stream I — gap-to-action map (this workstream)

| Gap                                  | Closure                                      | Phase  |
|--------------------------------------|----------------------------------------------|--------|
| `source_client` not captured         | Plumb MCP `clientInfo` into write path        | I2     |
| No bulk fragment attach verb         | Ship `attach_fragments` MCP tool              | I3     |
| `publish_wiki` / `unpublish_wiki` removed (#260) | Reinstate via service refactor   | I4     |
| Tool names not legible               | Aliases via skill packs (server-side reg)     | I5+I6  |
| Skill-pack alias plumbing            | Programmatic register API                     | I7     |
| Wiki-type creation form (UI)         | (Out of stream; M7 frontend agent)            | I8     |
| Member-fragments management table    | (Out of stream; M7 frontend agent)            | I8     |

Phase 8 (UI-only gaps) is owned by the M7 frontend agent and is not part
of this PR.

## 4. Decision-gate resolutions (Andrew, 2026-05-07)

- **Gate #6 (alias-layer ownership):** **server-side**. New
  `skill_pack_aliases` table; resolver runs at MCP tool-list time.
- **Gate #5 (rename or alias):** **alias**. Canonical names stay (no
  breaking renames). Per-pack aliases register on top.
- **Gate #2 (`source_client` shape):** entries-only, jsonb
  `{name, version}`, NULL legacy. Stream C2 owns the migration; Stream I
  is the symmetric reader on the MCP path.
- **Gate #1 (`publish_wiki` reinstatement #260):** yes; reinstate via
  shared service so HTTP and MCP both flow through one code path.
- **Gate #3 (`find_person` / `brief_person` collapse):** keep split for
  v0.2.0; revisit post-launch.
- **Gate #4 (UI write parity scope):** confirmed two named gaps; M7
  frontend ships them.
- **Gate #7 (entry-creation MCP tool ownership):** Stream C territory.

## 5. Pre-allocated migration

- `0010_skill_pack_aliases.sql` — see Phase 5+6 commit. Rows shaped as
  `{ pack, alias_name, mcp_tool_name, args_template? }`, unique on
  `(pack, alias_name)`.
