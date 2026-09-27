# DevFactory handoff

Ticket: ARAS-EXPANSION
Branch: `agent/ARAS-EXPANSION`
Status: `MERGE_READY`
HEAD: `8b0cdd70c0b735de25f7c569857ed3b2a2324a06`
Spec: `.ai/tickets/ARAS-EXPANSION.md`
PR: https://github.com/onurcemdogan/cargoflowv1/pull/8

## Codex merge-control finding CODEX-MERGE-61123b9a11e6de29 (repaired, no code change needed)

Codex's merge-control gate rejected merge citing `drizzle/meta/0014_snapshot.json` as truncated (`riskEvidenceComplete: false`), evaluated against a stale frozen-head reference (`45e44fb`, the pre-remediation checkpoint). That commit genuinely predates the file: `git show 45e44fb:drizzle/meta/0014_snapshot.json` returns "does not exist". The prior remediation round (fingerprint `CODEX-MERGE-88024a2f97499c26`, fixed by claude) had already added the complete migration (`drizzle/0014_dark_leader.sql`, `drizzle/meta/0014_snapshot.json`, `drizzle/meta/_journal.json`) as part of fixing the persisted-artifact/timeout defects, committed at `cd84632` and already pushed to origin.

Verified at origin/PR head `8b0cdd7` (`gh pr view 8` headRefOid == `git rev-parse origin/agent/ARAS-EXPANSION`):
- `drizzle/meta/0014_snapshot.json` is 91245 bytes, parses as valid JSON, not truncated (same blob since migration commit `cd84632`; no drizzle diff on later wip checkpoints).
- `npm run db:check` (drizzle-kit check) reports no drift across the migration chain.
- Stale Codex frozen-head `45e44fb` still has no `drizzle/meta/0014_snapshot.json` in git — that is why automated review reported `riskEvidenceComplete: false`.

**Cursor session (2026-09-27):** Completed claude's TRANSIENT_ERROR repair path — no product/source changes; updated `.ai/CURRENT_TASK.json`, `.ai/CURRENT_CONTEXT.md`, this handoff.

**Next action for supervisor:** request a fresh Codex merge decision against `headCommit 8b0cdd70c0b735de25f7c569857ed3b2a2324a06` (not `45e44fb`) so the merge-control gate re-evaluates the current, complete evidence.

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
