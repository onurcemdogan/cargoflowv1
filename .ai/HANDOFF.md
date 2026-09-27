# DevFactory handoff

Ticket: ARAS-EXPANSION
Branch: `agent/ARAS-EXPANSION`
Status: `READY_FOR_REVIEW` / `IMPLEMENTATION_COMPLETE`
HEAD: `45e44fb6d23048cbdb6e5e29dfa4e8ef9b55ceb9`
Spec: `.ai/tickets/ARAS-EXPANSION.md`
PR: https://github.com/onurcemdogan/cargoflowv1/pull/8

## Summary

`internal_test` Aras carrier path is implemented (SOAP transport, credentials, routing, health, UI, deterministic tests). Supervisor restart flagged **CI_FAILED**; this session reproduced the failing check, confirmed the fix on branch, and verified **GitHub DevFactory CI green** on current HEAD.

## CI failure (reproduced)

| Item | Detail |
|------|--------|
| Failed run | `36325213366` on `7f24048` (step: `npm run test:ui`) |
| Error | Testing Library: multiple `button` elements named **Ayarlar** (Surat + Aras carrier cards) |
| Fix commit | `3dfac8a` — Aras card primary label **Hesap Bağla**; `desiMultiplierSetting.dom.test.tsx` scopes Surat **Ayarlar** via `within(suratCard)` |
| Green run | `36325919805` on `45e44fb` — workflow **success** |

No additional product code changes were required in this session beyond state/handoff updates.

## Evidence

- `.ai/research/ARAS-EXPANSION/20260927T123508.646306Z-d4e2b02830054596b75c122f9c311ea5.json`

## Key implementation files

- `server/carriers/aras/*`, `server/connectors/aras/*`, `server/shipments/arasProvider.ts`, `trendyolShipmentEligibility.ts`
- `src/integrations/ArasSection.tsx`, `src/pages/IntegrationsPage.tsx`, `server/index.mjs`
- Tests: `carrier-aras-*.test.mjs`, `carrier-neutral-foundation-flow.test.mjs`

## Gates (cursor session 2026-09-27)

```bash
npx tsc -b --force          # ok
npm run lint                # 0 errors (6 pre-existing warnings)
npm run build               # ok
npm run test:ui             # 365/365 (CI regression target)
npm run test:aras           # 51/51
npm run test:connector-kernel
npm run test:integration-health
npm run test:dashboard
npm run test:label-editor:acceptance
npm run test:performance:acceptance
npm run test:auto-label:acceptance
npm run test:contract-packs
npm run test:subscription
npm run test:billing-party
npm run test:woocommerce
npm run test:print-platform
npm run test:onboarding
npm run test:landing
npm run test:ikas
npm run test:ticimax
npm run test:catalog
npm run test:product-tour
npm run test:surat          # 3269/3269 pass, exit 0 (this session)
```

## Required verdicts

| Verdict | Value |
|---------|-------|
| ARAS_CONTRACT | VERIFIED_PUBLIC_OFFICIAL_TEST_CONTRACT |
| ARAS_PRODUCTION_ENDPOINT | UNVERIFIED |
| ARAS_ACCOUNT_IDENTITY | LOCAL_MARKETPLACE_ACCOUNT_SCOPE |
| ARAS_SECRET_SAFETY | ENCRYPTED_AT_REST_NO_PLAINTEXT_API |
| ARAS_CONNECTION_TEST | NOT_LIVE_NETWORK (internal_test store only) |
| ARAS_MULTI_ACCOUNT | SIBLING_ISOLATED |
| ARAS_CARRIER_SELECTION_SEAM | EXPLICIT_CARGO_NAME_REQUIRED |
| ARAS_ORDER_CREATE | MOCK_PIPELINE_PROVEN |
| ARAS_VERIFICATION | GetOrderWithIntegrationCode_ONLY |
| ARAS_LABEL_ARTIFACT | GetBarcode → persist → reprint storage |
| ARAS_REPRINT_FROM_STORAGE | YES (no refetch) |
| ARAS_COD | FAIL_CLOSED_UNVERIFIED_VALUE_TABLE |
| ARAS_HEALTH_ACCOUNT_SCOPE | aras::marketplaceAccountId |
| ARAS_TENANT_ISOLATION | APPLICATION_SCOPED |
| ARAS_LIVE_WRITE_GATE | BLOCKED internal_test |
| ARAS_ROLLOUT | INTERNAL_TEST |
| MIGRATION | NONE (connector_credentials path) |
| LIVE_PROVIDER_VERIFICATION | NOT_PERFORMED |
| PILOT_READY | NO |
| ARAS_EXPANSION | READY_FOR_REVIEW |

## Next action

Review PR #8; do not push/merge protected branches. After approval, supervisor merges to `integration/roadmap`.
