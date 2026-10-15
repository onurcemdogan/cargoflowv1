# Current context — ORDERS-CORE-001

2026-10-15 Europe/Istanbul. COMPLETE / READY_FOR_USER_REVIEW on
feat/orders-core-001-authoritative-fast-workspace. Exact baseline:
7e5102d0b5901e3b372b45ed8ba6d7451ba48f22 (user-merged PR #24).
Local delivery commit is branch HEAD. No push, merge or deployment.

Auth Orders paints only a matching current server workspace for its mounted
consumer/query. Pending entry/re-entry hides rows/actions/pagination and leaves
counts unknown. Canonical pool remains selection/detail support; pooled cargo
navigation is preserved. Current workspace rows are never replaced by optimistic
pool objects. Manual refresh is sync POST then workspace GET, without count read,
full collection or automatic product sync. Equal-valued initial search debounce
cannot add another read; real filters retain their debounce and paging behavior.

One coalesced DB reader handles canonical ready/printed/archive notifications and
create/track workflow completion. Account/request generations and consumer keys
reject stale responses before pool/UI writes. Print persistence failure warns and
retains prior operation state. Unsupported auth manual handoff warns without
transport or memory-only status changes. New timing logs contain safe scalars.

Validation: 23 new focused tests; 28 including existing cargo detail navigation;
full UI496/53 files; performance55; runtime-memory24; health53; billing43;
onboarding22 server+13 UI; affected server72; full Sürat3442/270 files/7 batches.
All pass. tsc force, lint (0 errors/6 pre-existing warnings), build, worktree and
staged diff checks pass. Different-model gpt-6-astra read-only review APPROVED,
including pending counts and the equal-value debounce correction. Early source
selector failures were repaired without skips; the final full Sürat run exited0.

No migration or production/provider access. No proof for a cheap incremental
provider tail or safe create-response print authority/activation consolidation:
15-minute cadence, concurrency2, persisted hydration and separate ready POST stay.
Shipping payer/mapping, tenant authority, idempotency, UNKNOWN_AFTER_NETWORK,
worker/status-sync flags and N11 epoch/BLOCKED_EXTERNAL remain unchanged.
Known ambiguous production record was never accessed or retried.

Full root causes, flows, audit evidence, timings, all20 changed files and results:
docs/orders-core-001-authoritative-workspace.md. User review is next. Stop after
local commit: do not push, merge or deploy.

---

# Previous completed task context

# Current context

2026-10-15. Additional ORDER-SELECTION-TARGETS UX change COMPLETE /
READY_FOR_USER_REVIEW. Same branch feat/single-marketplace-account-001-trendyol,
incremental baseline 5c2374b35a61f8d49ed772a25e7fe5ecdb7d3a91. Final local commit
is branch HEAD; original Trendyol account fix remains its parent. No push/merge/deploy.

OrdersTable keeps six columns and existing sort/checkbox controls. Only primary
product image/name/variant/barcode content is now a keyboard-accessible native
toggle button, synchronized through existing onToggleOrder/selectedIds. Existing
selected-row theme is reused. Chevron, detail, overflow and non-product cells do
not select. Removed the redundant explicit selection action from the overflow.

Header has an enlarged44x44 checkbox label plus a visible adjacent native label
linked to that same checkbox via useId, retaining the narrow checkbox column.
Visible-only text is Tümünü seç or N/M seçildi; partial state is indeterminate.
No changes to App/OrdersPage bulk semantics, filters, pagination or off-page
selection; no whole-row click, Shift-click or new toolbar. Empty-page control is
disabled. CSS uses existing theme variables; no new visual system.

Validation: 16 new DOM tests; focused+filter18; full UI473/50 files; affected
orders/filter/pagination/external-processing node65; tsc force/lint/build/diff
pass, lint0 errors/6 baseline warnings. Independent gpt-6-astra APPROVED,
including final checkbox alignment adjustment. Synthetic browser light/dark QA
verified selection and label-driven select/deselect; screenshots are conversation
outputs/order-selection-light.jpg and order-selection-dark.jpg. Temporary
preview files/server/tab removed. No viewport override. No backend/provider/
production/scheduler/fulfillment changes or migrations; N11/Aras safety unchanged.

Changed files: OrdersTable.tsx, index.css, new orderSelectionTargets.dom.test.tsx,
CURRENT_TASK/CURRENT_CONTEXT/HANDOFF and .ai/tickets/ORDER-SELECTION-TARGETS.md.
Stop after local commit; user review is next.

---

# Previous context — SINGLE-MARKETPLACE-ACCOUNT-001

2026-10-15, Europe/Istanbul. SINGLE-MARKETPLACE-ACCOUNT-001 is COMPLETE /
READY_FOR_USER_REVIEW on feat/single-marketplace-account-001-trendyol.
Exact baseline: 6bb4d2e3ccfd663e4e2e880f7abb538f327db7a0 (fresh origin/master).
Local delivery commit is branch HEAD. No push, merge or deploy.

Product rule: one CargoFlow organization has one current Trendyol seller.
Historical account rows remain stored and retain historical order links.
Only literal isActive === true Trendyol rows enter current payer/carrier
settings, integration health/catalog and onboarding. Other providers retain
visibility. Direct mapping calls reject inactive Trendyol targets; full historic
mapping/routing and listAccounts/getAccountById/order detail reads are unchanged.
Shared labels show the provider once and actual seller ID, including when the
stored name is missing; persisted names are not rewritten for presentation.
Existing Trendyol config remains a single account without selectors/toggles.

The global single-active DB index had already been removed by 0013 for Woo.
Supported Trendyol transitions now serialize on an organization row lock inside
one transaction (idempotent upsert, sibling deactivation, target activation).
Failures roll back. No migration; schema edits are comments only. PGlite tests
exercise parallel calls and assert scoped FOR UPDATE SQL, not production stress.
Subscription connection usage remains stored-row metering, including history.

Checks: UI457/49 files; integration-status9+8 UI; billing43; carriers16+4 UI;
onboarding22+13 UI; runtime-memory24; health53; focused account suites48
(includes 7 new backend); 4 new UI/pure cases are included in UI457. Registry
orphans0; tsc force/build/diff check passed; lint0 errors/6 baseline warnings.
An initial local API startup timeout under load passed on isolated/final reruns.
Independent gpt-6-astra review APPROVED, including final identity fallback.

No provider/production calls, scheduler/fulfillment/label changes or migration.
N11 blocker/BLOCKED_EXTERNAL, Aras live-write and UNKNOWN_AFTER_NETWORK remain.
Known ambiguous production shipment never accessed/retried. Full changed files,
behavior and validation: docs/single-marketplace-account-001-trendyol.md.
User review is next. Do not push, merge or deploy.

---

# Previous context — UI-UX-FIX-001

2026-10-15, Europe/Istanbul. Active ticket UI-UX-FIX-001, COMPLETE and
READY_FOR_USER_REVIEW on `feat/ui-ux-fix-001-operational-polish`. Exact baseline:
`c499611d26e76add3d8332662a08a1e73434149c` (current origin/master at startup).
Local delivery commit is branch HEAD. No push, merge or deployment.

Five fixes: standalone analytics Reports after Shipments in sidebar; persisted
picking product detail modal; cargo attention order opening survives paged reads;
background label preparation is collapsed secondary read-only information; all
seven integration providers use the same default-collapsed management shell.
Only validated Woo OAuth-return intent auto-opens Woo. Board selection explicitly
opens/focuses the selected provider. Aras metadata failures remain visible even
while collapsed; failed reads do not claim there are no accounts.

The cargo regression used real App, CargoOperationsPage, OrdersPage and drawer.
Before the fix a single-record GET was appended only to App state, so the next
workspace read replaced it from the service pool and closed the detail. The fix
retains scoped persisted records in existing canonical client memory, checks exact
response identity and rejects a stale account generation. No DB persistence or
provider operation is added. Reports receives no shipment/print/track callbacks.

Checks: UI 453/48 files, dashboard11, productIA12, runtime-memory24,
status9+8 UI, onboarding22+13 UI, HB23+4 UI, n11 78+5 UI,
Woo105+5 UI, ikas32+3 UI, Aras95, carriers16+3 UI, billing43,
affected node131, registry orphans0. tsc --force/build/diff check pass;
lint 0 errors/6 pre-existing warnings. Different-model gpt-6-astra review APPROVED.
Synthetic visual checks: all five desktop surfaces light/dark, 1024px integration
layout, 375px product modal and navigation/provider disclosure; no horizontal
page overflow. Temporary harness files/server/tab removed; viewport reset.

Provider/backend contracts, encryption, tenant authority, scheduler flags and
shipping safety gates are unchanged. No migration or production/provider calls.
N11_EPOCH_SEMANTICS_UNVERIFIED/BLOCKED_EXTERNAL, Aras internal_test/live-write
restrictions and UNKNOWN_AFTER_NETWORK protections remain. Known ambiguous
production record was not accessed or retried. Existing UTC reporting semantics
remain; detail images use best persisted candidates without higher-resolution claims.

Report and complete inventory: docs/ui-ux-fix-001-operational-polish.md.

## Previous task context (INTEGRATIONS-UI-001, included in current master)

2026-10-14, Europe/Istanbul. Supervisor-selected INTEGRATIONS-UI-001, implemented
on `feat/integrations-ui-001-standardize-connections` from current `origin/master`
`891e8f9ef83e47cef56aa14bcf2e72780a55fb7d` (user merged UI-IA-001 via PR #21).
READY_FOR_USER_REVIEW; local delivery commit is branch HEAD. No push/deploy.

Five provider modules use a shared presentation shell/account/form hierarchy:
Hepsiburada, n11, WooCommerce, ikas and Aras. Carrier account routing and shipping
payer use current-theme cards while retaining separate business concepts.
AccountReadStatus preserves configured/verified/read-capability predicates.
Trendyol/Sürat handlers are unchanged; board navigation now focuses all seven
actual management surfaces. Aras's own form sits outside the general settings
form, preventing accidental submission of general settings from Aras fields.

Backend runtime, endpoints, encryption, tenant/verification/capability gates,
schedulers and provider business handlers are unchanged. Seven provider/settings
component business statement prefixes are byte-identical to baseline. HB unknown
paths still fail closed. N11_EPOCH_SEMANTICS_UNVERIFIED/BLOCKED_EXTERNAL remain;
Aras internal_test production shipment/label restrictions remain. No migration.

Checks passed: UI 442/46 files; health 53; onboarding 22+13 UI; HB 23+4 UI;
n11 78+5 UI; Woo 105+5 UI; ikas 32+3 UI; Aras 95; product IA 12;
status 9+8 UI; carriers 16+3 UI; billing-party 43; new presentation 2;
new connection DOM 11 (included in full UI). tsc --force, lint (0 errors/6
existing warnings), build and diff check passed. Different-model gpt-6-astra
review APPROVED. Synthetic local browser verification covered desktop light/dark,
1024px and 375px mobile; no horizontal page overflow after category-tab wrapping.
Temporary preview files, server and browser tab removed.

No production access or provider calls were performed. Full changed-file inventory,
provider before/after structure and verification: docs/integrations-ui-001-connections.md.

## Previous task context (UI-IA-001, merged through PR #21)

Historical local-delivery state below; user subsequently merged commit
`1ec901d41d82f79a4bc399e90cf7e22819725710` via PR #21 into the current baseline.

2026-10-14, Europe/Istanbul. Supervisor-selected UI-IA-001, implemented on
`feat/ui-ia-001-home-picking` from current `origin/master`
`b1e12532fe3bcf07d1a982ff4a1c3dc1e2037e6b`. Local commit delivery only.

Home no longer mounts DashboardPage. Its six operational counters retain their
canonical semantics; compact net sales, average order, returns/cancellations,
hourly sales and channel distribution use the existing view model. Sales cohort
is the UTC reporting day; hourly display labels are Türkiye time. Unknown values
are shown as unavailable. Full analytics remain under Reports.

Toplanacak Ürünler is a first-class picking PageKey after Orders. Its read-only
workspace shares canonical eligibility, package dedupe, product families and
persisted order projection with Home/Orders. It supports full-list search,
30-family paging, family-stage filtering, variant SKU/barcodes and order opening.
Printed/closed orders leave the queue by the existing canonical rules. No separate
collection-completion source was invented. Summary counts cover all dates/filters.
The new GET /api/picking/products uses tenantAuth and server-resolved account scope.

Checks passed: UI 431/45 files; dashboard 11; product IA 12; picking canonical 45;
operational parity 16; tenant-auth coverage 3; tsc --force, lint (0 errors/6 existing
warnings), build, diff check. Independent gpt-6-astra review APPROVED after three
findings were corrected. Browser verification used only a temporary synthetic
local preview (removed), with light/dark desktop and mobile screenshots.

No production access, provider calls, writes, label/shipment creation, scheduler
changes or migrations. No push/merge/deploy. User review is next. Full file/test
list and behavioral limits: docs/ui-ia-001-home-picking.md.

## Previous task context (N11-LIVE-002, unchanged outcome)

2026-10-14, Europe/Istanbul. Supervisor-selected N11-LIVE-002.
Branch `agent/N11-LIVE-002`, baseline `de5c18979deb054f4118dd9d66aae495952281b3`.
PR #19 was merged by the user before takeover; master was clean. No push, merge
or deployment requested on this ticket.

Result: BLOCKED_EXTERNAL for N11 checkpoint advancement only. Code, report and
tests complete; independent gpt-6-astra review APPROVED. Official shipment docs
say milliseconds/GMT+3 but provide no numeric request/local-time pair or
conversion algorithm. SOAP-REST comparison/changelog and repo fixtures/research
do not resolve it. Zero provider API calls.

Production discovery confirmed there is currently no N11 marketplace account or N11 connector credential. Live epoch verification is therefore externally blocked until a real N11 account is connected through the normal product flow.
Operator-reported production counts: marketplace_accounts N11 = 0 rows;
connector_credentials provider_key=n11 = 0 rows (2026-10-14).

Keep N11_EPOCH_SEMANTICS_UNVERIFIED. Current numeric encoding is unchanged.
Local 2026-10-14 12:00 +03 = UTC 09:00 = 1791968400000; alternative shifted-wall
epoch is 1791979200000. Which N11 expects remains UNKNOWN. No conversion guess
or account/body/env proof override. Immutable n11EpochSemantics metadata is
BLOCKED_EXTERNAL/UNKNOWN and sync returns epochVerification. Empty reads and
verified accounts cannot clear it. Existing server-only trusted fixture models
future proof but still requires strict durability; it is not provider evidence.

Evidence: `.ai/research/N11-LIVE-002/epoch-verification.json`.
Report and unexecuted <=10 GET protocol: `docs/n11-epoch-verification.md`.
Needs a stable package last-modified local-time anchor, two numeric variants
and negative/boundary controls. Do not use packageIds/orderNumber in date-filter
comparison queries. No keys/secrets/raw headers/customer payloads in evidence.

Tests: test:n11 now includes foundation contracts in CI (51+27 read+5 UI).
Account16, contract-packs14, kernel15, health53, status9+8 UI, onboarding22+13 UI,
auto-label115, full UI423/44 pass; tsc force/lint/build/diff check pass (6 existing
lint warnings). Two mutations killed by assertions; files restored byte-exact.
Hosted CI/live provider verification are not claimed.

Adaptive splitting/oldest-first/1ms overlap/dedupe/budgets/dense handling/seller
ownership/persistence are unchanged. sender=ALL remains read-only; warehouse
packages gain no fulfillment. id:null remains unpersistable. No migration.
