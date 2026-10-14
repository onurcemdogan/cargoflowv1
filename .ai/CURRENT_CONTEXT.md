# Current context

2026-10-14, Europe/Istanbul. Supervisor-selected N11-LIVE-002.
Branch `agent/N11-LIVE-002`, baseline `de5c18979deb054f4118dd9d66aae495952281b3`.
PR #19 was merged by the user before takeover; master was clean. No push, merge
or deployment requested on this ticket.

Result: BLOCKED_EXTERNAL for N11 checkpoint advancement only. Code, report and
tests complete; independent gpt-6-astra review APPROVED. Official shipment docs
say milliseconds/GMT+3 but provide no numeric request/local-time pair or
conversion algorithm. SOAP-REST comparison/changelog and repo fixtures/research
do not resolve it. User declines live account/package sharing now. Zero provider calls.

Keep N11_EPOCH_SEMANTICS_UNVERIFIED. Current numeric encoding is unchanged.
Local 2026-10-14 12:00 +03 = UTC 09:00 = 1791968400000; alternative shifted-wall
epoch is 1791979200000. Which N11 expects remains UNKNOWN. No conversion guess
or account/body/env proof override. Immutable n11EpochSemantics metadata is
BLOCKED_EXTERNAL/UNKNOWN and sync returns epochVerification. Empty reads and
verified accounts cannot clear it. Existing server-only trusted fixture models
future proof but still requires strict durability; it is not provider evidence.

Evidence: `.ai/research/N11-LIVE-002/epoch-verification.json`.
Report and unexecuted <=10 GET protocol: `docs/n11-epoch-verification.md`.
Needs a stable package last-modified local-time anchor, two numeric variants
and negative/boundary controls. Do not use packageIds/orderNumber in date-filter
comparison queries. No keys/secrets/raw headers/customer payloads in evidence.

Tests: test:n11 now includes foundation contracts in CI (51+27 read+5 UI).
Account16, contract-packs14, kernel15, health53, status9+8 UI, onboarding22+13 UI,
auto-label115, full UI423/44 pass; tsc force/lint/build/diff check pass (6 existing
lint warnings). Two mutations killed by assertions; files restored byte-exact.
Hosted CI/live provider verification are not claimed.

Adaptive splitting/oldest-first/1ms overlap/dedupe/budgets/dense handling/seller
ownership/persistence are unchanged. sender=ALL remains read-only; warehouse
packages gain no fulfillment. id:null remains unpersistable. No migration.
