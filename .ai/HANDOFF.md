# DevFactory handoff

Ticket: ARAS-EXPANSION
Branch: `agent/ARAS-EXPANSION`
Status: `READY_FOR_REVIEW` / `IMPLEMENTATION_COMPLETE`
Spec: `.ai/tickets/ARAS-EXPANSION.md`

## Summary

Resumed after research resolution for GetOrderWithIntegrationCode/GetBarcode SOAP literals. Implemented full `internal_test` Aras path: proven SOAP transport (SetOrder + verification + GetBarcode), encrypted account-scoped credentials (`connector_credentials`), carrier mutual exclusion with Surat, registry enablement, integration health presence, API + Integrations UI, and deterministic pipeline tests with mock transport.

## Evidence

- `.ai/research/ARAS-EXPANSION/20260927T123508.646306Z-d4e2b02830054596b75c122f9c311ea5.json`

## Key files

- `server/carriers/aras/arasClient.ts`, `arasSoapXml.ts`, `arasVerification.ts` (envelope), `arasLabelArtifact.ts` (GetBarcode envelope), `arasShipmentPipeline.ts`, `arasRollout.ts`
- `server/connectors/aras/*`, `server/shipments/arasProvider.ts`, `trendyolShipmentEligibility.ts` (CN-3/6)
- `src/integrations/ArasSection.tsx`, `src/pages/IntegrationsPage.tsx`, `server/index.mjs` (aras routes)
- Tests: `carrier-aras-client-flow.test.mjs`, `carrier-aras-expansion-flow.test.mjs`, `carrier-neutral-foundation-flow.test.mjs` (CN updates)

## Gates run (this session)

```bash
npx tsc -b --force
npm run lint          # 0 errors (6 pre-existing warnings)
npm run build
npm run test:aras     # 51/51
npm run test:connector-kernel  # 15/15
npm run test:integration-health # 53/53
node --test server/carrier-neutral-foundation-flow.test.mjs  # 7/7
npm run test:surat    # 3269/3269 pass, exit 0 (post CN-6 fixture + suite registry fixes)
```

## Surat gate follow-up (this session)

CN-6 left empty `cargoProviderName` non-Surat: updated auto-label/surat-flow fixtures with explicit Sürat carrier; added `server/testing/suratSuiteExclusions.json` + `suratSuiteRegistry.mjs` (Aras/Ticimax suites excluded from `test:surat` orphan checks); removed `carrier-aras-contract-flow.test.mjs` from `suratSuiteFiles.json`; SSC-6 slice widened for COMPLETE response assertion.

## Required verdicts (implementation)

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

Review on `agent/ARAS-EXPANSION`; confirm `npm run test:surat` green; no push to protected branches.
