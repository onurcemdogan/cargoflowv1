# Current context

Date: 2026-10-14 (Europe/Istanbul)
Ticket: ACCOUNT-LEVEL-LIVE-VERIFICATION-001
Branch: feat/account-level-live-verification-001
Base: 6287450
Evidence: IMPLEMENTATION_COMPLETE; independent gpt-6-astra review approved.

Takeover was clean: no Claude partial diff or commits beyond base existed.
Existing encrypted credentials, verification columns, read clients, persistence
and durability rules were reused. No migration or rollout promotion.

N11/HB save and Test Et persist exact-account safe GET evidence. Canonical read
activation loads current credentials and verification from DB. Credential
rotation invalidates evidence; stale probes cannot verify or mutate seller
binding; concurrent N11 sibling seller claims serialize within the tenant.

Production create/label boundaries use the unchanged fulfillment rollout gate
and persisted order identity. Read proof never grants shipment, label,
marketplace write, billing or automation permission. Aras stays TEST/internal_test
with no automatic SOAP calls. UNKNOWN_AFTER_NETWORK/idempotency remain unchanged.

All requested targeted suites, tsc, lint (0 errors, 6 existing warnings), build,
and full UI (423) passed. Account proof suite: 12/12. Mutations A-E: 5/5 killed,
files restored byte-exact. Focused tenant/Sürat fulfillment regressions: 99/99.
Full enormous test:surat was not run, per the task's requested scope.

Open operational blockers: N11 GMT+3 cursor semantics and id:null, per-account HB
endpoint/list configuration, Aras production endpoint and payer/COD/write proof.
No real provider account was verified by this validation; no external write,
push or deploy occurred. The local completion commit is the branch HEAD.
