# SINGLE-MARKETPLACE-ACCOUNT-001

2026-10-15, Europe/Istanbul. Local delivery only; no push, merge or deploy.

- Branch: feat/single-marketplace-account-001-trendyol
- Baseline: 6bb4d2e3ccfd663e4e2e880f7abb538f327db7a0 (fresh origin/master, PR #23 merged)
- Final commit: this report's delivery commit / branch HEAD.
- Review: independent gpt-6-astra, APPROVED, including the seller-identity fallback.

## Result and affected surfaces

One organization supports one current Trendyol seller. Historical rows remain
stored with their original IDs. A shared pure predicate requires literal
isActive === true only for Trendyol (case/whitespace tolerant). Other marketplace
visibility is preserved. No account switcher, extra Trendyol card or activation
toggle was added; the existing single-credential Trendyol configuration remains.

| Surface | Current account behavior |
| --- | --- |
| GET /api/shipping/payer / loadAccountPayerView | Excludes inactive Trendyol before returning current payer rows; payer values and derivation unchanged. |
| ShippingPayerSection | Also filters mixed responses; shows the provider once and actual seller identity. GET-only viewing. |
| GET /api/carrier-accounts / loadCarrierAccountSettings | Lists current settings targets and their mappings; existing Aras exclusion retained. Historical mappings remain stored. |
| CarrierAccountsSection | Inactive Trendyol cannot appear as a mapping selector, even in a mixed response. |
| PUT /api/carrier-accounts/mappings | Rejects inactive Trendyol targets with the existing MARKETPLACE_ACCOUNT_NOT_FOUND response; no mapping write occurs. |
| GET /api/integrations/health | Excludes inactive Trendyol accounts and their account-scoped sync rows, so old errors/successes cannot revive a retired seller. |
| GET /api/integrations/catalog | Account count and current health use filtered settings/health views. |
| Onboarding status/completion | Uses the current settings account projection; retired seller success cannot bootstrap the replacement. |

Current views format an existing real display name and seller ID, or the seller
ID alone if the name is absent, e.g. Trendyol · 222. Persisted display names are
not rewritten for presentation. ProviderAccountId is read transiently for
Trendyol identity; other providers' identifiers are not added to responses.

## Historical integrity and activation

listAccounts, getAccountById, provider-account lookup, backfill and order reads
retain historical access. No order marketplaceAccountId is reassigned. The
regression compares persisted order rows and the original-account detail read
before/after replacement; a foreign tenant still cannot read that order.
Historical carrier routing continues through the unchanged full mapping source.

The old global single-active DB index was already removed by migration 0013 to
support Woo multi-store. It was not recreated. Supported Trendyol activation now
locks the tenant organization row inside a transaction, then performs the existing
idempotent upsert, sibling deactivation and target activation. Locking the existing
organization also covers concurrent first connections. Failure rolls back the
whole transition. Tests exercise parallel calls and verify the scoped FOR UPDATE
query; PGlite serializes transactions, so this is not a multi-process production
Postgres stress test. No DB migration was added. Schema edits are comments only.

Subscription connections.marketplace usage remains the existing stored-row
aggregate, including retained historical rows. It is a metering metric, not a
current account selector; this ticket does not change subscription/entitlement
semantics. The independent reviewer confirmed that scope distinction.

## Validation

| Check | Result |
| --- | --- |
| npm run test:ui | 457 passed, 49 files |
| npm run test:integration-status | 9 backend + 8 UI passed |
| npm run test:billing-party | 43 passed |
| npm run test:carriers | 16 backend + 4 UI passed |
| npm run test:onboarding | 22 backend + 13 UI passed |
| npm run test:runtime-memory | 24 passed |
| npm run test:integration-health (additional affected gate) | 53 passed |
| Focused new backend suite | 7 passed |
| Account foundation/isolation/backfill/sync + new suite | 48 passed |
| npx tsc -b --force | Passed |
| npm run lint | 0 errors, 6 pre-existing unused-disable warnings |
| npm run build | Passed |
| Server suite registry | New test registered; 0 orphans |
| git diff --check | Passed |

The 7 new backend tests cover A-E, current health/catalog/onboarding, missing
display name, no-active-account behavior, parallel transitions and rollback.
Four new UI tests (included in 457) cover strict visibility, label identity,
payer rows and mapping rows with active+inactive fixtures and GET-only viewing.
The existing BPX-4 fixture explicitly marks its current seller active and adds a
retired seller. ONB-9 now asserts the retired seller is absent from current
onboarding but remains persisted; current bootstrap blockers/order counts and
generic multi-store isolation assertions remain.

One initial integration-status run timed out while its local API started under
heavy parallel test/build load and left a child server alive. Only that proven
owned child was stopped. The suite passed on an isolated rerun and on the final
sequential run. No test skip, weakened timeout or runtime workaround was added.
Full test:surat and hosted CI were not run; the required and affected gates above
were run locally. All fixture credentials/data are synthetic; no production or
provider endpoints were contacted.

## Changed files

Runtime/presentation (schema comments only):
- server/carriers/carrierAccounts.ts
- server/connectors/integrationHealthRepository.ts
- server/db/schema.ts
- server/index.mjs
- server/integrations/marketplaceAccountRepository.ts
- server/onboarding/onboardingRepository.ts
- server/shipments/marketplacePayerConfig.ts
- src/integrations/CarrierAccountsSection.tsx
- src/integrations/ShippingPayerSection.tsx
- src/integrations/marketplaceAccountVisibility.ts

Tests/registration:
- server/onboarding-provider-flow.test.mjs
- server/shipping-billing-party-closeout-flow.test.mjs
- server/single-marketplace-account-flow.test.mjs
- server/testing/suratSuiteFiles.json
- src/test/carrierAccounts.dom.test.tsx
- src/test/shippingPayerSection.dom.test.tsx
- src/test/marketplaceAccountVisibility.test.ts

Task documentation:
- .ai/CURRENT_TASK.json
- .ai/CURRENT_CONTEXT.md
- .ai/HANDOFF.md
- .ai/tickets/SINGLE-MARKETPLACE-ACCOUNT-001.md
- docs/single-marketplace-account-001-trendyol.md

## Safety

No provider calls, production access, migration, historical order changes,
scheduler changes or fulfillment/create/label changes. Explicit routing,
UNKNOWN payer, tenant scope, encrypted credentials and idempotency remain.
N11_EPOCH_SEMANTICS_UNVERIFIED/BLOCKED_EXTERNAL, Aras live-write restrictions and
UNKNOWN_AFTER_NETWORK remain unchanged. The known ambiguous production shipment
was never accessed or retried. Stop after local commit for user review.
