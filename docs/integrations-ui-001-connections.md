# INTEGRATIONS-UI-001 — delivery report

Implemented on `feat/integrations-ui-001-standardize-connections` from current
master after PR #21, `891e8f9ef83e47cef56aa14bcf2e72780a55fb7d`.
Local delivery commit is branch HEAD (`git rev-parse HEAD`). No push or deployment.
Independent different-model review: gpt-6-astra, APPROVED.

## Shared presentation

`src/integrations/IntegrationConnection.tsx` introduces five pure components:

- `IntegrationConnectionCard`: provider name/kind, description, badges and focusable management surface.
- `IntegrationAccountCard`: account heading, state, metadata, actions and provider-specific content.
- `IntegrationFormSection`: grouped fields with a heading and helper text.
- `IntegrationFormActions`: wrapping action row.
- `IntegrationLoading`: existing skeleton/status presentation.

They contain no IO, verification rules or capability decisions. Existing Card,
Badge, Alert, Field, `ui-btn` and CSS variables define the appearance. Shared CSS
supports long identifiers, masks and paths, wrapping buttons and mobile category
tabs. Forms and metadata collapse to one column on narrow screens.

## Provider structure before/after

| Surface | Before | Delivered structure and retained constraints |
| --- | --- | --- |
| Hepsiburada | Raw section/list/fields | Shared provider and account cards, primary MerchantID/username/password group, expandable host/packagesPath/ordersPath/listField group. SIT/Production and AccountReadStatus retained. Unknown paths remain empty and fail closed; existing test/sync/edit/disconnect gates retained. |
| n11 | Separate section/list/form styling | Same cards/form/actions; configured and verified states remain distinct. Compact expandable warning states `N11_EPOCH_SEMANTICS_UNVERIFIED · BLOCKED_EXTERNAL`; writes/labels/fulfillment remain closed. No seller identity invented. |
| WooCommerce | Separate account list and wizard presentation | Shared provider/account hierarchy; OAuth connect is the primary action and manual REST is expandable secondary content. Existing six-step flow, return handling, configured/verified distinction and disconnect preserved. |
| ikas | Raw connection section/form | Shared shell/account/form with visible internal_test state. Existing read test, connect, secret handling and disconnect preserved. Connected account does not imply verified capability. |
| Aras | Raw carrier section/form | Shared carrier/account/form with internal_test and production-unavailable status. Existing explicit credential save only; no dummy shipment/live verification introduced. Form is outside the general settings form to avoid unrelated submit actions. |
| Carrier accounts | Separate raw settings table | Current-theme card with account facts, masked references and verification states; existing routing selects, filters and PUT handler unchanged. |
| Shipping payer | Separate raw row/table styling | Current-theme card, fields, badges and alerts. Order-derived Trendyol payer stays locked; shipping payer explicitly remains distinct from subscription. Existing POST/reload unchanged. |
| AccountReadStatus | Distinct visual badge classes | Existing current-theme status badges; exact configured/verified/read-capability predicates unchanged. |
| Trendyol / Sürat | Existing structured cards/settings | Existing business behavior retained. Management panels gain focus targets for status-board navigation. |

The existing status board remains the overview. Clicking any of its seven
providers selects the existing category/detail state, then scrolls and focuses
the actual provider management surface. No duplicate health logic or status board
was added.

## Behavior preservation

No backend runtime, provider endpoints/contracts, encryption, tenant isolation,
account verification, OAuth return logic, schedulers, shipment/label creation or
rollout/read/write gates changed. No migrations. N11 epoch semantics and its
external checkpoint block are unchanged; HB durability and Aras live-write policy
are unchanged.

A TypeScript-parser comparison checked each component's business statements
before its first loading/UI return against baseline. All seven provider/settings
modules have byte-identical business statement source: HB, n11, Woo, ikas, Aras,
carrier accounts and shipping payer. UI rendering, form hierarchy and board
focus changed. Existing explicit action callbacks remain authoritative.

Panel opening still reads existing persisted metadata only. DOM coverage asserts
GET-only navigation with no sync/write callback, blank secret fields and accurate
capability/status presentation. Aras explicit-save coverage asserts the existing
endpoint/payload. Existing provider suites cover their action contracts.

No production access or provider API calls were performed during implementation
or preview. Synthetic fixtures are not provider or production-readiness evidence.

## Verification results

All commands below exited successfully. Counts for composite suites separate
backend and UI assertions; overlapping suites are not additive coverage totals.

| Command | Result |
| --- | --- |
| `npm run test:ui` | 442 tests, 46 files |
| `npm run test:integration-health` | 53 backend tests |
| `npm run test:onboarding` | 22 backend + 13 UI tests |
| `npm run test:hepsiburada` | 23 backend + 4 UI tests |
| `npm run test:n11` | 78 backend + 5 UI tests |
| `npm run test:woocommerce` | 105 backend + 5 UI tests |
| `npm run test:ikas` | 32 backend + 3 UI tests |
| `npm run test:aras` | 95 backend tests |
| `npm run test:product-ia` | 12 backend tests |
| `npm run test:integration-status` | 9 backend + 8 UI tests |
| `npm run test:carriers` | 16 backend + 3 UI tests |
| `npm run test:billing-party` | 43 backend tests |
| `node --test server/integrations-ui-presentation-flow.test.mjs` | 2 presentation/CSS tests |
| Targeted `integrationConnections.dom.test.tsx` | 11 DOM tests, also included in full UI run |
| `npx tsc -b --force` | Passed |
| `npm run lint` | 0 errors; 6 pre-existing unused-disable warnings in Sürat files |
| `npm run build` | Passed |
| `git diff --check` | Passed |

New coverage checks shared shell/forms, GET-only board navigation for all seven
providers, Trendyol/Sürat callbacks, configured != verified, internal_test status,
empty secrets, unknown HB paths, N11 checkpoint warning, Aras restrictions,
explicit Aras save, light/dark token usage and responsive wrapping.

## Synthetic visual evidence

A temporary local harness rendered the real AppShell and IntegrationsPage with
synthetic account/status metadata and a fetch stub rejecting unapproved requests.
It covered desktop light/dark, 1024px and 375px mobile widths, long identifiers,
verified/unverified states and provider warnings. Mobile document width and
scroll width both measured 375px after the category-tab wrapping fix; no overflow
elements remained. Desktop also had no horizontal page overflow.

Screenshots are conversation artifacts under
`outputs/integrations-ui-001`, outside the repository:
`hepsiburada-light.jpg`, `n11-light.jpg`, `n11-mobile-dark.jpg`,
`woocommerce-dark.jpg`, `woocommerce-mobile-dark.jpg`, `aras-dark.jpg`.
The temporary harness files, local server and agent-created browser tab were
removed after verification. No actual account secrets or customer payloads were
used or captured.

## Changed files

| File | Purpose |
| --- | --- |
| `src/integrations/IntegrationConnection.tsx` | Shared pure presentation components |
| `src/integrations/HepsiburadaSection.tsx` | HB card/account/form presentation |
| `src/integrations/N11Section.tsx` | n11 presentation and accurate blocker visibility |
| `src/integrations/WooCommerceSection.tsx` | Woo card/account/OAuth hierarchy |
| `src/integrations/IkasSection.tsx` | ikas card/account/form presentation |
| `src/integrations/ArasSection.tsx` | Aras carrier/account/form presentation |
| `src/integrations/CarrierAccountsSection.tsx` | Separate carrier-routing settings presentation |
| `src/integrations/ShippingPayerSection.tsx` | Separate payer settings presentation |
| `src/integrations/AccountReadStatus.tsx` | Existing status semantics in current-theme badges |
| `src/pages/IntegrationsPage.tsx` | Provider management focus and Aras form boundary |
| `src/index.css` | Shared token-based styles and responsive wrapping |
| `src/test/integrationConnections.dom.test.tsx` | Provider/navigation/secret/status regression coverage |
| `server/integrations-ui-presentation-flow.test.mjs` | Pure-shell and theme/responsive checks |
| `.ai/CURRENT_TASK.json` | Current task, gates and constraints |
| `.ai/CURRENT_CONTEXT.md` | Current context and historical task state |
| `.ai/HANDOFF.md` | Delivery handoff |
| `.ai/tickets/INTEGRATIONS-UI-001.md` | Active ticket and result |
| `docs/integrations-ui-001-connections.md` | This delivery report |
