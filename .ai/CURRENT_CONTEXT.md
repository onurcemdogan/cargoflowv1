# Current context

Date: 2026-10-14 (Europe/Istanbul)
Ticket: ACCOUNT-LEVEL-LIVE-VERIFICATION-001
Branch: feat/account-level-live-verification-001
Base: 6287450
Follow-up baseline: f2ff13cfbd19bc438845271103bdadcf64a385ed (PR #19)
Evidence: IMPLEMENTATION_COMPLETE; independent gpt-6-astra follow-up review approved.

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

PR #19 review fixes: HB verification needs the selected path's merchantId
placeholder or a nonempty response with every merchant matching. Unbound empty
reads remain unverified with HB_ACCOUNT_BINDING_UNPROVEN. HB sync uses offset 0,
discards full pages and splits oldest-first, with 1ms overlap/dedupe, 1s minimum
split interval and 350-request hard cap (<35,000 retained records). Eight planned
slices cover the seven-day initial lookback while respecting 24h/7d request caps.
Dense/budget partial runs never checkpoint. Merchant conflicts are checked before
normalization can erase duplicate identities.

Producer/catchup use canonical marketplace and the shared source gate before
enqueue. Descriptor-derived producer exclusions precede LIMIT, preserving
Trendyol throughput. Preparation rejects persisted sources before settings,
desi, lifecycle, billing or carrier credentials. No provider-name branches.

All requested suites passed: account verification 16; HB 23+4 UI; N11 26+5 UI;
auto-label acceptance 115; onboarding 22+13 UI; health 53; status 9+8 UI; kernel 15;
Aras 95; focused shipment/Sürat/label tests 78. tsc force, build, full UI 423/44
and diff check passed; lint 0 errors, 6 existing warnings. Mutations A-E, F, G,
H-P/H-C/H-L all failed assertions and restored files byte-exact. The account
suite is registered in test:surat; the full enormous suite was not requested.

Open operational blockers: N11 GMT+3 cursor semantics and id:null, per-account HB
endpoint/list configuration, Aras production endpoint and payer/COD/write proof.
No real provider account was verified and no provider write occurred. User's
follow-up authorizes commit and ordinary push to the same branch to update PR #19.
The completion commit is branch HEAD. No merge, deploy or new branch.
