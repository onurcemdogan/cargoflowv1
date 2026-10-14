# Current context

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
