TASK: SINGLE-MARKETPLACE-ACCOUNT-001 — enforce one visible Trendyol account per CargoFlow organization

REPOSITORY
- Repo: onurcemdogan/cargoflowv1
- Workspace: C:\DevFactory\workspaces\CargoFlow
- Start from current origin/master.
- Create a NEW branch.
- Suggested:
  feat/single-marketplace-account-001-trendyol

PRODUCT DECISION

CargoFlow product rule:

ONE CargoFlow organization/account = ONE Trendyol seller/store.

If a customer wants to manage another Trendyol seller account, they must use a separate CargoFlow organization/account.

We do NOT want multi-Trendyol-store support inside one organization.

IMPORTANT

Historical/past marketplace account rows may already exist in DB.
Do NOT delete them automatically.
Do NOT merge them.
Do NOT reassign historical orders between marketplaceAccountId values.

They may remain for data integrity/history.

The correction is:
- only the current ACTIVE Trendyol account should be exposed as the normal customer-facing Trendyol account
- old/inactive Trendyol account records must not appear as if they are another currently usable store

==================================================
CURRENT PROBLEM
==================================================

Production UI can show something like:

Trendyol · Trendyol • 696196
Trendyol · Trendyol • 277221

in shared integration areas such as:
- Kargo ücreti ödeyeni
- possibly carrier account mappings / shared settings

This is confusing.

The repository currently intentionally preserves older marketplace_accounts rows and marks old Trendyol accounts inactive when a different sellerId becomes active.

That persistence behavior is fine.

What is wrong:
shared customer-facing views often list ALL organization marketplace accounts, including inactive historical Trendyol accounts.

==================================================
REQUIRED BEHAVIOR
==================================================

For TRENDYOL:

Within a normal CargoFlow organization, customer-facing operational/settings screens should expose ONLY the ACTIVE Trendyol marketplace account.

Inactive historical Trendyol rows:
- remain in DB
- remain linked to historical records
- remain available to backend integrity/history where required
- are NOT shown as a second normal active/integrated Trendyol store

This task must NOT introduce multi-store activation.

==================================================
1. SHIPPING PAYER SECTION
==================================================

Current endpoint:
GET /api/shipping/payer

Current load path:
loadAccountPayerView(...)

It currently lists all marketplace_accounts for the tenant.

Fix presentation/source behavior so inactive Trendyol historical accounts are NOT returned/rendered as normal rows.

Preferred rule:

For marketplace === 'Trendyol':
  include only isActive === true

For other marketplaces:
  preserve current behavior unless there is an existing explicit product rule requiring otherwise.

Do NOT globally filter every marketplace account without analysis.

Why:
This ticket is specifically enforcing the one-Trendyol-store product rule, not redesigning all provider account models.

Expected example:

Before:
Trendyol · Trendyol • 696196
Trendyol · Trendyol • 277221

After:
Trendyol · Trendyol • 277221
or whichever exact Trendyol account is active.

==================================================
2. INTEGRATIONS UI
==================================================

Check all customer-facing surfaces that display Trendyol account identity.

The user should see ONE current Trendyol seller/store.

Do not render old inactive Trendyol seller IDs as alternative manageable stores.

The existing Trendyol configuration UI should remain single-account.

Do NOT add:
- account switcher
- multiple Trendyol cards
- active/passive toggle
- account selector

==================================================
3. CARRIER MAPPING / ACCOUNT SETTINGS
==================================================

Inspect:
- carrier account mapping UI/API
- shipping payer
- integration health/status
- onboarding/shared integration settings
- any list derived from marketplace_accounts

If inactive historical Trendyol accounts are surfaced as selectable/current operational accounts, filter them out.

IMPORTANT:
Do NOT break historical order reads.

A historical order already tied to an inactive marketplaceAccountId must still remain readable and identifiable.

The filtering applies to:
- current configuration choices
- current operational account selection
- current settings presentation

NOT to:
- historical order persistence
- audit/history
- migration/backfill integrity

==================================================
4. BACKEND INVARIANT
==================================================

Preserve the existing active-account transition logic:

When a new Trendyol sellerId is connected:
- same exact providerAccountId remains idempotent
- previous Trendyol account may be marked inactive
- new one becomes active
- old DB row remains

Do NOT delete historical account rows.

Do NOT modify old orders to the new account.

Do NOT allow two active Trendyol accounts.

If a DB invariant already ensures one active account per organization+marketplace, preserve it.

==================================================
5. UX COPY
==================================================

Avoid awkward display like:

Trendyol · Trendyol · 696196

Prefer something concise such as:

Trendyol · 696196

or if a safe display name exists:

Trendyol · ABC Mağaza
Seller ID: 696196

Do not invent a store name from data that does not exist.

If only sellerId exists, display sellerId clearly.

==================================================
6. SAFETY / NON-GOALS
==================================================

Do NOT:

- add multi-Trendyol support
- add multi-account activation
- change scheduler behavior
- enable provider writes
- change shipment creation logic
- change shipping payer derivation semantics
- change carrier routing rules except hiding inactive Trendyol choices
- delete marketplace account DB rows
- migrate historical orders
- rewrite marketplaceAccountId on old data
- call live Trendyol APIs
- call production provider APIs
- add a DB migration unless technically unavoidable; expected NO migration

Preserve:
- tenant scoping
- explicit carrier mapping
- UNKNOWN payer blocks create
- duplicate/idempotency protections
- encrypted credentials
- N11 blocker
- Aras live-write restrictions
- UNKNOWN_AFTER_NETWORK protections

Never touch/retry the known ambiguous production shipment.

==================================================
7. TESTS
==================================================

Add focused regression tests.

A. shipping payer
Given:
- Trendyol account A inactive
- Trendyol account B active

GET/view projection should expose only B.

Ensure:
- A still exists in persistence fixture/source
- it is simply excluded from current customer-facing payer view

B. same seller id idempotency
Connecting/resolving same Trendyol sellerId must not create duplicate account rows.

C. account replacement
Connecting a different sellerId:
- old account becomes inactive
- new account active
- only new account appears in current customer-facing integration/settings view
- old historical account remains stored

D. historical safety
Historical order tied to old marketplaceAccountId must remain readable / unchanged.

E. carrier mapping
Inactive historical Trendyol account must not be offered as a new current mapping target.

F. UI
No duplicated visible current Trendyol rows when one active + one inactive historical record exists.

==================================================
8. VALIDATION
==================================================

Run at minimum:

npx tsc -b --force
npm run lint
npm run build
npm run test:ui
npm run test:integration-status
npm run test:billing-party
npm run test:carriers
npm run test:onboarding
npm run test:runtime-memory

Also run targeted new tests.

Then:
git diff --check

If new server/*.test.mjs files are added and the repository requires registration in:
server/testing/suratSuiteFiles.json

register them in the same change.

==================================================
9. DELIVERY
==================================================

Do NOT merge.
Do NOT deploy.

At completion provide:

1. branch
2. baseline SHA
3. final commit SHA
4. changed file list
5. exact surfaces where inactive Trendyol accounts were hidden
6. confirmation that old DB rows remain
7. confirmation historical orders are untouched
8. confirmation only one active Trendyol remains supported
9. tests + pass counts
10. lint/build status
11. migration status
12. confirmation provider/scheduler behavior unchanged

Then STOP.