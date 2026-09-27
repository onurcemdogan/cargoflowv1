# DevFactory handoff

Ticket: ARAS-EXPANSION
Branch: `agent/ARAS-EXPANSION`
Status: `BLOCKED_HUMAN` (set this session; was `IN_PROGRESS`/`READY`)
Spec: `.ai/tickets/ARAS-EXPANSION.md`

## Exact state

Baseline: `7754fcb109c4d8990d97065710e1189121fb58b7`
HEAD before this session's commit: `8cffdf71600f2a81acfc6fc1d6a33a62d4f258da`

This session added (uncommitted at time of writing this file; will be
committed to `agent/ARAS-EXPANSION` and pushed, not merged):

- `server/carriers/aras/arasClient.ts` — real (test-endpoint-only) SOAP
  transport for `SetOrder` (fully wire-proven), plus deliberate fail-closed
  stubs for `GetOrderWithIntegrationCode`/`GetBarcode` (wire contract not
  provable this session — see blockers below). No credential/account
  storage, no identity, no UI, no migration, no provider-registry flip.
- `server/carrier-aras-client-flow.test.mjs` — 14 new tests, all passing,
  `REAL_CARRIER_NETWORK=1` guarded, no live network.
- `npm run test:aras` gate (package.json + `.ai/QUALITY_GATES.md`).
- `docs/cargoflow-roadmap/P5_AUDIT.md` — new dated section
  "ARAS-EXPANSION — KİMLİK KAPISI + TAŞIMA KATMANI (2026-09-27)" recording
  both blockers and what was/wasn't done, with reasoning.
- `.ai/CURRENT_TASK.json` — status `BLOCKED_HUMAN`, full completed/blocked
  lists.

## Why blocked (two independent, genuine gaps — not assumptions)

1. **ARAS_ACCOUNT_IDENTITY** (ticket's mandatory identity gate, mirrors
   `TICIMAX-001`'s `UyeKodu` rejection): no stable, provider-native,
   non-secret Aras account identity exists in current contract evidence.
   `UserName`/`Password` are credentials by the pure layer's own
   `SECRET_FIELDS`. `OrgReceiverCustId` is the shipment *receiver's*
   identity, not the sending account's. `SenderAccountAddressId` is an
   unexplained field name only — existence is not proof of stable
   semantics (same existence-vs-value-table distinction the pure layer
   already applies to COD fields). Aras's single shared TEST endpoint
   (unlike Ticimax/WooCommerce's per-merchant store URL) rules out the
   store-origin-as-identity pattern used for those connectors. Per ticket
   acceptance criterion 3 / stop condition 3: no credential/account
   persistence code was written.
2. **Verification/label wire-contract gap**: `GetOrderWithIntegrationCode`
   and `GetBarcode`'s exact SOAP request envelope (parameter wrapper,
   exact field casing) is not proven anywhere in the repo — only
   `SetOrder` has a test-locked envelope builder
   (`buildArasSetOrderEnvelope`). I attempted to close this by fetching
   the official WSDL via the `WebFetch` tool; the permission dialog for
   that tool call was not approved in this (non-interactive) session, so
   the fetch never ran. I did not retry or guess a substitute shape.

## Last commands run (all green)

```
npm run test:aras               # 39/39 (25 existing + 14 new)
npx tsc -b --force               # clean
npm run lint                     # 0 errors (6 pre-existing unrelated warnings)
npm run build                    # clean
npm run test:connector-kernel    # 15/15
npm run test:integration-health  # 53/53
npm run test:surat               # long-running; launched in background, confirm before relying on it
```

## Next concrete action for whoever resumes

1. A human must resolve blocker 1: either produce an official, non-secret,
   stable Aras account identifier (from Aras's own integration/onboarding
   material or support channel) and record the decision in
   `.ai/DECISIONS.md`, or explicitly accept and document an alternative
   (this agent cannot make that call itself — that is the point of the
   gate).
2. A human must resolve blocker 2: grant `WebFetch` permission in a future
   session so the official WSDL can be fetched and cited, or supply a real
   captured `GetOrderWithIntegrationCode`/`GetBarcode` request+response
   pair.
3. Only then should ticket items 2–8 (credential storage, identity
   persistence, carrier-selection seam, Integration Health, UI, migration,
   `providerRegistry.ts` `aras.enabled` flip, `CN-5`/`CN-6`/`CN-7`
   rewrites) proceed.
4. Do not start `LIVE-PROVIDER-VERIFICATION`. Do not merge to
   `integration/roadmap`. Do not push to `master`/`main`/`production`.
