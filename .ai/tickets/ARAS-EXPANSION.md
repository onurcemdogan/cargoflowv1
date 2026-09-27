# ARAS-EXPANSION — Wire the verified Aras Kargo contract layer into a live (internal_test) carrier

Rollout: `internal_test`
Production deploy: FORBIDDEN
Live carrier network calls in tests: FORBIDDEN (`REAL_CARRIER_NETWORK=1` fails closed, matching `carrier-aras-contract-flow.test.mjs`)

## Baseline state (proven in-tree; do not re-derive from chat)

- Pure decision layer already exists and is test-locked:
  `server/carriers/aras/arasContract.ts`, `arasSetOrder.ts`,
  `arasVerification.ts`, `arasLabelArtifact.ts` — 25/25 in
  `server/carrier-aras-contract-flow.test.mjs`. No network code anywhere in
  this layer.
- Contract evidence source: `docs/cargoflow-roadmap/P5_AUDIT.md`, verified
  2026-08-19 against Aras Kargo's official **public TEST** SOAP service
  (`customerservicestest.araskargo.com.tr/arascargoservice/arascargoservice.asmx`).
  `external_contract_status = VERIFIED_PUBLIC_OFFICIAL_TEST_CONTRACT`.
  `production_endpoint_status = UNVERIFIED` — no production URL exists in
  the repo and none may be derived from the test URL (no documented
  transformation rule; see `arasContract.ts` header).
- `CodCollectionType` / `CodBillingType` / `PayorTypeCode` value tables are
  **not verified**. COD shipments fail closed
  (`ARAS_COD_VALUE_TABLE_UNVERIFIED`) unless a caller injects externally
  verified numeric values. This ticket does not change that; do not invent
  the value table.
- `SetOrder` `ResultCode` meanings beyond `"0"` are undocumented; only `"0"`
  is treated as success. Do not invent a code table.
- Carrier-neutral foundation is measured and locked in
  `server/carrier-neutral-foundation-flow.test.mjs` (`CN-1`..`CN-7`):
  - `CN-5` currently asserts Aras is the only registry entry with
    `enabled: false` and Sürat is the only `enabled: true` carrier
    (`src/dashboard/providerRegistry.ts`).
  - `CN-6` currently **locks** the fact that an empty `cargoProviderName`
    defaults to Sürat, and its own comment says this must be revisited once
    a second carrier goes live, because an empty name would otherwise route
    to the wrong carrier.
  - `CN-7` currently **forbids** any `aras...Client/Adapter/Endpoint/Soap/Rest/Wsdl`
    identifier from existing anywhere in `server/index.mjs` or
    `src/utils/suratCreatePrintPlan.ts`, because at the time it was written
    no wire contract existed. That precondition is now satisfied for the
    TEST environment (see above). Retiring/rewriting `CN-7` to match the new,
    proven boundary is **in scope** and is not "weakening a test for green"
    under `AGENTS.md` — it is updating a guard whose own stated precondition
    has changed, the same way `CN-6` documents its own future obsolescence.
  - `integration_credentials.provider` CHECK allowlist is currently
    `('trendyol', 'surat', 'hepsiburada', 'n11')` (`drizzle/0008_marketplace_provider_allowlist.sql`,
    confirmed current in `drizzle/meta/0013_snapshot.json`). It does not
    contain `aras`.
- `.ai/DECISIONS.md`: "internal_test/shadow cannot mutate live fulfillment"
  is durable and applies here exactly as it did for Sürat/ikas/WooCommerce.

## Goal

Turn the existing, contract-verified, network-free Aras decision layer into
an actually usable **internal_test** carrier path: a real (test-endpoint-only)
SOAP client, account-scoped encrypted credential storage, a carrier-selection
seam that can route a shipment to Aras instead of assuming Sürat, Integration
Health wiring, and deterministic create/verify/label/reprint flows — all
gated so that no live production shipment, label, or money movement can occur
as a side effect of this work.

This ticket does **not** re-derive the wire contract from scratch. It
consumes the contract already proven in `server/carriers/aras/*` and
`docs/cargoflow-roadmap/P5_AUDIT.md`. If any additional field, endpoint,
status code, or value table is needed beyond what those files already prove,
that gap is a stop condition (see below), not something to fill in by
inference.

## In scope

1. **Aras SOAP transport client** (test endpoint only)
   - New module (e.g. `server/shipments/arasSoapClient.ts` or
     `server/carriers/aras/arasClient.ts` — follow the existing
     `suratWebApiClient.ts` / `suratSoapPrimaryCreate.ts` split pattern
     already in `server/shipments/`) that:
     - calls only `ARAS_TEST_ENDPOINT` from `arasContract.ts` unless a
       production URL has been explicitly configured through
       `resolveArasEndpoint`, per existing fail-closed behavior;
     - sends the envelope built by `buildArasSetOrderEnvelope`
       byte-for-byte (no ad hoc reconstruction of the SOAP body in the
       client);
     - calls `GetOrderWithIntegrationCode` for verification (per
       `ARAS_VERIFICATION_OPERATION`) and no other read endpoint, matching
       the single-correlation-key rule already documented in
       `arasVerification.ts`;
     - calls `GetBarcode` for label retrieval only after a
       `VERIFIED_REGISTERED` (or `CREATE_SUBMITTED`, if that is the proven
       precondition for label issuance — verify from contract evidence
       before assuming) state, and hands the raw response to
       `resolveArasLabelArtifacts` unchanged;
     - never re-fetches from the carrier to satisfy a reprint — reprint
       must go through `resolveArasReprintArtifact` against a persisted
       artifact, exactly as documented in `arasLabelArtifact.ts`;
     - classifies transport failures (timeout, non-2xx, SOAP fault,
       malformed XML) as `ARAS_TRANSPORT_UNKNOWN`/equivalent — never as a
       synthesized success and never as `VERIFIED_REGISTERED`.
   - No new fields are added to the SOAP body beyond
     `ARAS_SET_ORDER_FIELDS`. If the client needs a field not in that list,
     that is a stop condition, not a place to extend the whitelist from
     assumption.

2. **Account-scoped encrypted credential storage**
   - Reuse the existing account-scoped credential infrastructure used by
     ikas/WooCommerce/Ticimax (`server/connectors/connectorCredentialStore.ts`
     and friends), or the carrier-side equivalent used for Sürat
     (`server/shipments/suratCredentialSnapshot.ts`,
     `server/integrations/activeSuratIntegration.ts`) — pick whichever this
     repo's kernel treats carriers as (inspect both before deciding; do not
     assume carriers and marketplace connectors share one table without
     verifying schema and existing usage first).
   - `UserName`/`Password` (Aras Basic-style credential pair; see
     `arasSetOrder.ts` `SECRET_FIELDS`) must be encrypted at rest, never
     logged, never returned plaintext to any API response, and never appear
     in the redacted/audit view (`redactedOrder`) — this is already true in
     the pure layer; the storage layer must not regress it.
   - Extend whichever provider allowlist actually gates persistence
     (confirm exact location/constraint before writing a migration —
     `integration_credentials_provider_check` is one candidate but may not
     be the correct table for carriers; verify against how `surat` credentials
     are currently persisted, since Aras is carrier-shaped, not
     marketplace-connector-shaped).
   - New Drizzle migration only if the inspected schema actually requires
     it, using the next sequential number in `drizzle/` (currently after
     `0013_woocommerce_connector.sql` — confirm the true next number at
     implementation time, do not hardcode a number now) and following the
     existing migration comment style (see `0008_marketplace_provider_allowlist.sql`
     for precedent of loosening a CHECK constraint safely).

3. **Carrier identity / account model**
   - Establish account-scoped Aras identity following the same discipline
     as `TICIMAX-001`'s identity gate: prove a stable, provider-native Aras
     account/customer identity from the verified contract before persisting
     it as canonical. `UserName` is a credential, not an identity, by the
     same reasoning `UyeKodu` was rejected for Ticimax — do not use
     `UserName`, `Password`, or any hash of them as account identity.
   - If no stable provider-native identity field is provable from the
     current contract evidence, set `CURRENT_TASK.status = BLOCKED_HUMAN`
     and stop before credential/account persistence, exactly as
     `TICIMAX-001.md` requires for its own identity gate.
   - Multiple Aras accounts (sibling stores/organizations) must never bleed
     credentials, sync state, or shipment data across each other, per
     `PROJECT_SPEC.md`'s "account-scoped providers never bleed" principle.

4. **Carrier-selection seam**
   - Introduce a real "which carrier handles this shipment" decision point
     that Sürat's create path currently lacks (`P5_AUDIT.md` §2.3: "Create
     dispatch'i ... yalnız Sürat servis modlarını tanır; taşıyıcı seçen bir
     katman YOKTUR"). This must not be a Sürat-shaped adapter interface
     inferred without a second real implementation to validate it against —
     it now has one (Aras), so building the seam is appropriate, but keep it
     minimal: route by proven carrier identity (e.g. `cargoProviderName` /
     `carrierProviderRegistry` key), not by guessed heuristics.
   - Update `src/dashboard/providerRegistry.ts` `aras.enabled` to `true`
     only when the internal_test path is otherwise complete; flipping this
     flag is what turns `CN-5` from red to a new, intentionally-updated
     assertion (Sürat + Aras both enabled) — treat that test change as a
     deliberate, reviewed rewrite, not a silent weakening.
   - Resolve `CN-6`'s documented open question deliberately: with Aras live,
     decide and implement what happens when `cargoProviderName` is empty
     (must not silently default to Sürat's create path once ambiguity has a
     real cost). Record the decision in `.ai/DECISIONS.md` once made — this
     ticket does not get to leave that ambiguous.
   - `suratAssigned !== false`-style foreign-carrier exclusion in
     `server/shipments/trendyolShipmentEligibility.ts` must keep blocking
     Aras shipments from Sürat's create path, and a new equivalent gate must
     block Sürat shipments from entering the Aras path. Ownership must stay
     mutually exclusive per shipment.

5. **Order creation, verification, labeling, reprint (internal_test only)**
   - Wire `buildArasSetOrder` → SOAP client → `classifyArasSetOrderResult`
     → `startArasVerification`/`applyArasVerificationLookup` →
     `resolveArasLabelArtifacts` → persistence, using existing
     idempotency/fingerprint plumbing
     (`server/shipments/suratIdempotencySemantics.ts`'s
     `compareCreateSemantics`, already proven reusable for Aras in
     `AR-11`) and `buildArasIntegrationCode` for the correlation key.
   - Persist label artifacts immutably once obtained; reprint reads only
     the persisted artifact (`resolveArasReprintArtifact`), never the
     carrier, per `PROJECT_SPEC.md`.
   - COD shipments remain fail-closed end-to-end unless a caller supplies
     externally verified `verifiedCollectionType`/`verifiedBillingType` —
     do not add a default value table anywhere in the wiring layer.

6. **Integration Health**
   - Extend `server/connectors/integrationHealthService.ts` account-scoped
     health to Aras, following the `ikas::<marketplaceAccountId>` keying
     precedent from `IKAS-001.md`. Sibling Aras accounts must be isolated in
     health state; `NEVER_RUN` must carry a real account identifier, not a
     placeholder.

7. **UI**
   - Extend the existing carrier/Integrations UI surface (wherever Sürat's
     carrier credentials are currently configured) to allow connecting an
     Aras account: username/password fields, truthful `internal_test`
     status, never re-displaying stored secrets in plaintext.

8. **Rollout gating**
   - At most `internal_test`. Reuse
     `stageAffectsLiveBehavior`/equivalent rollout-stage gating already
     proven for ikas/WooCommerce/Ticimax — do not invent Aras-specific
     rollout special-casing.
   - No internal_test Aras read/create may trigger a real production
     shipment, label print, or billing side effect. No internal_test flag
     may silently become `pilot`/`ga`.

## Out of scope

- Deriving or guessing the Aras **production** endpoint, credentials, or
  any production fact. `ARAS_PRODUCTION_ENDPOINT_UNVERIFIED` stays the
  default outcome unless a human supplies a verified production URL through
  configuration (not code).
- Deriving or guessing the `CodCollectionType`/`CodBillingType`/
  `PayorTypeCode` value table. COD stays fail-closed for unverified values.
- Deriving or guessing undocumented `ResultCode` meanings beyond `"0"` =
  success.
- Any live network call to Aras from an automated test
  (`REAL_CARRIER_NETWORK=1` stays a hard stop in
  `carrier-aras-contract-flow.test.mjs`; extend the same guard to any new
  Aras test file that touches the transport layer).
- Real carrier create against the live/test Aras service performed by an
  agent outside an explicit, human-approved verification step (that step is
  `LIVE-PROVIDER-VERIFICATION` in the roadmap, not this ticket).
- Pilot or GA rollout, or any change to `PRODUCTION-ROLLOUT`/
  `PRODUCTION-READINESS` gating.
- Rewriting Sürat's carrier-specific idempotency/state-machine internals
  (candidate tracking number/barcode, tesellüm, `FAILED_SAFE`) to "share"
  logic with Aras. `P5_AUDIT.md` §2.4 already rejected a premature shared
  adapter interface; keep Aras's state machine (`ARAS_VERIFICATION_STATES`)
  its own, as it already is.
- Any change to `TICIMAX-001` or `IKAS-001` scope, branches, or state.
- Deploy, push to `master`/`main`/`production`, or merge to
  `integration/roadmap`.

## Required repository areas to inspect before writing code

- `server/carriers/aras/*.ts` and `server/carrier-aras-contract-flow.test.mjs`
  — the entire existing pure contract layer; do not re-derive shapes already
  proven here.
- `server/carrier-neutral-foundation-flow.test.mjs` and
  `docs/cargoflow-roadmap/P5_AUDIT.md` — the exact boundary this ticket is
  allowed to cross, and why `CN-6`/`CN-7` are written the way they are.
- `src/dashboard/providerRegistry.ts` — carrier registry shape and current
  `enabled: false` entries for Aras/MNG/PTT/UPS/DHL/Yurtiçi.
- `server/shipments/trendyolShipmentEligibility.ts`,
  `src/utils/suratCreatePrintPlan.ts`, `src/App.tsx` — the shared foreign-
  carrier exclusion predicate and empty-`cargoProviderName` default that
  must be extended/revisited, not duplicated.
- `server/shipments/suratWebApiClient.ts`, `suratSoapPrimaryCreate.ts`,
  `suratCanonicalCreateAdapter.ts`, `suratRegistrationVerification.ts`,
  `suratIdempotencySemantics.ts`, `suratCredentialSnapshot.ts`,
  `suratPrintableArtifact.ts` — the proven transport/verification/label/
  idempotency pattern to mirror structurally for Aras (mirror the pattern,
  not the Sürat-specific field names or state values).
- `server/integrations/activeSuratIntegration.ts`,
  `server/connectors/connectorCredentialStore.ts`,
  `server/connectors/integrationHealthService.ts`,
  `server/connectors/connectorKernel.ts` — decide which credential/health
  path Aras actually belongs to (carrier-shaped vs connector-shaped) before
  writing storage code.
- `server/db/schema.ts`, `drizzle/0008_marketplace_provider_allowlist.sql`,
  `drizzle/meta/0013_snapshot.json` — current provider allowlist reality;
  confirm before assuming which CHECK constraint (if any) actually needs
  `aras` added.
- `.ai/tickets/TICIMAX-001.md` and `.ai/tickets/IKAS-001.md` — formatting
  and rigor precedent for this ticket type (identity gate, mutation
  minimum, required verdicts, gates section).
- `.ai/QUALITY_GATES.md`, `.ai/ACCEPTED_FOUNDATION.md`,
  `.ai/DECISIONS.md`, `.ai/KNOWN_NON_SOLUTIONS.md` — durable rules this
  ticket must not violate.

## Acceptance criteria

1. A real (test-endpoint-only) Aras SOAP client exists, is reachable only
   through `resolveArasEndpoint`'s resolution, and sends only the envelope
   shape already proven in `arasSetOrder.ts`.
2. Aras account credentials are encrypted at rest, never logged, never
   returned plaintext, and scoped per account with proven sibling isolation.
3. A stable, provider-native Aras account identity is used as
   `providerAccountId`; `UserName`/`Password`/hashes of them are never used
   as identity. If this cannot be proven from current contract evidence,
   `CURRENT_TASK.status = BLOCKED_HUMAN` and no identity/credential
   persistence code is written.
4. A shipment can be routed to Aras instead of Sürat through a real
   carrier-selection seam; Sürat's create path provably still rejects
   Aras-owned shipments (existing `CN-3`-style guarantee) and a new
   equivalent guarantee exists in the other direction.
5. Order create → verification → label retrieval → immutable persistence →
   reprint-from-storage works end-to-end against the **test** endpoint only,
   entirely behind `internal_test` rollout, with zero path by which this can
   trigger a live production Aras shipment or a Sürat side effect.
6. COD shipments remain fail-closed without verified value tables; no value
   table is invented anywhere in the new code.
7. `ResultCode` values other than `"0"` are never treated as success
   anywhere in the new wiring; raw code/message are preserved end-to-end
   into whatever is persisted/surfaced.
8. Integration Health reports real, account-scoped Aras status with correct
   sibling isolation.
9. `CN-5`, `CN-6`, `CN-7` are each either still passing unchanged, or
   deliberately rewritten with a comment explaining exactly which proven
   precondition changed (registry enablement, carrier-selection seam
   existing, wire contract now proven) — never silently deleted or loosened
   without that explanation.
10. No file outside this ticket's stated scope is modified for unrelated
    reasons (no drive-by refactors of Sürat internals).

## Deterministic local tests / quality gates

Add a focused gate, e.g. `test:aras` (or extend the existing
`carrier-aras-contract-flow.test.mjs` suite in place, matching the
`test:surat`/`test:ikas` precedent in `.ai/QUALITY_GATES.md`), covering at
minimum:

1. Transport client sends exactly the envelope `buildArasSetOrderEnvelope`
   produces — no field added/renamed in the wire layer.
2. Transport client never calls a URL other than the one
   `resolveArasEndpoint` returned for the active environment.
3. Any SOAP fault / non-2xx / malformed XML / timeout classifies as
   unknown/failed, never as `VERIFIED_REGISTERED` or a successful
   `SetOrder`.
4. `GetOrderWithIntegrationCode` is the only read endpoint called for
   verification (mirror `AR-24`'s intent against the real client, not just
   the pure constant).
5. Credentials are encrypted in the persisted row; a raw DB read never
   yields plaintext `UserName`/`Password`.
6. `UserName`/hash-of-`UserName` used as `providerAccountId` fails a test
   the same way Ticimax's `UyeKodu`-as-identity test fails
   (`TICIMAX-001.md` test #1 precedent).
7. Tenant isolation: organization A cannot read/use organization B's Aras
   credentials or shipments.
8. Sibling Aras account isolation: two Aras accounts in the same
   organization never share credential/health/shipment state.
9. A shipment already owned by Aras is provably rejected by Sürat's create
   path, and vice versa.
10. `internal_test` rollout cannot trigger a live carrier create, label
    print, or billing write.
11. Rollout stage cannot silently advance past `internal_test`.
12. Reprint never re-calls `GetBarcode`; it only reads the persisted
    artifact, and fails closed (not by re-fetch) when no artifact is stored.
13. COD without verified value tables is rejected at every layer that
    touches it (repeat `AR-13`'s guarantee at the wiring layer, not just the
    pure layer).
14. `REAL_CARRIER_NETWORK=1` (or the project's real-network guard variable)
    makes every new Aras network-touching test file stop before any socket
    is opened, matching the existing guard at the top of
    `carrier-aras-contract-flow.test.mjs`.

Run the full gate list in `.ai/QUALITY_GATES.md` (adding the new Aras gate
to it) before marking the ticket `READY_FOR_REVIEW`:

```bash
npx tsc -b --force
npm run lint
npm run build
npm run test:aras   # new
npm run test:connector-kernel
npm run test:integration-health
npm run test:surat
```

No skip/todo/weakened assertions anywhere in the suite. Mutation proof
required for: identity-as-credential rejection, encrypted-secret storage,
tenant isolation, sibling-account isolation, checkpoint/rollout-stage
bypass, COD fail-closed, and reprint-without-refetch — mirroring
`IKAS-001.md`'s "mutation minimum" list.

## Provider-contract verification rules

- Every new wire-facing constant (endpoint, field name, operation name,
  response field) must trace to `server/carriers/aras/*.ts` or
  `docs/cargoflow-roadmap/P5_AUDIT.md`'s cited evidence. If a new field or
  endpoint is needed that is not already in `ARAS_SET_ORDER_FIELDS`,
  `ARAS_SET_ORDER_RESULT_FIELDS`, or the documented `GetBarcode`/
  `GetOrderWithIntegrationCode` shapes, treat it as unproven: do not add it
  from inference, memory, or generic SOAP-service conventions.
- If official documentation must be re-fetched to confirm a field exists
  (e.g. to determine the true precondition for calling `GetBarcode`),
  fetching and citing the same official source class already used
  (`customerservicestest.araskargo.com.tr` public documentation) is
  in scope; inventing the answer without fetching it is not.
- Do not derive the production endpoint from the test endpoint by pattern
  (no `-sit`/`test`-stripping heuristic) — `arasContract.ts`'s header
  explicitly rejects this because, unlike Hepsiburada, no official
  transformation rule is documented for Aras.
- Do not assume `ResultCode` semantics, COD value tables, or webhook/event
  contracts exist unless a proof artifact (doc excerpt, WSDL fragment, or
  captured real response under an approved verification step) is added
  alongside the code that depends on it.
- Any newly discovered contract fact must be recorded in
  `docs/cargoflow-roadmap/P5_AUDIT.md` (or a successor doc it points to)
  with source and verification date, following the existing entry's format,
  before code relies on it.

## Tenant isolation / secret handling requirements

- Organization-scoped: no cross-organization visibility of Aras
  credentials, shipments, health state, or labels.
- Account-scoped within an organization: sibling Aras accounts never share
  credentials, sync state, health state, or shipment ownership — same
  requirement `PROJECT_SPEC.md` states for all account-scoped providers.
- `UserName`/`Password` are encrypted at rest using the existing accepted
  encryption path (do not invent a new one); never logged; never returned
  plaintext in any API/UI response; never appear un-redacted in any
  audit/log view. This already holds in the pure layer's `redactedOrder`
  (`arasSetOrder.ts` `AR-6`) — the storage/API layer must preserve it.
  Also cover `TradingWaybillNumber`/`InvoiceNumber` handling only to the
  extent existing print/PII rules in `PROJECT_SPEC.md`/`KNOWN_NON_SOLUTIONS.md`
  already require (do not over-broaden secret handling to fields that are
  not credentials).
- No plaintext credential storage, no credentials in URL query strings
  (mirrors `TICIMAX-001.md`'s equivalent rule for `UyeKodu`).
- RLS is not present in this codebase (`.ai/ACCEPTED_FOUNDATION.md`); tenant
  isolation stays application-scoped — enforce it explicitly in every new
  query/lookup, do not rely on a database-level guarantee that doesn't
  exist.

## No production deploy or live write without an explicit later gate

- This ticket implements `internal_test` only. It must not flip, weaken, or
  bypass rollout-stage gating in any way that lets Aras behavior reach
  `pilot` or `ga` without a separate, explicit human decision.
- No code path introduced here may cause a real Aras shipment, a real
  label print against a real waybill, or any billing/financial write,
  under any rollout stage available in this ticket.
- Verifying behavior against the real (but still test-only) Aras SOAP
  service is allowed only if it uses the documented public **TEST**
  endpoint and test-safe data; anything that looks like it could register a
  real-world shipment against a real customer account is out of scope and
  belongs to the separate `LIVE-PROVIDER-VERIFICATION` roadmap item.
- Do not touch `PRODUCTION-ROLLOUT`, `PRODUCTION-READINESS`, or
  `PILOT-HARDENING` roadmap items or their gating logic.
- Do not push to `master`/`main`/`production`, force-push, or merge to
  `integration/roadmap`. Ticket branch is `agent/ARAS-EXPANSION`; commit and
  push that branch only, per `AGENTS.md`.

## Stop conditions

Use `BLOCKED_HUMAN` (not an assumption) whenever, and only whenever, one of
these is genuinely true:

1. **Missing external credentials**: no Aras TEST account
   (username/password) is available to exercise the client end-to-end.
   Pure-logic tests (already 25/25) and transport-layer unit tests using
   canned fixtures may still proceed without live credentials; only actual
   TEST-service calls require them.
2. **Missing live-provider evidence**: a required behavior (e.g. exact
   precondition for `GetBarcode`, real shape of a SOAP fault, real
   `ResultCode` values beyond `"0"`) cannot be confirmed from
   `server/carriers/aras/*`, `docs/cargoflow-roadmap/P5_AUDIT.md`, or a
   freshly fetched and cited official document. Stop and record the gap in
   `P5_AUDIT.md` rather than inferring the answer.
3. **Explicit approval required**: the carrier-native account identity
   field cannot be proven stable from current contract evidence (identity
   gate, mirrors `TICIMAX-001.md`); or a change would need to touch
   `PRODUCTION-ROLLOUT`/`PRODUCTION-READINESS`/`PILOT-HARDENING` scope; or a
   supervisor/human must approve moving past `internal_test`.

Do not use `BLOCKED_HUMAN` as a substitute for normal engineering work that
this ticket's existing evidence already supports (e.g. do not block on "no
WSDL" — the WSDL/contract evidence for `SetOrder`/`GetBarcode`/
`GetOrderWithIntegrationCode` already exists and is cited above).

## Required verdicts

Report explicitly, following the `TICIMAX-001.md`/`IKAS-001.md` pattern:

- ARAS_CONTRACT (= `VERIFIED_PUBLIC_OFFICIAL_TEST_CONTRACT`, carried over
  from `P5_AUDIT.md` unless re-verification changes it)
- ARAS_PRODUCTION_ENDPOINT (expected: `UNVERIFIED` unless a human supplies
  one)
- ARAS_ACCOUNT_IDENTITY
- ARAS_SECRET_SAFETY
- ARAS_CONNECTION_TEST
- ARAS_MULTI_ACCOUNT
- ARAS_CARRIER_SELECTION_SEAM
- ARAS_ORDER_CREATE
- ARAS_VERIFICATION
- ARAS_LABEL_ARTIFACT
- ARAS_REPRINT_FROM_STORAGE
- ARAS_COD=FAIL_CLOSED_UNVERIFIED_VALUE_TABLE
- ARAS_HEALTH_ACCOUNT_SCOPE
- ARAS_TENANT_ISOLATION
- ARAS_LIVE_WRITE_GATE
- ARAS_ROLLOUT=INTERNAL_TEST
- MIGRATION
- LIVE_PROVIDER_VERIFICATION=NOT_PERFORMED
- PILOT_READY=NO
- ARAS_EXPANSION

## Stopping / handoff

Before stopping normally, leave an exact handoff in `.ai/HANDOFF.md`
(current exact state, last command run, next concrete step) per
`CLAUDE.md`/`AGENTS.md`. Do not merge, deploy, or advance rollout past
`internal_test`. Do not start the next roadmap ticket
(`LIVE-PROVIDER-VERIFICATION`) from this one.
