# TICIMAX-001 ? Account-scoped Ticimax connector

Rollout: `internal_test`
Production deploy: FORBIDDEN

## Mission

Implement the initial read-only, account-scoped Ticimax connector using
CargoFlow's accepted Connector Kernel, credential encryption and
Integration Health foundations.

## Official contract source

Primary public source:
https://static.ticimax.com/dokumanlar/SiparisServis.pdf

Before implementation, refresh the current official contract/WSDL.

The public Ticimax documentation establishes that `SelectSiparis` accepts:

- `UyeKodu`
- `WebSiparisFiltre`
- `WebSiparisSayfalama`

and returns Ticimax order records.

The documentation explicitly describes `UyeKodu` as the password supplied
by the service provider.

Therefore:

`UyeKodu` MUST NEVER be used as providerAccountId.

## Mandatory identity gate

Before canonical marketplace-account persistence, prove a stable,
provider-native Ticimax store/account identity from current official
contract evidence.

Do not use as account identity:

- UyeKodu
- hashes of UyeKodu
- other credentials/secrets
- order IDs
- member/customer IDs
- invented numeric IDs

If a stable provider-native identity cannot be proven:

set `CURRENT_TASK.status = BLOCKED_HUMAN`

and stop before credential/account persistence.

Do not guess.

## Initial scope

Only after the identity gate passes:

- account-scoped connect/disconnect
- encrypted credential storage
- connection test
- read-only `SelectSiparis`
- bounded pagination
- deterministic reconciliation
- order normalization
- Integration Health
- existing Integrations UI
- multiple-store isolation
- `internal_test` rollout only

## Safety

HTTPS only.

Normalize and validate the Ticimax store origin.

Do not permit arbitrary user-controlled SOAP service paths.

Reuse accepted SSRF/DNS rebinding protections where applicable.

Never log or redisplay UyeKodu.

Do not put UyeKodu into URL query strings.

No plaintext credential storage.

No Ticimax write operations.

Do not call order status, shipment, invoice, tracking or integration-marking
write methods.

No carrier/shipment/label/printing side effect may be triggered by an
internal_test Ticimax read.

## Orders

Use documented stable Ticimax order identity.

Do not invent package identity.

Keep provider status/raw values when exact mapping is unknown.

Do not silently convert malformed timestamps to epoch/zero dates.

Preserve monetary precision.

## Pagination/reconciliation

Pagination must be:

- bounded
- deterministic
- resistant to repeated/non-progressing pages
- deduplicated using proven stable provider order identity

Checkpoint advancement occurs only after complete successful reconciliation.

Partial/failing pagination must not advance the checkpoint.

## Webhooks

Disabled unless a current official authentication/signature contract is
proven.

Default verdict:

`TICIMAX_WEBHOOK=DISABLED_UNVERIFIED`

## Tests

Prove at minimum:

1. UyeKodu cannot become providerAccountId.
2. Secrets are encrypted and never returned plaintext.
3. Tenant isolation.
4. Sibling Ticimax account isolation.
5. SOAP faults cannot become successful order reads.
6. Failed pagination cannot advance reconciliation checkpoint.
7. Repeated pages terminate safely.
8. Stable order identity is provider-derived.
9. No Ticimax write method is called.
10. internal_test cannot trigger live carrier/provider writers.
11. rollout cannot silently become pilot/GA.

Add a focused `test:ticimax` gate when executable implementation exists.

Do not weaken existing tests.

## Required verdicts

Report explicitly:

- TICIMAX_CONTRACT
- TICIMAX_WSDL
- TICIMAX_ACCOUNT_IDENTITY
- TICIMAX_SECRET_SAFETY
- TICIMAX_CONNECTION_TEST
- TICIMAX_MULTI_STORE
- TICIMAX_ORDERS_READ
- TICIMAX_PAGINATION
- TICIMAX_RECONCILIATION
- TICIMAX_WEBHOOK
- TICIMAX_HEALTH_ACCOUNT_SCOPE
- TICIMAX_TENANT_ISOLATION
- TICIMAX_LIVE_WRITE_GATE
- TICIMAX_ROLLOUT=INTERNAL_TEST
- MIGRATION
- LIVE_PROVIDER_VERIFICATION
- PILOT_READY
- TICIMAX_001

## Stop conditions

Use BLOCKED_HUMAN rather than assumptions whenever required contract truth
cannot be proven.

Never deploy.

Never start ARAS-EXPANSION from this ticket.
