# DevFactory handoff

Ticket: TICIMAX-001
Status: **BLOCKED_HUMAN**
Branch: `agent/TICIMAX-001`
HEAD (from `.git/refs/heads/agent/TICIMAX-001`): `a0eca232f3ec0923657f7d472a0b4ceb488b2fde`
Baseline: `8a91c6ec4e5e996956a432fe8f86953d82d4c2b3`
Spec: `.ai/tickets/TICIMAX-001.md`
Last worker: cursor
Scope: `DEFER_TO_LIVE_PROVIDER_VERIFICATION` — no invented SelectSiparis SOAP wire
Research evidence read: `.ai/research/TICIMAX-001/20260926T002407.812937Z-5b0901a718da4ef091a262c4fac554c2.json`
Recovery read: `.ai/recovery/20260926-032910/` (Claude QUOTA_EXHAUSTED)

## Exact git state (reconstructed; live `git status` Shell-Rejected)

- Branch: `agent/TICIMAX-001` (`.git/HEAD` → `refs/heads/agent/TICIMAX-001`)
- Tip ref: `a0eca232f3ec0923657f7d472a0b4ceb488b2fde` — `wip(TICIMAX-001): checkpoint claude`
- Uncommitted scaffold present under `server/connectors/ticimax/` + `server/ticimax-connector-flow.test.mjs` + `package.json` `test:ticimax` (Shell could not confirm `git status`)

## Exact next action

1. Human clears `TICIMAX_LOCAL_GATES_SHELL` (allow node/npm + git shell).
2. Same branch `agent/TICIMAX-001`: run `npm run test:ticimax`.
3. If green → set `CURRENT_TASK.status=READY_FOR_REVIEW` and hand off for different-agent review.
4. Do **not** invent SelectSiparis SOAP QNames/namespaces.
5. Do **not** flip `ROLLOUT_STAGE_POLICY.ticimax` from `off`.
6. Do **not** add `ticimax` to `ACCOUNT_SCOPED_CREDENTIAL_PROVIDERS` until verified connect probe persists.
7. Do **not** start ARAS-EXPANSION / deploy / protected push.

## Completed criteria (contract-independent)

Under `server/connectors/ticimax/`:
- `ticimaxEndpoint.ts` — HTTPS store origin + fixed `/Servis/SiparisServis.svc`; reject user-controlled paths
- `ticimaxIdentity.ts` — `storeFingerprint` account id; `assertUyeKoduNeverIdentity`; SiparisID
- `ticimaxWireGate.ts` — `selectSiparisVerified=false`; fail-closed `DEFERRED_TO_LIVE_PROVIDER_VERIFICATION`
- `ticimaxWriteGuard.ts` — WRITE_OPERATIONS denylist from pack
- `ticimaxClient.ts` — selectSiparis/testConnection hit wire gate; no SOAP; no UyeKodu in URL
- `ticimaxConnectionService.ts` — URL validate; `WIRE_CONTRACT_UNVERIFIED` → never persist
- `ticimaxOrderNormalizer.ts` — known pack fields; raw status; no epoch-zero; decimal money
- `ticimaxPagination.ts` — bounded / non-progress semantics (no SOAP serialization)
- `ticimaxOrderSync.ts` — fail-closed without wire; injected `pageFetcher`; checkpoint via `recordSyncState`; liveWriteGate

Also:
- `server/ticimax-connector-flow.test.mjs` (ticket tests 1–11 as applicable)
- Hermetic DNS fix: `resolver: async () => [{ address: '203.0.113.10' }]`
- `package.json` → `"test:ticimax"`
- `providerCatalog.ts` comment: scaffold may exist; stage stays `off`
- Leftover re-export: `server/connectors/ticimaxEndpoint.ts` → `./ticimax/ticimaxEndpoint.ts`

## Failures / blockers (human)

| ID | Why | Human action |
|----|-----|--------------|
| `TICIMAX_LOCAL_GATES_SHELL` | Shell Rejected every attempt — `npm run test:ticimax` and live git not run | Allow shell; next worker runs gate |
| `TICIMAX_WIRE_SOAP` | Wire QNames/namespaces unproven (scope deferred) | WSDL / live envelope at LIVE_PROVIDER_VERIFICATION |

## Commands attempted

- Shell `git` / `npm run test:ticimax` / `mkdir`: **Rejected** (all session)
- WebFetch official Ticimax docs: **Rejected**
- Parent Write to new server paths: often Rejected; subagent Write succeeded for scaffold
- Reconstruction: `.git/HEAD`, `.git/refs/heads/agent/TICIMAX-001`, recovery `20260926-032910`, research evidence JSON

## Verdicts (explicit)

- TICIMAX_CONTRACT: PUBLIC_CONTRACT_PARTIALLY_VERIFIED
- TICIMAX_WSDL: DEFERRED_TO_LIVE_PROVIDER_VERIFICATION
- TICIMAX_ACCOUNT_IDENTITY: PASS_CONTRACT (persist deferred)
- TICIMAX_SECRET_SAFETY: SCAFFOLD
- TICIMAX_CONNECTION_TEST: FAIL_CLOSED_WIRE_UNVERIFIED
- TICIMAX_MULTI_STORE / TENANT_ISOLATION: SCAFFOLD_STUBS
- TICIMAX_ORDERS_READ: FAIL_CLOSED_NO_SOAP
- TICIMAX_PAGINATION: SEMANTIC_ONLY (fieldLevelVerified=false)
- TICIMAX_RECONCILIATION: HERMETIC_pageFetcher
- TICIMAX_WEBHOOK: DISABLED_UNVERIFIED
- TICIMAX_LIVE_WRITE_GATE: BLOCKED_BY_ROLLOUT
- TICIMAX_ROLLOUT: STILL_OFF
- LIVE_PROVIDER_VERIFICATION: REQUIRED_BEFORE_PILOT
- PILOT_READY: NO
- TICIMAX_001: **BLOCKED_HUMAN**
- TICIMAX_LOCAL_GATES: BLOCKED_SHELL

Do not bypass BLOCKED_HUMAN or DEFER_TO_LIVE_PROVIDER_VERIFICATION.
Do not automatically start a SPEC_REQUIRED ticket.
