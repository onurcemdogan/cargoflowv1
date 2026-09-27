# DevFactory handoff

Ticket: ARAS-EXPANSION
Branch: `agent/ARAS-EXPANSION`
Status: `BLOCKED_EXTERNAL` / `RESEARCH_REQUIRED`
Spec: `.ai/tickets/ARAS-EXPANSION.md`

## Completed and verified

- Real TEST-only Aras `SetOrder` transport exists in `server/carriers/aras/arasClient.ts`.
- `server/carrier-aras-client-flow.test.mjs`: 14/14 green.
- `npm run test:aras`: 39/39 green (25 existing + 14 client tests).
- TypeScript build, lint, connector-kernel and integration-health gates were green in the implementation session.
- Credential persistence path was identified as the existing account-scoped integration credential infrastructure; no separate carrier-secret store should be invented.

## Remaining external research — automated, not human

1. `ARAS_ACCOUNT_IDENTITY`: public evidence does not prove a provider-native non-secret account identifier. This is a provider-contract question, not a missing credential value. For `internal_test`, use the existing CargoFlow integration/account record's stable non-secret local key for account scoping; do not use `UserName`, `Password`, or their hashes as identity. If official Aras material exposes a provider-native customer/account ID, record it as provider metadata after verification.
2. `ARAS_VERIFICATION_LABEL_CONTRACT`: pin the exact public TEST SOAP request shapes for `GetOrderWithIntegrationCode` and `GetBarcode` from official public WSDL/documentation. A prior interactive WebFetch permission rejection is a tooling event, not a human gate. DevFactory research/Codex should perform this research non-interactively.

## Next automatic action

DevFactory should run public provider-contract research, persist verified evidence, obtain Codex control-plane authorization to resume, and continue the same ticket with Claude/Cursor. Do not ask the user unless the automated research proves that a genuinely private tenant-only value/evidence is required for the current safe step.

`LIVE-PROVIDER-VERIFICATION` remains a separate roadmap gate for real credential values and any real TEST-account call. Do not deploy or advance beyond `internal_test`.
