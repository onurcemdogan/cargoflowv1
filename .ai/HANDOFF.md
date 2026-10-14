# ACCOUNT-LEVEL-LIVE-VERIFICATION-001 — PR #19 review follow-up

2026-10-14. Same branch `feat/account-level-live-verification-001`; follow-up
baseline `f2ff13cfbd19bc438845271103bdadcf64a385ed`. IMPLEMENTATION_COMPLETE.
Independent gpt-6-astra review APPROVED after two findings were fixed (merchant
conflicts erased by normalization, restricted-source producer starvation).
User explicitly authorizes commit and ordinary push to origin on this branch.
Completion SHA is branch HEAD; verify origin/PR head after push. No merge/deploy.

- HB verification requires selected-family path binding or every nonempty
  returned merchant matching. Empty unbound sibling accounts stay unverified;
  credentials survive with HB_ACCOUNT_BINDING_UNPROVEN.
- HB reads offset 0 only; full pages are discarded and intervals split oldest
  first. Minimum 1s, budget 350, retained records <35,000, 1ms overlap/dedupe.
  Package requests <=24h, order requests <=7d; eight planned slices cover the
  initial seven days including overlap headroom. Dense/budget runs are PARTIAL
  with no checkpoint. Raw merchant conflicts remain visible before normalization.
- Producer/catchup forward canonical marketplace and gate the source early;
  descriptor-derived SQL exclusions precede batch LIMIT. Preparation gates the
  persisted source before settings/desi/lifecycle/billing. Trendyol still enqueues.

Validation: account 16; HB 23+4 UI; N11 26+5 UI; auto-label acceptance 115;
onboarding 22+13 UI; health 53; integration status 9+8 UI; connector kernel 15;
Aras 95; focused shipment preflight/Sürat eligibility/label queue, preparation,
catchup and single runner 78. tsc force/build/full UI 423 (44 files) pass;
lint 0 errors/6 existing warnings; diff check passes. A-E plus F (binding),
G (offset walking), H-P/H-C/H-L (pipeline gates) all killed by assertions with
byte-exact restoration. Account suite added to main Sürat test registry.

N11 sender=ALL/adaptive splitting/epoch blocker/id:null, rotation/stale-probe
protection, fulfillment rollout, marketplace writes, Aras unverified production
and UNKNOWN_AFTER_NETWORK retry prohibition remain intact. No live provider
calls, migrations, rollout promotion, new branch, merge or deploy.

## Initial implementation handoff (historical; its no-push instruction is superseded)

# ACCOUNT-LEVEL-LIVE-VERIFICATION-001 handoff

2026-10-14. Branch `feat/account-level-live-verification-001`; base `6287450`.
IMPLEMENTATION_COMPLETE. Independent gpt-6-astra review: APPROVED.
The local completion commit is the branch HEAD. Do not push or deploy.

No Claude WIP existed at takeover. Reused existing credentials, fingerprint/
verification helpers and columns, provider read clients, normalizers/persisters,
N11 adaptive page-0 splitting and cursor durability. No migration.

New small descriptor-driven accountOrdersRead gate loads exact tenant/account
DB evidence and compares currently encrypted credential/config fingerprints.
Save/Test Et persist one bounded safe GET result; failures retain credentials.
Concurrent/stale N11 seller binding is transaction-protected. HB malformed list
members fail closed with HB_RESPONSE_SHAPE_UNVERIFIED.

Canonical order ingestion is separate from external writes. Existing
canTriggerFulfillmentSideEffects is unchanged and now enforced at actual
create/label boundaries against canonical DB identity; spoofed source or edited
identity cannot bypass it. Trendyol single-field collisions are covered.
Onboarding needs verification and first sync on the same active account.
The account UI offers persisted verification/error states and retry.
Aras saves align marketplace/carrier fingerprints; no SetOrder/probe added.

Validation: N11 26 server + 5 UI; HB 23 + 4; Aras 95; integration-health 53;
integration-status 9 + 8; onboarding 22 + 13; connector-kernel 15; carriers/
preflight 16 + 3; tenant/Sürat fulfillment 99; contract-packs 14; account
verification 12; full UI 423. tsc/build pass; lint 0 errors, 6 existing warnings.
A-E mutations all fail assertions and restore modified files byte-exact.
Full test:surat was not run; focused shared-boundary regressions passed.

Production blockers remain honestly scoped: N11 id:null and GMT+3 cursor
advancement (N11_EPOCH_SEMANTICS_UNVERIFIED); HB missing account endpoint/list
configuration; Aras production endpoint, PayorTypeCode/COD and real write proof.
A real user Aras write must retain one SetOrder, persistent idempotency and
GetOrderWithIntegrationCode confirmation of the same IntegrationCode;
UNKNOWN_AFTER_NETWORK must never automatically retry.

No real credentials/provider calls were used in tests. Account verification and
write verification are operational evidence, not inferred from hermetic success.
No secret leakage, automatic external writes, scheduler/deploy changes or rollout
promotion. NOT PUSHED / NOT DEPLOYED.

## Previous handoff (historical)
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
