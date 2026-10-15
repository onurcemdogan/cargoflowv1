# UI-UX-FIX-001 — local delivery

Date: 2026-10-15, Europe/Istanbul. Branch:
`feat/ui-ux-fix-001-operational-polish`. Exact startup baseline:
`c499611d26e76add3d8332662a08a1e73434149c` (fetched current origin/master).
The local delivery commit is branch HEAD (`git rev-parse HEAD`). No push, merge
or deployment. Independent different-model review: gpt-6-astra, APPROVED.

## Five fixes

| Area | Result |
| --- | --- |
| Reports | A real sidebar destination after Shipments and before Products, with an existing lucide analytics icon. DashboardPage keeps its date selectors, sales/financial summaries, charts, city/channel distribution and top products. Operational flow, picking summary and recent operations are removed. Reports receives no shipment/print/track callbacks. Home remains the operational cockpit. |
| Picking | Clicking the image or “Ürün detayları” opens a theme-compatible modal showing the existing image candidates, product/color, remaining quantity, order count, SKU/barcode, variant quantities/codes, stages and related order numbers. Close button, Escape, focus return and keyboard containment work. Related orders use the existing navigation callback. List density, canonical eligibility, filters/search and paging remain. |
| Cargo order navigation | A real App regression reproduced the disappearing drawer for a record absent from the initial pool. The scoped detail GET was appended only to App state; the next workspace read replaced that state from the service pool. The detail is now retained in the same canonical client memory used by paged reads. Exact response identity and account generation are checked. Failed loads show a visible error on Cargo. |
| Automation wording | “Arka planda etiket hazırlama” is in a secondary, default-closed “Gelişmiş” disclosure. Server-derived enabled/disabled status, queue and timing facts remain read-only. Copy states that eligible labels may be prepared in advance and are not automatically printed; when disabled, preparation happens during the existing user action. No toggle/enable API or scheduler change. |
| Integrations | All seven providers use IntegrationConnectionCard with the same “Yönet”/chevron disclosure and default-closed details. Collapsed summaries retain account/read/verification and rollout/blocker facts. Explicit board clicks open/focus the chosen provider. Existing forms and handlers remain provider-specific. A validated Woo auth return opens only Woo. Metadata failures are visible while collapsed and do not claim an empty account list. |

## Preserved behavior and limits

Analytics calculations, data sources and UTC reporting-day/period semantics are
unchanged. Unknown financial values still use the existing unavailable states.
No new reporting or picking completion model was added. Picking inspection uses
the current result, already resolved from persisted orders/catalog; it makes no
extra detail/provider request. Images use the best existing candidates, without
claiming higher resolution. Image failures remain presentation-only.

The necessary runtime correction is frontend memory retention for navigation.
`rememberPersistedOrder` only updates the existing in-memory canonical map and
rejects a stale account generation; it writes no database or persistent storage.
The existing tenant-scoped GET endpoint is unchanged. Wrong response identities
cannot open a different order. No create/print/track/reconcile path was added to
the open action.

Provider/backend contracts, credential encryption, tenant authority, verification
and capability gates, schedulers and fulfillment logic are unchanged. HB unknown
paths still fail closed and account verification stays exact-account scoped.
N11_EPOCH_SEMANTICS_UNVERIFIED and BLOCKED_EXTERNAL remain visible and active;
n11 id:null handling remains conservative. Aras remains internal_test with live
shipment/label writes closed. Unknown payer blocking, carrier mappings,
idempotency/duplicates, public signup off and UNKNOWN_AFTER_NETWORK protections
are untouched. No migration or new dependency. The operator-identified ambiguous
production record was not accessed, retried or tested live.

No production access or provider API calls were performed. The generic local dev
command briefly started the local API as well; it was stopped immediately and
the visual preview used only Vite plus strict synthetic request fixtures. No live
shipment creation was performed or tested.

## Tests

Every command below passed. Composite suites overlap with the full UI run;
their counts must not be summed as distinct coverage.

| Command | Passed |
| --- | --- |
| `npm run test:ui` | 453 tests / 48 files |
| `npm run test:dashboard` | 11 |
| `npm run test:product-ia` | 12 |
| `npm run test:runtime-memory` | 24 |
| `npm run test:integration-status` | 9 backend + 8 UI |
| `npm run test:onboarding` | 22 backend + 13 UI |
| `npm run test:hepsiburada` | 23 backend + 4 UI |
| `npm run test:n11` | 78 backend + 5 UI |
| `npm run test:woocommerce` | 105 backend + 5 UI |
| `npm run test:ikas` | 32 backend + 3 UI |
| `npm run test:aras` | 95 |
| `npm run test:carriers` | 16 backend + 3 UI |
| `npm run test:billing-party` | 43 |
| Affected node regression group below | 131 |
| Targeted new cargo navigation | 5, included in UI |
| Targeted new picking/automation | 4, included in UI |
| Integration connection DOM coverage | 13, included in UI |
| `npx tsc -b --force` | Passed |
| `npm run lint` | 0 errors / 6 pre-existing unused-disable warnings |
| `npm run build` | Passed |
| `git diff --check` | Passed |
| `listOrphanSuratSuiteTests()` registry check | 0 orphan tests |

Affected node group: `orders-ui-flow`, `dashboard-flow`,
`dashboard-refresh-isolation`, `account-scoped-loading-flow`,
`picking-same-product-flow`, `shared-create-print-entry-points-flow`,
`integrations-ui-presentation-flow`, `dashboard-local-analytics-flow`,
`performance-acceptance-flow`, `surat-label-ref-reprint-health-flow`,
`sync-status-copy-flow`, `sync-single-flight-flow` (all `server/*.test.mjs`).

New DOM files are automatically discovered by Vitest. No new server test file
was introduced; updated server tests remain in the existing registry. Existing
SSR assertions for always-open forms/operational Reports were replaced with
assertions for the newly required boundaries. Underlying analytics, eligibility
and lifecycle assertions remain. No skip/todo was introduced.

Cargo tests render the real App, CargoOperationsPage, OrdersPage and drawer;
only startup/IO fixtures are mocked. The absent-pool test failed before the fix
because the next page read removed the visible drawer. Final coverage includes
both pool cases, visible read failure, wrong identity and a late response after
an account-generation change. The warm-pool test waits for real startup readiness
and verifies that the service pool contains the target before navigating.
Woo callback tests exercise default auto-opening with valid return intent.

Non-failing existing jsdom canvas warnings and Vite SSR HMR-port diagnostics
occurred during broader tests. Final gate results above are successful local
checks; no hosted CI run or production verification is claimed.

## Visual checks

The real AppShell and five page components were rendered with synthetic data in
a temporary local harness. The request stub rejected unapproved reads and all
mutations. Home, Reports, Picking, Cargo and Integrations were inspected on
desktop in both themes. Integration details were also checked at 1024px, and
picking modal, Reports navigation and provider disclosures at 375px in both
themes. Page client width equaled scroll width: desktop 1265/1280px depending
on scrollbar, small laptop 1009px, mobile 360px within the 375px viewport. Mobile
product dialog width was 340px. No horizontal page overflow was found.

Screenshots and `visual-checks.json` are conversation artifacts outside the
repository under `outputs/ui-ux-fix-001`. Representative files:
`reports-light.jpg`, `cargo-light.jpg`, `integrations-light.jpg`,
`picking-detail-dark.jpg`, `picking-detail-mobile-light.jpg`,
`picking-detail-mobile-dark.jpg`, `n11-collapsed-mobile-light.jpg`.
All temporary preview files/server/browser tabs were removed and viewport
overrides reset. No real credentials or customer payloads were used.

Remaining limits: image quality depends on stored candidates; inspection is a
snapshot of the selected picking result and refreshes when reopened from an
updated result. Reports keeps the existing UTC reporting-day semantics rather
than changing analytics scope in this UX ticket. No new UX blocker was found.

## Changed files

- `.ai/CURRENT_CONTEXT.md`
- `.ai/CURRENT_TASK.json`
- `.ai/HANDOFF.md`
- `.ai/tickets/UI-UX-FIX-001.md`
- `docs/ui-ux-fix-001-operational-polish.md`
- `server/account-scoped-loading-flow.test.mjs`
- `server/dashboard-flow.test.mjs`
- `server/dashboard-refresh-isolation.test.mjs`
- `server/integrations-ui-presentation-flow.test.mjs`
- `server/orders-ui-flow.test.mjs`
- `server/picking-same-product-flow.test.mjs`
- `server/shared-create-print-entry-points-flow.test.mjs`
- `src/App.tsx`
- `src/components/AppShell.tsx`
- `src/components/PickingProductDetail.tsx`
- `src/index.css`
- `src/integrations/ArasSection.tsx`
- `src/integrations/HepsiburadaSection.tsx`
- `src/integrations/IkasSection.tsx`
- `src/integrations/IntegrationConnection.tsx`
- `src/integrations/N11Section.tsx`
- `src/integrations/WooCommerceSection.tsx`
- `src/pages/CargoOperationsPage.tsx`
- `src/pages/DashboardPage.tsx`
- `src/pages/IntegrationsPage.tsx`
- `src/pages/PickingProductsPage.tsx`
- `src/services/orderWorkflowService.ts`
- `src/test/cargoOrderNavigation.dom.test.tsx`
- `src/test/desiMultiplierSetting.dom.test.tsx`
- `src/test/hepsiburadaSection.dom.test.tsx`
- `src/test/ikasSection.dom.test.tsx`
- `src/test/integrationConnections.dom.test.tsx`
- `src/test/n11Section.dom.test.tsx`
- `src/test/operationalPolish.dom.test.tsx`
- `src/test/productInformationArchitecture.dom.test.tsx`
- `src/test/wooCommerceWizard.dom.test.tsx`
