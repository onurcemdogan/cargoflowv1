# ORDERS-CORE-001 — local delivery handoff

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

# ORDER-SELECTION-TARGETS — local follow-up delivery

2026-10-15. Same feat/single-marketplace-account-001-trendyol branch; incremental
baseline 5c2374b35a61f8d49ed772a25e7fe5ecdb7d3a91. COMPLETE / READY_FOR_USER_REVIEW.
Final delivery commit is branch HEAD. No push, merge or deploy.

Product content toggles the existing row selection through a native toggle
button; checkbox and selected-row theme stay synchronized. Other cells/actions
remain separate. The overflow selection shortcut was removed to meet the user's
no-selection-from-actions rule. Header checkbox44x44 and adjacent visible count
label share the same checkbox. Counts intersect visible IDs, preserving off-page
selection. Six table columns/sorting and App/OrdersPage selection/filter/page
logic are unchanged. Empty page disables select-all. No Shift-click/new toolbar.

Tests: new DOM16, focused+filter18; full UI473/50 files; affected orders node65.
TypeScript --force/lint/build/diff passed; lint0 errors/6 existing warnings.
Different-model gpt-6-astra APPROVED, including final alignment margin. Synthetic
browser light/dark proof is in conversation outputs/order-selection-{light,dark}.jpg.
Header and row checkbox align at x44; target44x44 and visible label72x44 at tested
viewport. Preview files/server/tab removed; no viewport override remained.

Only UI runtime changed: src/components/OrdersTable.tsx and src/index.css.
New src/test/orderSelectionTargets.dom.test.tsx covers all requested behaviors
plus keyboard/empty/off-page cases. No backend/provider/production calls, DB
migration, scheduler or fulfillment changes. Original Trendyol account fix and
N11/Aras/UNKNOWN protections remain. User reviews local commits; stop here.

---

# SINGLE-MARKETPLACE-ACCOUNT-001 — local delivery handoff

2026-10-15. Branch feat/single-marketplace-account-001-trendyol; baseline
6bb4d2e3ccfd663e4e2e880f7abb538f327db7a0. COMPLETE / READY_FOR_USER_REVIEW.
Local final commit is branch HEAD. Independent gpt-6-astra review APPROVED.
No push, merge or deployment.

Current payer, carrier mapping settings, integration health/catalog and onboarding
hide inactive Trendyol. The shared predicate affects Trendyol only. UI mixed
response protection and concise actual seller labels are covered by regressions.
Missing stored display name falls back to real seller ID. Backend mapping API
rejects inactive targets; historical mappings remain stored and usable by the
unchanged routing resolver. History repositories and order IDs are not filtered
or reassigned. Trendyol activation now serializes atomically using the tenant
organization row lock; idempotency and old-row preservation remain. There was
no remaining global single-active index to preserve (0013 removed it for Woo).
No migration was introduced; schema edits correct comments only.

Tests: UI457/49; status9+8 UI; billing43; carriers16+4 UI; onboarding22+13 UI;
runtime-memory24; health53; focused account regressions48 including new7 backend;
new4 UI/pure cases included in UI457. Registry orphans0. tsc -b --force/build/
diff check pass; lint0 errors/6 baseline warnings. Initial local API startup
load timeout was cleaned up only for the owned child and passed on isolated
and final sequential reruns. No timeout/skip workaround committed.

Subscription connections.marketplace remains the existing stored-row usage
aggregate and still includes retained history; it is not a current selector.
No provider/production access, scheduler, payer-derivation, fulfillment/create/
label behavior or historical order changes. N11/Aras/UNKNOWN_AFTER_NETWORK and
tenant/encryption/idempotency safety remain. Known ambiguous production shipment
untouched. Full inventory/limits: docs/single-marketplace-account-001-trendyol.md.
Stop after local commit. User reviews; do not push, merge or deploy.

---

# UI-UX-FIX-001 — local delivery handoff

2026-10-15. Branch `feat/ui-ux-fix-001-operational-polish`, exact baseline
`c499611d26e76add3d8332662a08a1e73434149c`. COMPLETE / READY_FOR_USER_REVIEW.
Local delivery commit is branch HEAD. No push, merge or deploy.

Delivered the five user-selected corrections: Reports is an analytics-only sidebar
workspace; picking has a persisted-data image/detail modal; cargo order-open now
retains the exact scoped record across workspace refresh; background label
preparation is collapsed/read-only secondary information; all seven providers
share default-collapsed management cards and unchanged explicit action handlers.
Woo's proven OAuth-return exception remains; N11 blocker and Aras restrictions
remain visible. Aras read failures show unavailable status rather than false empty.

Cargo reproduction: real App attention row → Orders → exact visible drawer. The
absent-pool case failed before the fix when a workspace GET replaced App-only
records. Existing canonical memory now retains detail reads, with exact-id and
account-generation checks. Five navigation tests cover pooled/loaded/failure,
wrong identity and late account-switched response. No provider/write path added.

All gates passed: UI453/48 files; dashboard11; productIA12; runtime-memory24;
status9+8 UI; onboarding22+13 UI; HB23+4 UI; n11 78+5 UI; Woo105+5 UI;
ikas32+3 UI; Aras95; carriers16+3 UI; billing43; affected node131;
new cargo5 and detail/automation4 are included in full UI. Registry orphans0.
TypeScript --force, build and diff check pass; lint0 errors/6 baseline warnings.
Independent gpt-6-astra review APPROVED after fixing collapsed Aras error display.
Synthetic light/dark desktop and narrow/mobile previews verified; no horizontal
page overflow. Temporary preview files/server/tab removed; viewport reset.

No migration, provider/backend contract change, scheduler activation, production
access or provider calls. N11 epoch/id:null, Aras live-write, unknown payer,
tenant/account authority and UNKNOWN_AFTER_NETWORK protections are unchanged.
Known ambiguous production record remains untouched. User review is next.
Full inventory/results/limits: docs/ui-ux-fix-001-operational-polish.md.

---

# INTEGRATIONS-UI-001 — local delivery handoff

2026-10-14. Branch `feat/integrations-ui-001-standardize-connections`, baseline
`891e8f9ef83e47cef56aa14bcf2e72780a55fb7d` (current master after user-merged PR #21).
Implementation COMPLETE; READY_FOR_USER_REVIEW. Local delivery commit is branch
HEAD. No push, merge or deploy. Different-model gpt-6-astra review APPROVED.

Shared pure presentation components provide provider headers, account metadata,
grouped forms, wrapping actions and loading states. HB/n11/Woo/ikas/Aras use them;
routing/payer settings remain separate current-theme cards. Board selection
focuses the actual management surface for all seven providers. Aras's form is
outside the general settings form, so Enter cannot submit unrelated settings.

Backend runtime and provider business handlers are unchanged. Seven modules'
business statement prefixes compare byte-identical to baseline. Verification,
secrets, endpoints, tenant authority and rollout/read/write gates are preserved.
HB unknown paths remain fail-closed; N11_EPOCH_SEMANTICS_UNVERIFIED and
BLOCKED_EXTERNAL remain unchanged; Aras production writes/labels remain closed.
No migration, scheduler changes, production access or provider calls.

All requested gates passed: UI 442/46 files; integration-health 53;
onboarding 22+13 UI; HB 23+4 UI; n11 78+5 UI; Woo 105+5 UI; ikas 32+3 UI;
Aras 95; product IA 12; integration-status 9+8 UI; carriers 16+3 UI;
billing-party 43; presentation 2; new DOM 11 (included in UI442).
tsc -b --force, lint (0 errors/6 baseline warnings), build and diff check passed.
Synthetic browser checks cover light/dark desktop, 1024px and 375px mobile;
no horizontal page overflow. Temporary harness files/server/tab removed.

Full file inventory, per-provider structure, test counts and synthetic screenshot
names: docs/integrations-ui-001-connections.md. User review is next; do not push
until authorized. Prior N11 production absence/external block is unchanged.

---

# UI-IA-001 — historical local delivery handoff

User subsequently merged local commit `1ec901d41d82f79a4bc399e90cf7e22819725710`
via PR #21 (merge `891e8f9ef83e47cef56aa14bcf2e72780a55fb7d`).

2026-10-14. Branch `feat/ui-ia-001-home-picking`, baseline
`b1e12532fe3bcf07d1a982ff4a1c3dc1e2037e6b` (current master fetched before work).
Implementation complete; local delivery commit is branch HEAD. User review is
pending. No push, merge or deploy.

Home has an independent compact statistics section and picking summary link.
Dashboard retains detailed reports and replaces the picking card with a summary.
The new picking workspace reuses canonical grouping/eligibility over persisted
orders; its tenant-auth GET supports search and 30-family pages across the entire
list. Filters select product families; quantities remain whole-family outstanding
quantities. Header totals remain unfiltered. No manual completion flag exists.

All requested gates passed: test:ui 431 (45 files), test:dashboard 11,
test:product-ia 12, picking canonical 45, dashboard operational parity 16,
tenant-auth coverage 3, tsc -b --force, lint (0 errors, 6 baseline warnings), build,
git diff --check. Synthetic browser checks: desktop light/dark, 1024px, mobile
390px viewport; no horizontal overflow. Screenshots are conversation artifacts.

Different-model gpt-6-astra review APPROVED. Corrected findings: register new GET
in tenantAuth, accurately label hourly chart timezone, surface picking order-open
errors. Preview files/server/tab removed after verification. Full changed-file
inventory and test details: docs/ui-ia-001-home-picking.md.

N11 epoch logic, N11_EPOCH_SEMANTICS_UNVERIFIED and N11 BLOCKED_EXTERNAL are
unchanged. No provider/production calls, mutations, shipment/label creation,
scheduler changes, migrations, push or deploy in this UI task.

---

# N11-LIVE-002 — epoch verification handoff

2026-10-14. Branch `agent/N11-LIVE-002`; baseline
`de5c18979deb054f4118dd9d66aae495952281b3` (user already merged PR #19).
Code/report/tests complete; checkpoint capability remains BLOCKED_EXTERNAL.
Independent gpt-6-astra review APPROVED. Local delivery commit is branch HEAD.
No push, merge or deploy requested. No provider calls performed.

Official shipment docs, SOAP-REST comparison and changelog do not disambiguate
normal epoch versus shifted-wall epoch. Repo fixtures/research contain no
independent local datetime/live request correlation. Keep the existing
N11_EPOCH_SEMANTICS_UNVERIFIED blocker; no timezone shift was implemented.
Immutable n11EpochSemantics metadata reports BLOCKED_EXTERNAL/UNKNOWN in sync.

Known client example: 2026-10-14T12:00:00+03:00 -> UTC09:00 -> 1791968400000;
the other candidate is 1791979200000 (+10800000). These explain the variants,
not the provider's proven interpretation. Numeric request serialization and
adaptive sync/config/persistence/fulfillment gates have no logic changes.

Production discovery confirmed there is currently no N11 marketplace account or N11 connector credential. Live epoch verification is therefore externally blocked until a real N11 account is connected through the normal product flow.
Operator-reported production counts (2026-10-14): marketplace_accounts N11 = 0;
connector_credentials provider_key=n11 = 0. No discovery query was rerun for
this documentation correction. See docs/n11-epoch-verification.md for the
unexecuted <=10 GET protocol, requiring a connected real account and explicit
approval before execution: stable known package
last-modified local time, identity controls, two date-filtered variants without
packageIds/orderNumber, negative/boundary controls. Refuse inconclusive, unstable
or multipage results. No API secrets/raw headers/customer payloads in evidence.
Evidence: .ai/research/N11-LIVE-002/epoch-verification.json.

Validation: full test:n11 now includes contracts (51+27 read+5 UI). Account16,
contract packs14, kernel15, health53, status9+8 UI, onboarding22+13 UI, auto-label115,
UI423/44 pass; tsc force/lint/build/diff check pass (6 existing warnings). Two
mutations (remove unknown gate, guess3h shift) fail assertions with byte-exact
restoration. Positive fixture models future trusted proof and still requires
durability. Actual N11 request semantics remain unproven.

## Previous ticket handoff (historical)

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
