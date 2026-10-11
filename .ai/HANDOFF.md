# DevFactory handoff

Last ticket: ARAS-EXPANSION — MERGED into `integration/roadmap` (PR #8, head `8cd50475f95a72916fb798cc47e61ef96c523507`).

Integration closeout on top of the merge:
- `TENANT_AUTH_PATHS` now covers `/api/integrations/health`, `/api/integrations/woocommerce`,
  `/api/integrations/aras`, `/api/shipping/payer`, `/api/subscription`. These org-scoped routes
  bypassed `tenantAuth` and returned 404 in auth mode (production) despite a valid session.
  Locked for ALL routes by `server/tenant-auth-coverage-flow.test.mjs` (real Express prefix matching).
- `server/db-foundation.test.mjs` schema inventory registers `aras_label_artifacts` (migration 0014);
  ARAS CI only ran `test:ticimax`, so `test:surat` was red on the merged tree.

Next: no auto-selectable ticket. LIVE-PROVIDER-VERIFICATION needs real provider credentials (human).

Do not deploy to production.
Do not bypass BLOCKED_HUMAN or HUMAN_APPROVAL gates.
