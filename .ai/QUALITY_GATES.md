# CargoFlow quality gates

Run all applicable commands:

```bash
npx tsc -b --force
npm run lint
npm run build
npm run test:ui
npm run test:dashboard
npm run test:label-editor:acceptance
npm run test:performance:acceptance
npm run test:auto-label:acceptance
npm run test:connector-kernel
npm run test:contract-packs
npm run test:integration-health
npm run test:subscription
npm run test:billing-party
npm run test:woocommerce
npm run test:print-platform
npm run test:onboarding
npm run test:catalog
npm run test:product-tour
npm run test:landing
npm run test:ikas
npm run test:surat
npm run test:aras
```

No skip/todo/weakened assertions. Mutation proof when the active ticket requires it.

## Provider verification standard

Core rule: **no credential != development blocked. No evidence = only the
capability that depends on that evidence stays blocked.**

Verification is tracked per capability (`orders.read`, `label.fetch`,
`shipment.create`, `orders.status.write`, ...), never per provider or per
roadmap. The runtime switch stays the existing rollout stage
(`ROLLOUT_STAGE_POLICY` + `liveWriteGate`); the statuses below are evidence
labels and add no new runtime gate. They are not a mandatory sequence.

| Status | Real credentials | Meaning |
|---|---|---|
| `IMPLEMENTATION_COMPLETE` | not needed | Normal engineering completion. Default rollout: `internal_test`. |
| `SANDBOX_VERIFIED` | sandbox only | Optional. Only when the provider offers an accessible sandbox/test environment. |
| `LIVE_VERIFIED` | needed | Operational check of facts that cannot be proven hermetically. |
| `LIVE_WRITE_VERIFIED` | needed + human approval | Only before enabling a capability with real side effects. |
| `BLOCKED_EXTERNAL` | - | One capability waits on external evidence; nothing else waits on it. |
| `PILOT_READY` | - | Every capability the pilot actually uses is `LIVE_VERIFIED` (`LIVE_WRITE_VERIFIED` if it writes). |

### IMPLEMENTATION_COMPLETE (no real account required)

Reached with: official provider documentation, verified contract evidence,
fixtures, mocked/injected transports, and hermetic tests for tenant/account
isolation, pagination, retry, rate limits, idempotency/persistence, health
and UI -- plus the command gates above.

### LIVE_VERIFIED (operational, not an implementation prerequisite)

Validates only what hermetic tests cannot prove: real authentication
behavior, actual endpoint/path configuration, the real response envelope,
undocumented quirks, provider-specific rate/error behavior. Do not repeat
live what a contract test already proves deterministically.

### LIVE_WRITE_VERIFIED

Required only before enabling shipment create, marketplace writes, labels
that create/accept fulfillment, billing/money movement, or destructive
mutations. Human-approved and narrowly scoped: named account, named
capability, smallest possible action.

### What may block

A missing fact may stop progress only when proceeding without it could
cause: tenant/account data bleed, duplicate or wrong fulfillment, an
irreversible shipment/create/write, a money/billing error, permanent data
loss, credential exposure, or wrong provider ownership/routing. Even then it
blocks only the capability that depends on that fact. Everything else is a
warning, a deferred verification item, or a capability-level
`BLOCKED_EXTERNAL`.

- Production endpoint unknown -> blocks production calls, not the connector.
- Label endpoint unknown -> blocks label fetch, not order sync.
- COD code table unknown -> blocks COD, not ordinary shipments.
- Real account unavailable -> blocks live verification only.

Do not:
- make `SANDBOX_VERIFIED` mandatory when no sandbox exists;
- make `LIVE_VERIFIED` a dependency for starting the next provider;
- add a gate that proves what an existing gate or test already proves;
- block read-only implementation because production credentials are absent;
- invent research gates when official contract evidence is sufficient;
- turn informational warnings into roadmap blockers.

### Examples

Hepsiburada (HEPSIBURADA-LIVE-001):
- `orders.read` is `IMPLEMENTATION_COMPLETE` from the verified public
  contract plus hermetic tests; no real account was used.
- Endpoint paths and the list envelope are not in the public contract: they
  are per-account configuration, and a missing value fails closed for that
  account only (`ENDPOINT_CONFIG_REQUIRED`).
- Marketplace-managed label retrieval is `BLOCKED_EXTERNAL` (no verified
  label endpoint). Order sync is unaffected.
- Missing credentials block only `LIVE_VERIFIED`.
- The connector stays `internal_test` (canonical writes off via
  `liveWriteGate`) until `orders.read` is `LIVE_VERIFIED`.

N11 (N11-LIVE-001):
- Build `orders.read` from the verified official contract
  (`server/marketplaces/n11/n11Contract.ts`, verified 2026-08-19).
- A real N11 account is not required to call it `IMPLEMENTATION_COMPLETE`.
- Status updates / marketplace writes stay disabled until a later,
  human-approved `LIVE_WRITE_VERIFIED`.
