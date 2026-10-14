# ACCOUNT-LEVEL-LIVE-VERIFICATION-001

Supervisor-selected task. Branch: `feat/account-level-live-verification-001`.
Base: `6287450`. The checkout was clean at takeover; no Claude WIP or later
commit existed. Reuse the implemented connectors and existing verification
tables/columns. The initial task prohibited push. The PR #19 follow-up below
explicitly authorizes commit and ordinary push on this same branch. No merge,
deploy, reset, branch change or external provider write.

## PR #19 manual-review follow-up (2026-10-14)

Continue from `f2ff13cfbd19bc438845271103bdadcf64a385ed`, same branch and PR.
Fix only these three blockers, validate, commit and PUSH to origin:

- HB account verification requires the selected read path's `{merchantId}` or
  a nonempty response where every merchantId is present and matches. Explicit
  mismatches always fail. Otherwise retain credentials, remain unverified with
  `HB_ACCOUNT_BINDING_UNPROVEN`; no fulfillment effects.
- HB reads only offset 0. Full pages are discarded and the time interval splits
  oldest-first. Bound minimum interval, request count and retained rows; overlap
  and dedupe boundaries, respect 24h package / 7d order limits. Dense intervals
  and exhausted budgets are PARTIAL with stable reasons and no checkpoint.
  Merchant conflicts (including duplicate package keys), missing identities and
  incomplete persistence continue to pin the checkpoint.
- Producer and catchup pass canonical marketplace to create eligibility and
  apply the shared source fulfillment gate before enqueue. Preparation rejects
  persisted restricted sources before lifecycle/desi/billing. Source exclusions
  precede producer batch limits so Trendyol cannot starve. No provider-name list.

Run account-verification, hepsiburada, n11, auto-label acceptance, onboarding,
integration-health, integration-status, connector-kernel, relevant shipment /
Sürat / label preparation-producer-catchup tests; tsc force, lint, build, full UI
and diff check. Kill binding, offset-walking and all three pipeline bypass
mutations with assertion failures and byte-exact restoration. Recheck retained
N11, credential rotation, rollout, Aras and UNKNOWN_AFTER_NETWORK protections.
Do not merge or deploy.

## Required behavior

- Persist encrypted N11/HB configuration and synchronize credential fingerprint.
- Save and Test Et run one bounded safe GET and persist exact-account status.
- Valid authenticated envelopes verify read access. HB empty arrays require
  selected-path merchant binding, as specified in the follow-up above.
- Auth rejection -> auth_failed; 429 -> rate_limited; timeout/network/5xx ->
  provider_unavailable; shape/endpoint mismatch -> unverified with stable reason.
- Temporary provider errors retain credentials. Credential/config changes reset
  verification. A stale probe cannot verify or bind a seller to newer credentials.
- Canonical ingestion requires implemented/supported/contract-verified orders.read,
  tenant ownership, active exact account, complete credentials, matching current
  fingerprint, persisted verified status and existing durability rules.
- The shared decision uses descriptor declarations, not provider-name branches.
- Read activation does not promote rollout or authorize create, labels, marketplace
  writes, billing effects or automation. Production side-effect boundaries enforce
  the existing fulfillment gate against persisted order source.
- Onboarding uses the same active account's verification and required first sync.
  Sibling verification and sync cannot be combined. Trendyol behavior stays intact.
- Aras remains TEST/internal_test. Save only aligns existing evidence and resets
  changed credentials. No harmless proven probe exists: no SetOrder or dummy write.

## Operational blockers retained

- N11 id:null / Konuma Özel Teslimat cannot be persisted; cursor stays pinned.
- N11 GMT+3 epoch semantics remain unproven; production cursor advancement stays
  blocked independently of successful read authentication.
- HB needs its account's configured endpoint/list envelope; no guessed paths/fields.
- Aras production endpoint, PayorTypeCode/COD and real write evidence remain external
  blockers. Production URL is not derived. UNKNOWN_AFTER_NETWORK never retries.

## Validation

Required provider, integration-health/status, onboarding, connector-kernel,
tenant-auth, carrier/preflight and canonical-presence suites; tsc, lint, build,
full UI. `test:account-verification` covers all 21 required proofs plus concurrent
seller claims, stale seller binding and production create/label boundaries.

`test:account-verification:mutations` must kill A credential-presence proof,
B sibling proof, C missing reset, D read-to-fulfillment grant, E missing tenant
ownership. The runner restores every modified file byte-exact in finally.

The enormous full test:surat suite is not required; run focused Sürat regression
tests for the shared fulfillment boundaries instead. No audit fix.
