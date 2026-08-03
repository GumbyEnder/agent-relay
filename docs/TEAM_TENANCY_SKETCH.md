# Team / company tenancy sketch

Status: **sketch only** (schema stub + product rules). Not full multi-tenant billing.

## Goals

- Group users under a **company** (org) and optional **teams**.
- Boards stay primarily **user-owned** today; later a board may be owned by a team.
- Private board isolation (owner-or-admin) remains the hard boundary until team ACLs ship.

## Proposed entities

```
company (org)
  id, name, slug, created_at
team
  id, company_id, name, slug
company_member
  company_id, user_id, role (owner|admin|member)
team_member
  team_id, user_id, role (lead|member)
board (ar_projects) — existing
  owner_user_id          -- keep
  owner_team_id NULL     -- NEW optional
  company_id NULL        -- NEW optional denorm for listing
```

## Access rules (target)

| Resource | Who can read/write |
|----------|--------------------|
| Private board (`owner_user_id`) | Owner user, company admin (optional later), platform admin |
| Team board (`owner_team_id`) | Team members + company admin |
| Shared/demo (`owner null`) | Any signed-in operator (current product policy) |

## Migration path

1. **Now:** `0014_team_tenancy_sketch.sql` creates empty tables; app does not require them.
2. **Next:** admin UI to create company + invite members.
3. **Later:** board create with `teamId`; listProjects includes team boards.
4. **Billing:** out of scope — no seats/meters in this sketch.

## Non-goals

- Per-seat billing, SSO/SAML, SCIM
- Cross-company board sharing
- Replacing `ar_operator_roles` (platform roles stay global)

## Relation to platform Admin

Platform Admin (`admin.*`) continues to see all companies eventually; v1 Admin lists **users + boards** without company grouping.
