TASK: UI-UX-FIX-001 — Reports IA, Picking Detail UX, Cargo Order Navigation, Automation Clarity, Integration Card Consistency

REPOSITORY
- Repo: onurcemdogan/cargoflowv1
- Workspace: C:\DevFactory\workspaces\CargoFlow
- Start from current origin/master.
- Expected baseline at task start: c499611d26e76add3d8332662a08a1e73434149c
- Create a NEW branch from current origin/master.
- Suggested branch:
  feat/ui-ux-fix-001-operational-polish

IMPORTANT
This is a UI/UX correction pass, NOT a new capability project.

Do not add unrelated features.
Do not redesign backend/provider contracts.
Do not weaken any safety or verification gate.
Do not make provider calls merely by opening/expanding UI.
Do not change scheduler behavior.
Do not add DB migrations unless an unavoidable technical reason is found; expected result is NO migration.

==================================================
PRODUCT INTENT
==================================================

CargoFlow is an e-commerce fulfillment / shipping operations product.

Main operating flow:
Sipariş geldi
→ Topla
→ Paketle
→ Barkod / Etiket
→ Kargo oluştur
→ Kargoya teslim et
→ Takip et
→ Sorunlu gönderiyi yönet

UI hierarchy must reflect this.

Do NOT turn CargoFlow into a generic ERP / marketplace management suite.

The purpose of this ticket is to fix five specific UX problems observed in production after UI-IA-001 and INTEGRATIONS-UI-001.

==================================================
1. RAPORLAR MUST BE A REAL STANDALONE MENU ITEM
==================================================

CURRENT PROBLEM

There is already a PageKey:
  'reports'

and App already renders DashboardPage for reports.

However:
- Reports is deliberately hidden from the sidebar.
- The Reports page still contains large parts of the previous operational dashboard.
- Therefore it feels like the old Home screen was simply moved to another URL.
- This is not acceptable.

REQUIRED NAVIGATION ORDER

Main sidebar must become:

1. Ana Sayfa
2. Siparişler
3. Toplanacak Ürünler
4. Kargo Operasyonları
5. Gönderiler
6. Raporlar
7. Ürünler
8. Entegrasyonlar

Ayarlar remains in the footer/admin area.

Use an appropriate existing lucide icon for Raporlar.

Do NOT hide Reports behind a Home link only.

--------------------------------------------------
REPORTS PAGE CONTENT
--------------------------------------------------

Reports is analytics.

It SHOULD contain things such as:

- Date/range selector
  - Bugün
  - Dün
  - 7 Gün
  - 30 Gün
  - Bu Ay
  - Özel

- Satış adedi
- Brüt satış
- Net satış
- Ortalama sipariş
- İptal sayısı / tutarı
- İade sayısı / tutarı

- Sales chart
- Türkiye / city sales distribution
- Marketplace sales distribution
- En çok satan ürünler

Existing real-data semantics must be preserved.

Unknown/unavailable financial values must continue showing honest unavailable state rather than invented zero values.

--------------------------------------------------
REMOVE FROM REPORTS
--------------------------------------------------

Reports MUST NOT duplicate operational workspaces.

Remove from Reports page:

- Operasyon Akışı
- Toplanacak Ürünler summary/workspace
- Son Operasyonlar

Do NOT move them somewhere new just to preserve the old screen.

Home = operational cockpit.
Reports = analytics.

That distinction must be obvious.

Do not break the existing underlying analytics calculations or period semantics.

==================================================
2. TOPLANACAK ÜRÜNLER — BETTER PRODUCT INSPECTION
==================================================

CURRENT STATE

The standalone PickingProductsPage is generally good and should NOT be redesigned from scratch.

It currently has:
- product image
- product name
- color
- SKU
- barcode
- quantity
- order count
- variants
- stage breakdown
- expandable related orders

KEEP this architecture.

CURRENT PROBLEM

The user cannot inspect a product comfortably enough.

The thumbnail is too limited.
The user wants to optionally see:
- a larger image
- clearer product details

--------------------------------------------------
REQUIRED UX
--------------------------------------------------

Add a product-detail inspection interaction.

Preferred UX:

A) Clicking the product image opens a larger image preview/lightbox/modal.

AND/OR

B) Add an explicit:
  "Ürün detayları"
or
  "Detayları göster"
control.

The detail view should clearly expose existing persisted data:

- Larger product image
- Product name
- Color
- Total remaining quantity
- Number of related orders
- SKU
- Barcode
- Variants / sizes
- Quantity per variant
- Variant SKU(s)
- Variant barcode(s)
- Stage breakdown
- Related order numbers

Do NOT invent fields that do not exist.

Do NOT make marketplace/provider API calls to obtain extra detail.

Use:
- current picking workspace result
- persisted product catalog
- persisted orders
- existing image candidate resolution

If no larger/original image exists, use the best existing image candidate without pretending it is higher resolution.

Image loading failure must remain presentation-only and must never affect an operational action.

--------------------------------------------------
LIGHTBOX / DETAIL REQUIREMENTS
--------------------------------------------------

If implementing a modal/lightbox:

- click image → opens
- close button
- Escape closes
- sensible aria labels
- no horizontal overflow
- works in dark and light theme
- mobile usable
- do not add a heavyweight UI dependency

Do not turn each product card into an enormous always-expanded card.

Default list density should remain close to current design.

==================================================
3. KARGO OPERASYONLARI — "SİPARİŞİ AÇ" MUST REALLY OPEN IT
==================================================

CURRENT PROBLEM

Production observation:

Kargo Operasyonları
→ Kontrol gereken işlemler
→ "Siparişi aç"

appears to do nothing.

Current wiring already contains:

  onOpenOrder={(orderId) =>
    void requestOrderAction('open', orderId)
  }

and requestOrderAction attempts:
- use order from client pool if present
- otherwise GET /api/orders/:id
- then navigate to Orders with initialOrderId

Do NOT assume that means the UX works.

Reproduce and verify the full real flow.

--------------------------------------------------
ACCEPTANCE BEHAVIOR
--------------------------------------------------

When user clicks:

  Kontrol gereken işlemler
  → Siparişi aç

then:

1. Navigate to Siparişler page.
2. The correct order must be selected/opened automatically.
3. The order detail drawer/modal must be visibly open.
4. It must be the exact clicked order.
5. User must not need to search again.

This must work both when:
- order is already in client order pool
- order must first be loaded with GET /api/orders/:id

If the order cannot be loaded:
- do not silently do nothing
- show a visible error
- remain safe
- do not trigger create/retry/provider mutation

--------------------------------------------------
IMPORTANT SAFETY
--------------------------------------------------

The "Siparişi aç" action is navigation/detail only.

It MUST NOT:
- create shipment
- retry shipment
- print
- call carrier create
- auto-reconcile an UNKNOWN operation
- mutate provider state

Especially preserve UNKNOWN_AFTER_NETWORK safety.

Never auto-retry ambiguous carrier creates.

--------------------------------------------------
TEST REQUIREMENT
--------------------------------------------------

Add a regression test that verifies the actual user-visible chain, not only prop wiring.

At minimum cover:

CASE A
Cargo attention row → click Siparişi aç
→ Orders page displayed
→ exact order detail opened

CASE B
order is initially absent from browser pool
→ scoped GET resolves it
→ Orders page displayed
→ exact order detail opened

CASE C
GET fails
→ visible error
→ no create/print/track operation invoked

Avoid a test that only checks:
  onOpenOrder was called

That is insufficient because production already has that wiring.

==================================================
4. "OTOMATİK ETİKET HAZIRLAMA" IS TOO CONFUSING
==================================================

CURRENT UI

CargoOperationsPage has a prominent card named:

  "Otomatik etiket hazırlama"

The user does not understand what this means.

Actual concept:
eligible labels can optionally be prepared in the background before the user presses the normal action.

This is NOT:
- automatic printing
- an automatic user-visible carrier create permission by itself
- something that should dominate the main operations screen

Production scheduler currently keeps these worker-related flags disabled.

Do NOT enable them.

--------------------------------------------------
REQUIRED UI CHANGE
--------------------------------------------------

Rename the concept to clearer Turkish, preferably:

  "Arka planda etiket hazırlama"

Explain it succinctly:

Example meaning:

"Açık olduğunda uygun yeni siparişlerin etiketi arka planda önceden hazırlanır. Etiket otomatik yazdırılmaz."

When closed:

"Kapalı. Etiketler mevcut kullanıcı işlemi sırasında hazırlanır."

Do not imply this toggle is editable from this page if it is not actually editable.

--------------------------------------------------
VISUAL PRIORITY
--------------------------------------------------

Do NOT keep a large confusing automation card as one of the primary Cargo Operations panels.

Move it into a smaller secondary/advanced area such as:

  Gelişmiş
  → Arka planda etiket hazırlama

or use a compact collapsible information card.

Default closed/collapsed is preferable.

The important main surfaces should remain:
- shipping pipeline KPIs
- Kontrol gereken işlemler
- Son işlemler

No scheduler/env mutation from the UI.

No enable button unless a real, safe, pre-existing supported UI capability exists.
Do not create one in this ticket.

==================================================
5. INTEGRATIONS — ALL PROVIDER CARDS USE THE SAME COLLAPSED MODEL
==================================================

CURRENT PROBLEM

Even after INTEGRATIONS-UI-001, the provider connection surfaces still feel inconsistent.

The desired mental model is the current Trendyol-style interaction:

A provider appears as a compact summary card first.

The credential/configuration form should NOT always be fully open.

--------------------------------------------------
REQUIRED CARD MODEL
--------------------------------------------------

Apply one consistent interaction model to:

MARKETPLACES
- Trendyol
- Hepsiburada
- n11

COMMERCE SITES
- WooCommerce
- ikas

CARRIERS
- Sürat
- Aras

Each provider should initially render as a compact card showing only useful status summary, for example:

- Provider name
- type
- configured / not configured
- verification/read state where applicable
- rollout/internal-test/blocker state where applicable
- useful account identifier if safe to show
- last sync/test if already available

Then provide a clear action such as:

  "Yönet"
  "Ayarları aç"
  "Detaylar"

with a chevron.

Clicking it expands the provider's form/details in-place.

Clicking again collapses it.

--------------------------------------------------
IMPORTANT
--------------------------------------------------

Use the same visual shell and spacing for all providers.

Do NOT make every provider semantically identical.

Provider-specific forms and safety states remain provider-specific.

Examples:

HEPSIBURADA
- account cards remain account-scoped
- basic vs advanced endpoint settings may remain separated
- unknown paths fail closed

N11
- must visibly preserve:
  N11_EPOCH_SEMANTICS_UNVERIFIED
  BLOCKED_EXTERNAL
- no label/write/fulfillment opening

WOOCOMMERCE
- OAuth remains primary flow
- manual REST remains secondary/fallback

IKAS
- internal_test state preserved

ARAS
- live shipment/create restrictions remain visible
- no live production write opening

TRENDYOL / SÜRAT
- retain existing save/test/sync semantics
- do not accidentally change credential requirements

--------------------------------------------------
EXPANSION SAFETY
--------------------------------------------------

Expanding/collapsing a card MUST NOT trigger:

- provider test
- sync
- write
- carrier create
- label create
- OAuth launch
- account verification network call

Persisted metadata GETs already required to render status are fine.

No hidden side effect on:
- mount
- expand
- collapse
- tab/category change

--------------------------------------------------
DEFAULT STATE
--------------------------------------------------

Provider cards should be COLLAPSED by default.

If there is an immediately actionable callback/state such as OAuth return or a newly created account requiring attention, it is acceptable to auto-open only that exact provider if current application state can prove that intent safely.

Otherwise default closed.

==================================================
DESIGN / UI RULES
==================================================

Use existing CargoFlow theme/components/tokens.

Reuse and extend:
- IntegrationConnectionCard
- IntegrationAccountCard
- IntegrationFormSection
- IntegrationFormActions
- Card
- Badge
- Alert
- existing theme variables

Do not introduce a second design system.

No hardcoded light-only colors.

Must work:
- desktop
- smaller laptop widths
- mobile
- dark mode
- light mode

Avoid horizontal scrolling.

==================================================
NON-GOALS
==================================================

Do NOT implement:

- new provider
- new shipping carrier
- new marketplace API behavior
- new reconciliation logic
- new auto-label activation API
- new warehouse state machine
- new picking completion state
- new reporting data model
- new sales metrics with guessed data
- new DB migration
- scheduler activation
- automatic shipment create
- automatic retry
- automatic print

==================================================
SAFETY INVARIANTS — MUST REMAIN
==================================================

Preserve all current shipping safety rules.

Especially:

- UNKNOWN shipping payer blocks create.
- Tenant owns carrier account.
- Explicit carrier ↔ marketplace mapping.
- Existing duplicate/idempotency protections.
- Credentials remain encrypted server-side.
- Public signup remains off.
- Aras stays internal_test / live writes closed.
- N11 epoch semantics blocker remains.
- N11 id:null unknown identity behavior remains conservative.
- Hepsiburada account verification remains exact-account scoped.
- Opening integration UI does not call provider APIs.
- No verification/capability gate weakening.

ABSOLUTELY DO NOT perform or test a live shipment create.

Do not touch/retry the known ambiguous production shipment/order:
- Operator-identified ambiguous production record (identifiers retained only in the original user request).

No production calls are required for this task.

==================================================
TESTS TO ADD / UPDATE
==================================================

Add focused regression coverage.

A. NAVIGATION / REPORTS
- Reports exists in sidebar.
- Correct menu order.
- Reports renders DashboardPage analytics.
- Reports no longer renders:
  - Operasyon Akışı
  - Toplanacak Ürünler
  - Son Operasyonlar
- Home remains operational.
- Reports metrics/period selectors preserved.

B. PICKING
- Existing search/filter/pagination behavior remains.
- Product detail affordance exists.
- Image preview opens/closes.
- Detail shows persisted SKU/barcode/variant/order information.
- No provider call is triggered by opening product detail.
- Mobile DOM remains usable.

C. CARGO OPERATIONS
- Full order-open regression described above.
- No create/print/track side effect from open.
- failure is visible.

D. AUTOMATION CARD
- new wording exists
- collapsed/secondary by default
- no scheduler/config mutation from UI
- worker status still honestly reflects server data

E. INTEGRATIONS
For all seven providers:
- compact card present
- collapsed by default
- expand reveals management form/details
- collapse hides details
- opening does not invoke operational provider handler
- status/blockers remain visible
- credential values are not exposed
- N11 blocker test remains
- Aras restrictions test remains
- Woo OAuth/manual modes remain

F. REGRESSION
Run existing suites relevant to:
- UI
- product IA
- picking
- dashboard
- integration status
- onboarding
- Hepsiburada
- n11
- WooCommerce
- ikas
- Aras
- carriers
- billing party
- runtime memory

==================================================
VALIDATION
==================================================

At minimum run:

npx tsc -b --force
npm run lint
npm run build
npm run test:ui
npm run test:dashboard
npm run test:product-ia
npm run test:runtime-memory
npm run test:integration-status
npm run test:onboarding
npm run test:hepsiburada
npm run test:n11
npm run test:woocommerce
npm run test:ikas
npm run test:aras
npm run test:carriers
npm run test:billing-party

Also run targeted new tests.

Then:
git diff --check

If the project registry requires every new server/*.test.mjs file to be registered in:
  server/testing/suratSuiteFiles.json
do that in the same change.

Do not repeat the previous CI failure caused by an orphan test file.

==================================================
MANUAL / SYNTHETIC VISUAL CHECK
==================================================

Review at least:

DESKTOP
- Home
- Reports
- Picking
- Cargo Operations
- Integrations

MOBILE / NARROW WIDTH
- Picking detail/lightbox
- Integration collapsed/expanded cards
- Reports navigation

Check both:
- dark mode
- light mode

Confirm:
- no horizontal overflow
- no giant always-open integration forms
- no duplicate dashboard/report feeling
- user can understand what the primary action is

==================================================
DELIVERY
==================================================

Do NOT merge.
Do NOT deploy.

At completion provide:

1. branch name
2. exact baseline SHA
3. exact final commit SHA
4. changed file list
5. concise explanation of each of the five fixes
6. tests run + pass counts
7. lint warnings/errors
8. build result
9. migration status
10. confirmation that provider/backend/scheduler behavior was unchanged
11. confirmation that N11 blocker / Aras restrictions / UNKNOWN shipment safety remain unchanged
12. any remaining UX limitation found during implementation

Then STOP and wait for review.