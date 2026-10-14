# UI-IA-001 — Home statistics and Picking Products

Implemented locally on `feat/ui-ia-001-home-picking`, based on current master
`b1e12532fe3bcf07d1a982ff4a1c3dc1e2037e6b`. Delivery SHA is branch HEAD.
No push, merge or deployment performed.

## Result

- Home no longer embeds DashboardPage. It retains the six canonical operational
  counters, action summary, persisted integration health and sync timestamps.
  Its own compact statistics show net sales, average order amount, status-based
  return/cancellation amounts, an hourly sales sparkline and channel distribution.
  The existing UTC report-day cohort and Türkiye-time hourly labels are explicit.
  Missing amounts/refund data remain unavailable. No duplicate operational KPIs
  were added to the sales section. Detailed analytics open in Reports.
- Toplanacak Ürünler is a `picking` PageKey after Orders in the main sidebar and
  product tour. Home/Reports show only a compact outstanding-quantity summary
  and Görüntüle link. The dedicated workspace shows product images/fallbacks,
  names, representative SKU/barcode, size quantities, full variant identifiers,
  canonical stage counts, related orders and an explicit order-open action.
- Search covers every eligible family, including variant SKU/barcodes and order
  numbers beyond the old Dashboard cap of 50 families. Pages contain 30 families.
  The stage filter selects families containing the selected stage; it does not
  change that family's quantities. Header totals always describe the full queue.
  No collection-completion record exists in the current data model; the UI states
  this limitation and shows only the remaining canonical queue. Printed/closed
  orders leave it through existing rules, with no new operational state.

## Data and safety

The shared `buildPickingLists` uses existing `isPickingEligible`, package dedupe,
family identity and variant aggregation. Its default Dashboard cap stays 50.
The workspace uses the same helper without that presentation cap, then filters
and paginates. Variant SKU/barcode metadata is additive and never affects family
identity or shipping-label aggregation.

`GET /api/picking/products?page=0&search=...&stage=...` is behind tenantAuth.
`requireOrderPersistenceContext` derives organization and active account on the
server. `loadPickingWorkspace` reads the same persisted workspace projection,
external-processing state and product cache already used by Orders/Dashboard.
It does not sync a provider, persist orders, advance checkpoints, enqueue jobs,
create shipments/labels or change fulfillment. Navigation/filtering only reads;
opening an order explicitly reuses App's existing safe detail-read path.

No DB migration, scheduler change, production access or provider call was made.
N11 epoch code and `N11_EPOCH_SEMANTICS_UNVERIFIED` are untouched; its separate
BLOCKED_EXTERNAL result remains in force.

## Verification

| Command / suite | Result |
| --- | --- |
| `npm run test:ui` | 431 passed in 45 files |
| `npm run test:dashboard` | 11 passed |
| `npm run test:product-ia` | 12 passed |
| `node --test server/picking-same-product-flow.test.mjs` | 45 passed |
| `server/dashboard-operational-parity-flow.test.mjs` | 16 passed, including new persisted workspace parity/isolation/read-only checks |
| `server/tenant-auth-coverage-flow.test.mjs` | 3 passed |
| `npx tsc -b --force` | passed |
| `npm run lint` | passed, 0 errors; 6 existing warnings in unrelated Sürat files |
| `npm run build` | passed |
| `git diff --check` | passed |

UI coverage includes sidebar order/navigation, compact Home/Reports links,
unchanged operational counts, known/unknown financial metrics, canonical queue
recomputation after printing, complete-list paging/search, variant identifiers,
explicit order opening, source-resolution waiting and server-failure behavior.
Server tests compare persisted canonical outputs, forbid fetch during reads,
verify tenant isolation and assert orders/lines/settings are unchanged. Shared
theme CSS contracts are checked outside Vitest's CSS stubbing pipeline.
Non-failing jsdom canvas notices were emitted by existing label tests.

Independent different-model review: **gpt-6-astra APPROVED** after fixing tenant
middleware registration, hourly timezone wording and visible order-open errors.
No remaining actionable findings. User review is pending before push.

## Visual verification

Browser inspection used a temporary local synthetic-data harness with the real
AppShell/Home/Picking components. No production session or API data was used.
Verified both themes at desktop width, a 1024px breakpoint and a 390px mobile
viewport (375px content width after scrollbar); no horizontal overflow observed.
Mobile menu order, collapse after navigation, summary navigation and expanded
variant/order details were checked. Temporary files/server/tab were removed.

Screenshots supplied as local conversation artifacts under `outputs/ui-ia-001/`:

- `home-light.jpg`, `home-dark.jpg`
- `picking-light.jpg`, `picking-dark.jpg`
- `home-mobile-dark.jpg`, `picking-mobile-dark.jpg`

The preview intentionally uses image fallbacks and local-mode integration-health
empty state. It contains no real customers, credentials or provider responses.

## Changed files

- `.ai/CURRENT_CONTEXT.md`
- `.ai/CURRENT_TASK.json`
- `.ai/HANDOFF.md`
- `.ai/tickets/UI-IA-001.md`
- `docs/ui-ia-001-home-picking.md`
- `server/dashboard-operational-parity-flow.test.mjs`
- `server/dashboard/dashboardOperationalService.ts`
- `server/index.mjs`
- `server/picking-same-product-flow.test.mjs`
- `src/App.tsx`
- `src/components/AppShell.tsx`
- `src/components/HomeStatistics.tsx`
- `src/components/PickingSummary.tsx`
- `src/dashboard/dashboardViewModel.ts`
- `src/dashboard/pickingWorkspace.ts`
- `src/index.css`
- `src/pages/DashboardPage.tsx`
- `src/pages/HomePage.tsx`
- `src/pages/PickingProductsPage.tsx`
- `src/services/pickingWorkspaceService.ts`
- `src/test/pickingWorkspace.dom.test.tsx`
- `src/test/productInformationArchitecture.dom.test.tsx`
- `src/test/productTour.dom.test.tsx`
- `src/tour/productTourDefinition.ts`
- `src/types/cargoflow.ts`
- `src/utils/orderProductFamily.ts`
