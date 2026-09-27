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

## Supervisor clarification

- `ARAS_ACCOUNT_IDENTITY` is no longer an unresolved blocker for this
  `internal_test` ticket. Use the existing CargoFlow integration/account
  record's stable non-secret local primary key for account scoping.
  `UserName` / `Password` remain secrets and are never identity.
  A future provider-native Aras customer/account identifier is optional
  verified provider metadata, not a prerequisite.

- The only remaining public research blocker is
  `ARAS_VERIFICATION_LABEL_CONTRACT`: independently verify the exact
  SOAP 1.1 wrapper names, `http://tempuri.org` namespace, SOAPAction,
  and case-sensitive request field names for
  `GetOrderWithIntegrationCode` and `GetBarcode` from Aras's official
  public TEST service. No credential values are needed or requested.

- After that public schema evidence is independently verified, resume
  the same `agent/ARAS-EXPANSION` branch automatically.

## Next automatic action

DevFactory should run public provider-contract research, persist verified evidence, obtain Codex control-plane authorization to resume, and continue the same ticket with Claude/Cursor. Do not ask the user unless the automated research proves that a genuinely private tenant-only value/evidence is required for the current safe step.

`LIVE-PROVIDER-VERIFICATION` remains a separate roadmap gate for real credential values and any real TEST-account call. Do not deploy or advance beyond `internal_test`.
