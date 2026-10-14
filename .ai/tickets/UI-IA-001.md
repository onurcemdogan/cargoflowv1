# UI-IA-001 — Home statistics and Picking Products workspace

Status: implemented locally, READY_FOR_USER_REVIEW. Branch:
`feat/ui-ia-001-home-picking`; baseline `b1e12532fe3bcf07d1a982ff4a1c3dc1e2037e6b`.

The user selected this task after N11-LIVE-002. Home must have a compact current-
theme sales/operations overview instead of embedding the full Dashboard.
Toplanacak Ürünler must become a first-class sidebar workspace using the existing
canonical operational truth. Full analytics remain separate. No fabricated
metrics, automatic provider sync, writes on viewing/filtering, shipment/label
creation, scheduler change, migration, N11 epoch change, push or deploy.

Delivered: independent Home sales summary; preserved operational counters;
compact picking links in Home/Dashboard; picking PageKey/sidebar/App/tour;
canonical full-list search, family-stage filter and paged read-only workspace;
variant identifiers, related orders, explicit empty/loading/error states and
shared-theme responsive layout. Completion is represented only by existing
canonical queue eligibility, without inventing collection progress.

Verification and full file inventory: [delivery report](../../docs/ui-ia-001-home-picking.md).
Independent reviewer: gpt-6-astra, APPROVED. Requested local checks passed.
User review of local branch HEAD is next; no push until authorization.
