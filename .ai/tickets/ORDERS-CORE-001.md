TASK: ORDERS-CORE-001 — authoritative Orders workspace, instant operational transitions, refresh + label performance

REPOSITORY
- Repo: onurcemdogan/cargoflowv1
- Workspace: C:\DevFactory\workspaces\CargoFlow
- Baseline MUST be current origin/master:
  7e5102d0b5901e3b372b45ed8ba6d7451ba48f22
- Create a NEW branch:
  feat/orders-core-001-authoritative-fast-workspace

DO NOT merge.
DO NOT deploy.
Expected migration: NONE.

==================================================
PRODUCT PRIORITY
==================================================

Orders is a critical operational workspace.

Required product behavior:

1. Entering Orders must NEVER briefly show an obsolete operational snapshot
   and then replace it with the current list.

2. Current CargoFlow DB state must appear as quickly as possible.

3. A local operational action such as label creation / print / archive must
   move the order to the correct tab/state immediately after the canonical
   persistence succeeds.

4. Manual "Şimdi Yenile" must update orders without blocking on unrelated
   product-catalog synchronization.

5. We want to reduce label-create latency where possible WITHOUT:
   - weakening carrier verification
   - weakening idempotency
   - enabling the label worker
   - creating a second carrier-create path
   - repeating uncertain create calls

Correctness has priority over fake instant UI.

==================================================
PART 1 — REMOVE STALE FIRST PAINT FROM ORDERS
==================================================

Audit current auth-mode Orders bootstrap.

Current architecture contains:
- account-scoped SWR order cache
- ~30 second cache TTL
- shownWorkspaceRef stale-while-revalidate behavior
- canonicalOrderPool containing records seen during the session
- server-side /api/orders/workspace canonical projection

This currently allows an old operational snapshot to be visible briefly
while the new workspace request is running.

For the ORDERS operational screen:

The visible table source-of-truth must be the CURRENT
/api/orders/workspace response for the active account/query.

Do NOT render an old workspace snapshot as though it is current when
re-entering Orders.

Acceptable behavior while authoritative DB workspace is loading:
- existing page shell
- lightweight loading state/skeleton

Unacceptable:
- showing already-processed old orders in "Yeni Siparişler" for a moment.

IMPORTANT:
Do not remove canonicalOrderPool if it is still needed for:
- selected orders
- detail navigation
- cross-page action identity

But it must NOT become the authority for visible workspace membership.

Preserve:
- account-generation stale response protection
- tenant/account isolation
- paging
- filters
- selection behavior
- detail navigation

==================================================
PART 2 — MANUAL REFRESH MUST BE LEAN
==================================================

Audit:
src/App.tsx -> handleFetchOrders
src/services/orderWorkflowService.ts -> fetchOrdersAuthMode

Current measured/visible chain can include:

POST /api/orders/sync
→ GET /api/orders?page=1&pageSize=1
→ possibly POST /api/products/sync
→ full product reload
→ GET /api/orders/workspace

This is too much for an order refresh.

A. REMOVE PRODUCT SYNC FROM ORDER REFRESH CRITICAL PATH

handleFetchOrders MUST NOT automatically call fetchProducts() merely because
ordersMissingImages(...) is true.

Missing product images are presentation enrichment, not order correctness.

Order refresh must complete even if:
- product image is absent
- product catalog is stale
- image enrichment fails

Use currently available cached/catalog data only.

If optional image enrichment is performed later:
- it must be non-blocking
- it must NOT call marketplace/provider as part of order refresh
- it must NOT delay current order list

Do not change explicit "Ürünleri Senkronize Et" behavior.

B. REMOVE EXTRA COUNT REQUEST FROM CRITICAL PATH

fetchOrdersAuthMode currently calls fetchOrdersTotal()
after /api/orders/sync only to produce a message.

Do not make the user wait for an extra
GET /api/orders?page=1&pageSize=1
just for informational copy.

The authoritative workspace response already knows current totalItems.

Either:
- remove total from the sync result copy, or
- derive it after workspace refresh

but do not keep the count request in the critical sync path.

TARGET STRUCTURAL REQUEST FLOW:

manual refresh:
POST /api/orders/sync
→ GET /api/orders/workspace

No automatic product sync.
No full order download.
No extra count GET.

==================================================
PART 3 — INSTANT CORRECT TAB TRANSITIONS
==================================================

Current problem:

create/print operations can update the CargoOrder object in React state,
while ordersWorkspace/tabCounts/list membership remains based on the OLD
server workspace projection.

This causes examples such as:

Barkod Bekliyor
  → label is actually created
  → row visually remains in Barkod Bekliyor
  → only moves after later refresh

Fix this.

Create ONE coalesced DB-only workspace revalidation mechanism.

Example concept:
requestOrdersWorkspaceRevalidation(reason)

Requirements:
- provider call = ZERO
- carrier call = ZERO
- reads only /api/orders/workspace
- uses current workspaceQueryRef
- preserves request-generation/stale-response protections
- concurrent mutations must not create a request storm
- if a revalidation is already running, allow at most one trailing refresh
  when another canonical mutation completes

Trigger it after successful canonical persisted changes that affect workspace
membership/counts, including at minimum:

- LABEL_READY persistence
- LABEL_PRINTED persistence
- successful label create
- print transition
- external-processing archive/restore
- other existing order operationStatus changes used by workspace tabs

Do NOT move an order merely because an optimistic client object says so.

Rule:

PERSISTENCE SUCCESS
→ immediate local feedback if already available
→ DB-only workspace revalidation
→ exact server tab membership/counts replace optimistic view

Persistence failure:
→ do NOT falsely move the order.

The user must not have to press Yenile after a successful operation.

==================================================
PART 4 — WORKSPACE STATE MODEL
==================================================

Audit the split between:
- `orders`
- `ordersWorkspace`
- `canonicalOrderPool`

Document and enforce responsibilities.

Desired model:

ordersWorkspace
= visible table membership, totals, tab counts, filters, pagination

canonicalOrderPool
= safe in-session lookup/action/detail support only

provider sync
= updates canonical DB

The visible table must not accidentally derive tab membership from a union
of old canonical pool records.

Do not break pooled order detail navigation introduced by UI-UX-FIX-001.

==================================================
PART 5 — PROVIDER FRESHNESS
==================================================

DO NOT simply restore "call /api/orders/sync on every mount/focus".

The repository intentionally removed that behavior because it caused:
- duplicate provider requests
- rate-limit pressure
- overlapping synchronization
- partial/502-style failures

Current production:
TRENDYOL_STREAM_SYNC_ENABLED=true

Current stream scheduler default:
15 minutes

TRENDYOL_STATUS_SYNC_ENABLED is deliberately false.

DO NOT change production flags in this ticket.

Research the existing:
- Trendyol stream checkpoint
- cursor/window behavior
- 5 second inter-page minimum
- 15 minute scheduler
- manual incremental sync
- single-flight protection
- 429/backoff contracts

Goal:
find a SAFE path toward fresher provider data without a provider-call storm.

IMPORTANT:
Do NOT blindly change 15 minutes to 60 seconds.

The current stream starts a new recent window after a completed chain.
Prove request volume is bounded before reducing cadence.

If exact low-cost incremental-tail semantics cannot be proven from existing
contracts/tests/evidence:
- leave cadence unchanged
- document the blocker
- do NOT guess.

This task MUST still fix local CargoFlow freshness immediately:
page entry gets current DB state and local operations reclassify immediately.

==================================================
PART 6 — LABEL CREATE PERFORMANCE, WORKER-INDEPENDENT
==================================================

Production label worker is currently intentionally disabled.
Do NOT enable it.

Audit single-order primary flow:

click
→ preflight
→ carrier create
→ canonical label-ready persistence
→ persisted-label hydration if needed
→ render/print

Existing orchestrator already measures:

preflightMs
lookupMs
createMs
hydrateMs
printMs
durationMs

PRESERVE and improve these timings.

First identify avoidable CargoFlow round trips separately from unavoidable
Sürat network latency.

Investigate:

A. REDUNDANT LABEL HYDRATION

Fresh create can return a printable label in the create result, but the
print path may then call persisted-label hydration again.

Do NOT simply bypass server print authority.

Preferred safe optimization:
if the canonical create response can return the SAME authoritative
server print contract that a subsequent GET /api/orders/:id/label would
return, reuse that contract for the same run and remove the redundant
round trip.

Requirements:
- server remains authority for print bytes
- no client-created fallback
- no weakened print eligibility
- reprint behavior unchanged
- persisted label remains canonical source after page reload

If this cannot be done without weakening provenance, keep current hydration
and document it.

B. LABEL_READY PERSISTENCE ROUND TRIP

Audit whether manual create currently requires:
carrier-create request
THEN separate POST /api/orders/:id/label-ready

Determine whether the manual create handler can atomically persist the same
canonical LABEL_READY/user activation state before responding.

CRITICAL:
worker and manual paths share create infrastructure.

Do NOT accidentally make worker-created labels user-activated.

Only consolidate this round trip if manual-vs-background intent remains
explicit and existing worker semantics remain unchanged.

Otherwise leave it alone.

C. BULK CONCURRENCY

Current SURAT_CREATE_CONCURRENCY = 2.

DO NOT raise it because "more parallel = faster".

For a single label it provides ZERO advantage.

Only change concurrency if:
- benchmark proves create is the bottleneck
- provider request/rate behavior supports it
- duplicate/idempotency invariants remain intact

Expected default for this ticket: keep 2 unless evidence proves otherwise.

==================================================
PART 7 — PERFORMANCE OBSERVABILITY
==================================================

We need to know why something is slow without logging PII.

Keep/add safe timings for:

ORDERS:
- providerSyncMs
- workspaceReloadMs
- total manualRefreshMs
- workspace cacheHit
- workspace dbMs
- workspace projectionMs

LABEL:
- preflightMs
- createMs
- labelReadyPersistMs if separate
- hydrateMs
- printMs
- total durationMs

No:
- customer names
- addresses
- phones
- raw ZPL
- credentials
- raw marketplace payloads

Use stable safe log prefixes.

==================================================
PART 8 — REQUIRED REGRESSION TESTS
==================================================

Add tests proving:

1. ORDERS FIRST PAINT
Given an old cached/SWR operational snapshot and a newer DB workspace:
- old rows are NOT rendered as current Orders data first
- authoritative workspace becomes visible
- no cross-account stale flash

2. NAVIGATION
Leaving Orders and returning:
- no obsolete operational workspace flash

3. MANUAL REFRESH REQUEST BUDGET
In auth mode, ordinary order refresh:
- exactly one order sync path
- workspace reload
- NO automatic /api/products/sync
- NO extra /api/orders?page=1&pageSize=1 total request
- NO full orders collection download

4. PRODUCT IMAGES
Missing image:
- does not block order refresh
- does not automatically cause marketplace product sync

5. LABEL_READY TAB MOVEMENT
Order initially classified as Barkod Bekliyor.
Canonical label-ready persistence succeeds.
Without user pressing refresh:
- DB workspace is revalidated
- order leaves old bucket
- appears in correct label-ready bucket
- counts update

6. PRINTED MOVEMENT
LABEL_READY → LABEL_PRINTED:
- visible workspace/counters update without manual refresh

7. FAILURE
If persistence fails:
- optimistic row is not accepted as canonical
- wrong tab transition is not shown as success

8. REVALIDATION COALESCING
Several local state transitions close together:
- no provider calls
- no request storm
- final workspace state is newest canonical state

9. NO SECOND CREATE
All new refresh/revalidation behavior must prove:
- no new carrier create call
- no duplicate shipment
- UNKNOWN_AFTER_NETWORK remains blocked

10. LABEL PERF CONTRACT
If a redundant hydration optimization is implemented:
- print bytes still originate from authoritative server contract
- create call count remains exactly one
- reprint semantics unchanged
- blocked server print contract cannot be bypassed

==================================================
PART 9 — SAFETY / NON-GOALS
==================================================

DO NOT:

- touch/retry known ambiguous production order
- weaken UNKNOWN_AFTER_NETWORK
- auto-retry uncertain create
- infer shipment success from timeout/network failure
- change shipping payer rules
- change tenant/account ownership
- weaken carrier mapping
- expose another tenant's data
- remove idempotency
- enable LABEL_WORKER
- enable TRENDYOL_STATUS_SYNC
- enable stale reconcile
- alter PM2/env
- perform live provider calls
- delete historical records
- create a new carrier-create implementation

Known dangerous order must NEVER be used for testing:
order 11702506473
package 4238186037
tracking 7270037950982625

Use synthetic fixtures only.

==================================================
PART 10 — VALIDATION
==================================================

Run at minimum:

npx tsc -b --force
npm run lint
npm run build
npm run test:ui
npm run test:performance:acceptance
npm run test:runtime-memory
npm run test:integration-health
npm run test:billing-party
npm run test:surat
npm run test:onboarding

Run all new focused Orders tests.

Run:
git diff --check

If a new server/*.test.mjs requires suite registration,
update server/testing/suratSuiteFiles.json.

Do not run real Trendyol or Sürat calls.

==================================================
DELIVERY REPORT
==================================================

At completion provide:

1. branch
2. baseline SHA
3. final commit SHA
4. exact root causes confirmed
5. before/after request flow for Orders refresh
6. first-paint behavior before/after
7. operational tab transition before/after
8. label timing findings
9. label round trips removed, if any
10. provider calls added/removed
11. changed files
12. test counts/results
13. TypeScript/lint/build/diff results
14. migration status
15. confirmation all production safety invariants remain
16. anything NOT optimized because evidence was insufficient

STOP.
Do not push unless explicitly requested.
Do not merge.
Do not deploy.