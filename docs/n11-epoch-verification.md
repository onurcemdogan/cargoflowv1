# N11-LIVE-002 — epoch verification

Result (2026-10-14): **BLOCKED_EXTERNAL for checkpoint advancement only**.
`N11_EPOCH_SEMANTICS_UNVERIFIED` is intentionally retained. Account-verified
canonical reads remain available. No live provider requests were performed.

## Evidence and conclusion

The [official shipment-packages documentation](https://developer.n11.com/documentation/n11-siparis-entegrasyonu/siparis-listeleme-servisi/)
mentions milliseconds and GMT+3 but supplies neither a numeric request/local-time
pair nor an algorithm. The [SOAP–REST comparison](https://developer.n11.com/documentation/bilgilendirme/soap-restapi-siparis-servisi-karsilastirmasi/)
and [changelog](https://developer.n11.com/documentation/changelog/) do not resolve
this. The structured evidence record is `.ai/research/N11-LIVE-002/epoch-verification.json`.

Repository audit covered the client/config/sync/normalizer, three N11 fixture
suites, the P4 research summary in `docs/cargoflow-roadmap/STATE.json`, fixtures
and previous `.ai/research` records. No recorded live request paired with a
known local package update time was found. Existing responses are synthetic or
public shape examples, so they cannot establish actual server interpretation.

Inference: those facts cannot distinguish ordinary Unix epoch from a local-wall
clock encoded as though UTC. No conversion has been selected as the N11 rule.
A successful authentication, empty result, fixture pass, or UTC-looking response
alone cannot prove the request filter interpretation.

## Exact current encoding

For the known instant **2026-10-14 12:00:00.000 Türkiye (+03:00)**:

| Quantity | Value |
| --- | --- |
| Same instant in UTC | `2026-10-14T09:00:00.000Z` |
| Ordinary Unix epoch / current client value | `1791968400000` |
| Alternative local wall-clock epoch (+10,800,000 ms) | `1791979200000` |
| Which value N11 expects for this local instant | **Unproven** |

The client still sends input epoch milliseconds without a timezone shift. The
pure URL builder preserves exact integer millisecond endpoints. Explicit +03
inputs for January and July both map to 09:00Z at local noon, independently of
the host timezone or its DST. Tests run in UTC, Istanbul, New York and Auckland.
These tests explain the current wire value; they do not verify the N11 rule.
No speculative provider conversion helper, setting or environment override was
introduced. `n11EpochSemantics.ts` records the immutable unknown verification.

## Evidence needed to unblock

Either obtain an explicit official conversion algorithm with a numeric example,
or use a named organization/account and a stable, seller-owned, non-null package
whose **package last-modified time** is independently known in Türkiye time.
Order creation time is insufficient because incremental reads filter modification
time. The panel time's precision and timezone must be recorded. Credentials stay
in the application's existing encrypted store and never enter reports, URLs,
fixtures, terminal output or commits.

### Proposed read-only protocol — not executed

Only **GET `https://api.n11.com/rest/delivery/v1/shipmentPackages`** is needed.
No shipment/create, label, fulfillment, status update or other write is involved.

1. Read the named package with `packageIds=<known package ID>&sender=ALL&page=0&size=1`
   to confirm stable seller, status and modification value. Repeat this control
   after the comparison. Abort if it changes or is not exactly identifiable.
2. Run the two date-filtered variants below for its known status. **Omit
   packageIds/orderNumber from these requests**: identity filters could bypass
   date filtering, producing misleading proof. Check for the anchor package in
   the returned complete response without storing customer payloads.

For the illustrative local timestamp above (use an actual known anchor later):

| Parameter | Variant A: normal epoch | Variant B: local-wall shifted |
| --- | --- | --- |
| `startDate` | `1791968395000` | `1791979195000` |
| `endDate` | `1791968405000` | `1791979205000` |
| `status` | Anchor's current N11 status | Same status |
| `orderByField` | `true` | `true` |
| `orderByDirection` | `ASC` | `ASC` |
| `sender` | `ALL` | `ALL` |
| `page` / `size` | `0` / `100` | `0` / `100` |

3. Use adjacent non-overlapping negative-control intervals for both variants.
   Both-empty, both-matching, unstable anchors, incomplete/multipage responses
   or coarse/unknown panel times are inconclusive. A response timestamp alone
   is not an independent local-time anchor.
4. If a mapping is distinguished, use exact millisecond boundary reads around
   the stable anchor to record endpoint inclusion behavior. Retain the existing
   1ms overlap regardless. Bound the whole exercise to **at most 10 GETs**;
   inconclusive results keep the blocker. Do not automatically rerun or write.

Record only redacted account reference, tested bounds, anchor match booleans,
page completeness, independently known local/UTC time and stable modification
value. Exclude keys/secrets, raw headers and raw customer/order payloads.
Human/provider evidence review must precede any future gate removal.

## Safety and validation scope

Adaptive splitting, oldest-first traversal, 1ms overlap, package-id dedupe,
request budget, dense protection, seller binding and durability are unchanged.
`sender=ALL` remains; N11 warehouse packages gain no fulfillment eligibility.
`id:null` remains unpersistable. No migration, provider write or deployment.

The sync response now exposes `epochVerification` with `BLOCKED_EXTERNAL`,
`UNKNOWN` and the existing reason code. Verified accounts, empty reads and
request-body claims cannot clear it. A positive checkpoint test uses only the
existing server-side injected trusted fixture to model a future proven contract;
it also verifies count mismatch still blocks. That fixture is not provider proof
and is never configurable from HTTP bodies, credentials or the environment.

## Validation results

All local checks passed:

| Check | Result |
| --- | --- |
| `npm run test:n11` (foundation contracts now run in CI) | 51 contract + 27 read-flow + 5 UI tests |
| `npm run test:account-verification` | 16 tests |
| `npm run test:contract-packs` | 14 tests |
| `npm run test:connector-kernel` | 15 tests |
| `npm run test:integration-health` | 53 tests |
| `npm run test:integration-status` | 9 server + 8 UI tests |
| `npm run test:onboarding` | 22 server + 13 UI tests |
| `npm run test:auto-label:acceptance` | 115 tests |
| `npx tsc -b --force`, lint, build | Pass; lint 0 errors / 6 existing warnings |
| `npm run test:ui` | 423 tests / 44 files |
| `git diff --check` | Pass |

Two mutations (removing the unknown-epoch checkpoint gate; adding an unproven
three-hour shift) both failed assertions. Files were restored byte-exact.
Independent different-model review approved the diff. These are local
CI-equivalent checks; hosted CI and live provider success are not claimed.

Real positive acceptance—verified N11 date semantics permitting production
checkpoint advancement—is deliberately not claimed. It requires the external
evidence described above. No migration, push, merge or deployment.
