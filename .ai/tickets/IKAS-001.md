# IKAS-001 — Account-scoped ikas connector

Baseline: `d1f25da`
Rollout target: `internal_test`
Deploy: forbidden

## Mission
Implement ikas using existing connector/account/credential/health infrastructure:
OAuth2 client_credentials, merchant identity, multi-store encrypted credentials, read-only `listOrder`, bounded pagination, `updatedAt` reconciliation, Integration Health and Integrations UI.

Out of scope:
webhook ingestion; provider writes; fulfillment/tracking writes; product/inventory/returns/finance sync; pilot/GA; deploy.

## Contract refresh first
Verify/update only proven stale facts in `providers/ikas/contracts/admin-v1.json`:
- token response `expires_in=14400`;
- PaginationInput limit 1..200, default 50; page default 1;
- canonical account identity = `getMerchant.id`, not client_id/client_secret/token/store URL.

## Auth
Token endpoint is store-specific under `*.myikas.com`, form-urlencoded client_credentials.
GraphQL endpoint fixed at `https://api.myikas.com/api/v1/admin/graphql`.
Persist store locator + clientId + clientSecret in existing encrypted connector_credentials.
Never persist access_token.
HTTP 200 + GraphQL `errors[]` is failure.
401: refresh once, retry once, no loop.

## Account model
provider key `ikas`; providerAccountId=`merchant.id`; display=`storeName`.
Multiple ikas stores remain active simultaneously.
Use multi-store semantics; do not deactivate siblings.
Credential rotation with same merchant.id preserves identity.

## Disconnect
Prove organization + account id + marketplace=`ikas` before mutation.
Wrong provider/tenant -> NOT_FOUND, no mutation.
Delete only that account credential and deactivate only that account.
Preserve historical business data.

## Orders
Read-only `listOrder`.
Stable identity: order.id; human reference orderNumber; line id; variant.id.
Do not guess package identity.
Unknown status stays unknown/raw.
No manual timezone +/-3.
Malformed timestamp never becomes epoch.
Money crosses boundary as decimal string; no invented currency conversion.
Use only documented address/phone fields.

## Pagination/reconciliation
limit <= 200.
Dedupe order.id.
Bound repeated/non-progressing pages.
Fixed upper-bound window over updatedAt.
Checkpoint advances only after complete success.
Partial/failed pagination does not advance checkpoint.
Boundary overlap uses stable-id dedupe.
Do not rely on webhook.

## Webhook
Do not implement ikas webhook ingestion or unsigned event acceptance.

## Health
Extend accepted account-scoped credential presence to ikas.
Key `ikas::<marketplaceAccountId>`.
Sibling stores isolated; NEVER_RUN carries real account UUID.

## Rollout
At most `internal_test`.
`stageAffectsLiveBehavior(internal_test)` remains false.
No ikas read may cause Sürat create, label generation, print, auto-label, or live fulfillment persistence.
Gate by rollout stage, not provider-name special casing.
Landing/onboarding remain closed to ikas.

## UI
Use existing IntegrationsPage → E-Ticaret Siteleri.
Fields: store name, Client ID, Client Secret.
Truthful INTERNAL TEST status.
Never refill secrets plaintext.
Manage multiple stores independently.

## Required proof
Contract freshness; OAuth shape/host; no secret query; no token persistence; one-time 401 refresh; GraphQL errors; merchant identity; rotation identity; multi-store isolation; disconnect provider/tenant scope; order/line/variant identity; unknown status; timestamp/money/address truth; pagination max/dedupe/non-progress; checkpoint safety; no webhook; real account Health; internal_test live-write gate; landing/onboarding closed; tenant isolation.

## Mutation minimum
1. client_id as identity fails.
2. persisted access token fails.
3. HTTP 200+GraphQL errors as success fails.
4. checkpoint advance on partial fails.
5. provider-wide ikas credentials fail.
6. unsigned webhook enable fails.
7. rollout pilot/ga fails.
8. canonical live writer in internal_test fails.

## Gates
Add `test:ikas`, register relevant server tests in the full suite, then run `.ai/QUALITY_GATES.md`.

Final verdicts include IKAS_CONTRACT, IKAS_OAUTH, IKAS_MERCHANT_IDENTITY, IKAS_MULTI_STORE, IKAS_ACCOUNT_SCOPED_CREDENTIALS, IKAS_SECRET_SAFETY, IKAS_CONNECTION_TEST, IKAS_ORDERS_READ, IKAS_PACKAGE_IDENTITY, IKAS_PAGINATION, IKAS_RECONCILIATION, IKAS_WEBHOOK=DISABLED_UNVERIFIED_SIGNATURE, IKAS_HEALTH_ACCOUNT_SCOPE, IKAS_TENANT_ISOLATION, IKAS_LIVE_WRITE_GATE, IKAS_ROLLOUT=INTERNAL_TEST, MIGRATION, LIVE_PROVIDER_VERIFICATION=NOT_PERFORMED, PILOT_READY=NO, IKAS_001.

Commit/push ticket branch. Do not deploy. Supervisor decides what follows.
