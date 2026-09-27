# DevFactory handoff

Ticket: ARAS-EXPANSION
Branch: `agent/ARAS-EXPANSION`
Status: `CI_PENDING`
HEAD: `49b509bc35c68225340d4ec29a7e05fe6e92f165`
Spec: `.ai/tickets/ARAS-EXPANSION.md`
PR: https://github.com/onurcemdogan/cargoflowv1/pull/8

## Codex merge-control finding CODEX-MERGE-a14f3b696b9f30e7 (repaired, code change applied)

Finding: `arasClient.ts` deletes CDATA content before extracting response fields. `stripNonElementXmlConstructs` removed `<![CDATA[...]]>` sections in the same pass as comments/PI/DOCTYPE, before `getWellFormedCleanedXml` returned its single cleaned string for both the SOAP-fault check and `extractKnownXmlFields`. But CDATA is real element character data, not a discardable construct — per XML, `<Envelope><ResultCode>0<![CDATA[99]]></ResultCode></Envelope>` has `ResultCode` text content `"099"` (a literal text node and a CDATA section concatenate into one logical value). Deleting the CDATA delimiters and payload made that exact body extract `ResultCode=0` instead of `099`, permitting a false create-success classification.

Fix (`server/carriers/aras/arasClient.ts`):
- `stripNonElementXmlConstructs` no longer touches CDATA — it only strips comments/PI/DOCTYPE, which remain genuinely discardable markup with no data value.
- `getWellFormedCleanedXml` now locates every CDATA span in the comment/PI/DOCTYPE-stripped body up front (via `cleaned.matchAll(/<!\[CDATA\[[\s\S]*?\]\]>/g)`), then filters the tag-matching scan (`cleaned.matchAll(/<[^>]+>/g)`) to discard any match whose start index falls inside a CDATA span. This is necessary because CDATA sections exist specifically to embed literal `<`/`>` characters without them being parsed as markup — without the filter, a CDATA payload containing those characters could either produce spurious "tags" that break the stack/root/gap checks, or (worst case) accidentally validate a body that isn't actually well-formed.
- The existing stack-based well-formedness checks (tag balance, single root, whitespace-only text outside the root) are otherwise unchanged and run only against the filtered, real tag matches.
- Only once validation succeeds does the function unwrap CDATA delimiters in the string it returns (`cleaned.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')`) — so the single string handed to both `containsSoapFault` and `extractKnownXmlFields` preserves the CDATA text instead of losing it, keeping the "one cleaned string, one source of truth" invariant established for `CODEX-MERGE-a7c6cff547743657`.

Regression tests added (`server/carrier-aras-client-flow.test.mjs`):
- `ARC-3k`: the exact body from the finding, `<Envelope><ResultCode>0<![CDATA[99]]></ResultCode></Envelope>` — asserts `outcome.ok === true` and `outcome.raw.ResultCode === '099'`.
- `ARC-3l`: a CDATA payload containing literal `<`/`>` characters (`<![CDATA[<not-a-tag>]]>`) — asserts the payload is preserved as text and not misparsed as a tag.

Verification this round:
- `npm run test:aras`: 60/60 (was 58/58; +2 new).
- `npx tsc -b --force`: clean.
- `npm run lint`: 0 errors (6 pre-existing unrelated warnings).
- `node --test server/carrier-aras-expansion-flow.test.mjs`: 11/11.

Committed as `49b509bc35c68225340d4ec29a7e05fe6e92f165` (code + test only). **Not yet done:** push to `origin/agent/ARAS-EXPANSION`, wait for GitHub CI (`quality`) and Cursor Bugbot to reach a terminal state on this head, then request a fresh Codex merge decision against `49b509bc35c68225340d4ec29a7e05fe6e92f165`. Do not push/merge `master`/`integration/roadmap` — only the ticket branch push is in scope, and only after the user/supervisor confirms.

## Codex merge-control finding CODEX-MERGE-9e972f27157ce0f7 (repaired, code change applied)

Finding: `getWellFormedCleanedXml` (as of `CODEX-MERGE-df09d9399eeb35cc`) extracted tags with `cleaned.match(/<[^>]+>/g)` and validated only tag-name balance and root-count from that resulting tag list — it never looked at the text sitting between or after those matches. A body like `<Envelope><ResultCode>0</ResultCode></Envelope>garbage` has balanced tags and exactly one root element, so it passed as well-formed even though `garbage` trails the closed root, which is not valid XML. `extractKnownXmlFields` (running on the same returned `cleaned` string) still matched `ResultCode=0` inside the valid portion, so the trailing garbage didn't even need to affect extraction — it just needed the validator to wrongly call the body well-formed, permitting a false create-success classification.

Fix (`server/carriers/aras/arasClient.ts`): switched from `cleaned.match(...)` to `cleaned.matchAll(...)` to get each tag match's index, and track a `cursor` through the scan. Before processing each tag, if `stack.length === 0` (i.e. we are outside any element — before the root opens, between top-level siblings, or after the root has closed), the gap between `cursor` and the current match's index must be whitespace-only or the body is rejected. After the loop, the same check is applied to any content remaining after the last tag. Text inside the root (`stack.length > 0`, e.g. the `0` inside `<ResultCode>0</ResultCode>`) is untouched — only content at document depth 0 is constrained. This also incidentally tightens validation for stray text left behind when a leading comment/PI/DOCTYPE is stripped (e.g. `<!--x-->y<Envelope/>` now correctly fails instead of silently passing).

Regression test added (`server/carrier-aras-client-flow.test.mjs`):
- `ARC-3j`: the exact body from the finding, `<Envelope><ResultCode>0</ResultCode></Envelope>garbage` — asserts `ARAS_MALFORMED_RESPONSE`, `raw: null`.

Verification this round:
- `npm run test:aras`: 58/58 (was 57/57; +1 new).
- `npx tsc -b --force`: clean.
- `npm run lint`: 0 errors (6 pre-existing unrelated warnings).
- `node --test server/carrier-aras-expansion-flow.test.mjs`: 11/11.

Committed as `b9f5b56cc80552bec79fc009669840ecb7684ae7` (code + test only). **Not yet done:** push to `origin/agent/ARAS-EXPANSION`, wait for GitHub CI (`quality`) and Cursor Bugbot to reach a terminal state on this head, then request a fresh Codex merge decision against `b9f5b56cc80552bec79fc009669840ecb7684ae7`. Do not push/merge `master`/`integration/roadmap` — only the ticket branch push is in scope, and only after the user/supervisor confirms.

## Codex merge-control finding CODEX-MERGE-df09d9399eeb35cc (repaired, code change applied)

Finding: `getWellFormedCleanedXml`'s stack-based tag matcher (added for `CODEX-MERGE-f45d49551e813508`) only verified that every open tag had a matching, properly nested close tag — it never checked that the body has exactly **one** root element. A body like `<Envelope/><ResultCode>0</ResultCode>` self-closes the root immediately (self-closing tags were just `continue`d, never pushed to the stack) and then opens/closes a sibling `<ResultCode>` at the same top level; the stack ends empty (balanced) so the whole thing passed as well-formed even though it has two top-level elements, which is not valid XML. `extractKnownXmlFields` then read `ResultCode=0` out of the stray sibling, permitting a false create-success classification — exactly the multi-root case the original stack-balance check didn't cover.

Fix (`server/carriers/aras/arasClient.ts`): `getWellFormedCleanedXml` now tracks a `rootCount`, incremented whenever an element (opening or self-closing) begins at `stack.length === 0`. If `rootCount` ever exceeds `1` mid-scan, or is not exactly `1` once the stack is empty at the end, the body is rejected as malformed. No other logic changed — `finishArasSoapCall` still branches on `null` vs. a cleaned string.

Regression test added (`server/carrier-aras-client-flow.test.mjs`):
- `ARC-3i`: the exact body from the finding, `<Envelope/><ResultCode>0</ResultCode>` — asserts `ARAS_MALFORMED_RESPONSE`, `raw: null`.

Verification this round:
- `npm run test:aras`: 57/57 (was 56/56; +1 new).
- `npx tsc -b --force`: clean.
- `npm run lint`: 0 errors (6 pre-existing unrelated warnings).
- `node --test server/carrier-aras-expansion-flow.test.mjs`: 11/11.

Committed as `fd4ada89648efeb50f13f0f92e0d76ed77654915` (code + test only) and pushed to `origin/agent/ARAS-EXPANSION`. **Not yet done:** wait for GitHub CI (`quality`) and Cursor Bugbot to reach a terminal state on this head, then request a fresh Codex merge decision against `fd4ada89648efeb50f13f0f92e0d76ed77654915`. Do not push/merge `master`/`integration/roadmap`.

## Codex merge-control finding CODEX-MERGE-a7c6cff547743657 (repaired, code change applied)

Finding: `arasClient.ts` validated XML well-formedness on a comment/CDATA/PI/DOCTYPE-**stripped** copy of the body (`isWellFormedXml`), but `extractKnownXmlFields` extracted fields from the **original, unstripped** `bodyText`. So a response like `<Envelope><!--<ResultCode>0</ResultCode>--></Envelope>` passed validation — the stripped body is just a valid empty `<Envelope>` — while the per-field regex still matched `ResultCode=0` out of the commented-out text, which could let a tampered/malformed response be classified as a successful create.

Fix (`server/carriers/aras/arasClient.ts`): renamed `isWellFormedXml` to `getWellFormedCleanedXml`. Instead of returning a boolean, it now returns the cleaned (comments/CDATA/PI/DOCTYPE-stripped) body string when well-formed, or `null` otherwise. `finishArasSoapCall` calls this once and uses the **same** cleaned string as the sole input to both the SOAP-fault check (`containsSoapFault`) and `extractKnownXmlFields`, so anything removed during stripping can never be extracted as a field. `looksLikeXml` was removed (no longer needed — `finishArasSoapCall` branches directly on whether `getWellFormedCleanedXml` returned `null`).

Downstream `server/carriers/aras/arasContract.ts` (`classifyArasSetOrderResult`) already treats a missing `ResultCode` as `ARAS_SET_ORDER_RESULT_MISSING`, not success, so no caller changes were needed — the fix is fully contained to extraction consistency in `arasClient.ts`.

Regression test added (`server/carrier-aras-client-flow.test.mjs`):
- `ARC-3h`: body with `ResultCode=0` hidden inside an XML comment — asserts `outcome.ok === true` (body is well-formed once the comment is stripped) but `outcome.raw.ResultCode === undefined` (the commented-out field is never extracted).

Verification this round:
- `npm run test:aras`: 56/56 (was 55/55; +1 new).
- `npx tsc -b --force`: clean.
- `npm run lint`: 0 errors (6 pre-existing unrelated warnings).
- `node --test server/carrier-aras-expansion-flow.test.mjs`: 11/11.

Committed as `1915a0a3b1d58208bf553e0fc9471dabe84986c7` (code + test only; `.ai/*` docs sync is a separate commit per this branch's established pattern). **Not yet done:** push to `origin/agent/ARAS-EXPANSION`, wait for GitHub CI (`quality`) and Cursor Bugbot to reach a terminal state on the new head, then request a fresh Codex merge decision against `1915a0a3b1d58208bf553e0fc9471dabe84986c7`. Do not push/merge `master`/`integration/roadmap` — only the ticket branch push is in scope, and only after the user/supervisor confirms.

## Codex merge-control finding CODEX-MERGE-f45d49551e813508 (repaired, code change applied)

Finding: `arasClient.ts` did not validate XML well-formedness — `looksLikeXml` only checked that the body started with `<letter` and ended with `</tag>`, so a response with mismatched tags (e.g. `<Envelope><ResultCode>0</ResultCode></Foo>`) passed the check. `extractKnownXmlFields` then extracted `ResultCode=0` via per-field regex regardless of overall structure, which could let a malformed/tampered response be classified as a successful create.

Fix (`server/carriers/aras/arasClient.ts`): replaced the heuristic with `isWellFormedXml` — a dependency-free, stack-based tag matcher. It strips comments/CDATA/PI/DOCTYPE, tokenizes remaining `<...>` tags, and pushes/pops a stack on open/close tags, rejecting the body unless every open tag has a matching, properly nested close and the stack ends empty. `looksLikeXml` now delegates to it. No new dependency added (considered `jsdom`, already a devDependency, but it's HTML-oriented and only available in devDependencies — not appropriate to promote into server runtime for this).

Because `finishArasSoapCall` already gates `extractKnownXmlFields` behind `looksLikeXml`, this one change closes the gap: malformed bodies now return `ARAS_MALFORMED_RESPONSE` / `raw: null` before any field extraction happens.

Regression tests added (`server/carrier-aras-client-flow.test.mjs`):
- `ARC-3f`: mismatched open/close tags containing `ResultCode>0` — asserts `ARAS_MALFORMED_RESPONSE`, `raw: null`.
- `ARC-3g`: unclosed opening tag — asserts `ARAS_MALFORMED_RESPONSE`.

Verification this round:
- `npm run test:aras`: 55/55 (was 51/51; +4 net from the 2 new tests plus 2 pre-existing that were recounted in the same run).
- `npx tsc -b --force`: clean.
- `npm run lint`: 0 errors (6 pre-existing unrelated warnings).
- `node --test server/carrier-aras-expansion-flow.test.mjs`: 11/11.

Committed as `834579b3579c97c5119f0ef7c87465d71eb6f277` and pushed to `origin/agent/ARAS-EXPANSION`; `gh pr view 8` confirms `headRefOid` matches. GitHub CI (`quality`) and Cursor Bugbot were both `pending` immediately after push (run `36337651152`). **Not yet done:** wait for those checks to settle to a terminal state, then request a fresh Codex merge decision against `834579b3579c97c5119f0ef7c87465d71eb6f277`. If `quality` fails, diagnose via the run log before re-touching `arasClient.ts` — the local `npm run test:aras` (55/55), `tsc -b --force`, and `npm run lint` all passed before push, so a CI-only failure would point at an environment or flake, not the structural-XML fix itself.

## Codex merge-control finding CODEX-MERGE-ca1dce80fe96b617 (repaired, no code change needed — 3rd recurrence, root cause identified)

Same complaint as the two prior fingerprints (`CODEX-MERGE-61123b9a11e6de29` twice): "`drizzle/meta/0014_snapshot.json` is explicitly truncated in the supplied frozen-head diff." This round evaluated `headSha 8b0cdd70c0b735de25f7c569857ed3b2a2324a06`, which was already stale by the time of remediation — `gh pr view 8` shows the actual current PR head is `707473c86e661c20adbe89408d468bc378e52691` (matches local `HEAD` and `origin/agent/ARAS-EXPANSION`), `mergeStateStatus: CLEAN`, `mergeable: MERGEABLE`.

Re-verified independently at `707473c`:
- `drizzle/meta/0014_snapshot.json`: 91245 bytes, 3315 lines, `JSON.parse` ok, unchanged since migration commit `cd84632` (`git log -- drizzle/meta/0014_snapshot.json` shows one commit).
- `npm run db:check` (drizzle-kit check): "Everything's fine" — no drift.

**New this round — likely root cause of the recurring false positive:** `gh api repos/onurcemdogan/cargoflowv1/pulls/8/files -q '... | select(.filename=="drizzle/meta/0014_snapshot.json")'` returns `{"additions":3315,"deletions":0,"changes":3315,"status":"added","patch":null}`. GitHub's REST files-API omits the `patch` field once a file's diff exceeds its per-file size threshold — which this generated migration snapshot does. Any automated reviewer (Codex) that sources its "supplied diff" evidence from that API field will see **no diff content at all** for this file, independent of which commit/head is evaluated, and can reasonably describe that as "truncated." This is a property of the diff-transport the merge-control pipeline uses, not a repository defect: the git blob is complete and the migration is drift-free.

**Recommendation for supervisor:** if this exact evidence-completeness complaint recurs on a 4th fingerprint, treat it as a known limitation of the merge-control evidence pipeline (GitHub files-API `patch:null` on large generated files) rather than routing another implementation remediation — either have the pipeline fall back to a git blob fetch for files where `patch` is null, or manually override the gate with this handoff as evidence.

**Next action for supervisor:** request a fresh Codex merge decision against `headCommit 707473c86e661c20adbe89408d468bc378e52691`.

## Codex merge-control finding CODEX-MERGE-61123b9a11e6de29 (repaired, no code change needed)

Codex's merge-control gate rejected merge citing `drizzle/meta/0014_snapshot.json` as truncated (`riskEvidenceComplete: false`), evaluated against a stale frozen-head reference (`45e44fb`, the pre-remediation checkpoint). That commit genuinely predates the file: `git show 45e44fb:drizzle/meta/0014_snapshot.json` returns "does not exist". The prior remediation round (fingerprint `CODEX-MERGE-88024a2f97499c26`, fixed by claude) had already added the complete migration (`drizzle/0014_dark_leader.sql`, `drizzle/meta/0014_snapshot.json`, `drizzle/meta/_journal.json`) as part of fixing the persisted-artifact/timeout defects, committed at `cd84632` and already pushed to origin.

Verified at origin/PR head `8b0cdd7` (`gh pr view 8` headRefOid == `git rev-parse origin/agent/ARAS-EXPANSION`):
- `drizzle/meta/0014_snapshot.json` is 91245 bytes, parses as valid JSON, not truncated (same blob since migration commit `cd84632`; no drizzle diff on later wip checkpoints).
- `npm run db:check` (drizzle-kit check) reports no drift across the migration chain.
- Stale Codex frozen-head `45e44fb` still has no `drizzle/meta/0014_snapshot.json` in git — that is why automated review reported `riskEvidenceComplete: false`.

**Cursor session (2026-09-27):** Completed claude's TRANSIENT_ERROR repair path — no product/source changes; updated `.ai/CURRENT_TASK.json`, `.ai/CURRENT_CONTEXT.md`, this handoff.

**Next action for supervisor:** request a fresh Codex merge decision against `headCommit 8b0cdd70c0b735de25f7c569857ed3b2a2324a06` (not `45e44fb`) so the merge-control gate re-evaluates the current, complete evidence.

## Summary

`internal_test` Aras carrier path is implemented (SOAP transport, credentials, routing, health, UI, deterministic tests). Supervisor restart flagged **CI_FAILED**; this session reproduced the failing check, confirmed the fix on branch, and verified **GitHub DevFactory CI green** on current HEAD.

## CI failure (reproduced)

| Item | Detail |
|------|--------|
| Failed run | `36325213366` on `7f24048` (step: `npm run test:ui`) |
| Error | Testing Library: multiple `button` elements named **Ayarlar** (Surat + Aras carrier cards) |
| Fix commit | `3dfac8a` — Aras card primary label **Hesap Bağla**; `desiMultiplierSetting.dom.test.tsx` scopes Surat **Ayarlar** via `within(suratCard)` |
| Green run | `36325919805` on `45e44fb` — workflow **success** |

No additional product code changes were required in this session beyond state/handoff updates.

## Evidence

- `.ai/research/ARAS-EXPANSION/20260927T123508.646306Z-d4e2b02830054596b75c122f9c311ea5.json`

## Key implementation files

- `server/carriers/aras/*`, `server/connectors/aras/*`, `server/shipments/arasProvider.ts`, `trendyolShipmentEligibility.ts`
- `src/integrations/ArasSection.tsx`, `src/pages/IntegrationsPage.tsx`, `server/index.mjs`
- Tests: `carrier-aras-*.test.mjs`, `carrier-neutral-foundation-flow.test.mjs`

## Gates (cursor session 2026-09-27)

```bash
npx tsc -b --force          # ok
npm run lint                # 0 errors (6 pre-existing warnings)
npm run build               # ok
npm run test:ui             # 365/365 (CI regression target)
npm run test:aras           # 51/51
npm run test:connector-kernel
npm run test:integration-health
npm run test:dashboard
npm run test:label-editor:acceptance
npm run test:performance:acceptance
npm run test:auto-label:acceptance
npm run test:contract-packs
npm run test:subscription
npm run test:billing-party
npm run test:woocommerce
npm run test:print-platform
npm run test:onboarding
npm run test:landing
npm run test:ikas
npm run test:ticimax
npm run test:catalog
npm run test:product-tour
npm run test:surat          # 3269/3269 pass, exit 0 (this session)
```

## Required verdicts

| Verdict | Value |
|---------|-------|
| ARAS_CONTRACT | VERIFIED_PUBLIC_OFFICIAL_TEST_CONTRACT |
| ARAS_PRODUCTION_ENDPOINT | UNVERIFIED |
| ARAS_ACCOUNT_IDENTITY | LOCAL_MARKETPLACE_ACCOUNT_SCOPE |
| ARAS_SECRET_SAFETY | ENCRYPTED_AT_REST_NO_PLAINTEXT_API |
| ARAS_CONNECTION_TEST | NOT_LIVE_NETWORK (internal_test store only) |
| ARAS_MULTI_ACCOUNT | SIBLING_ISOLATED |
| ARAS_CARRIER_SELECTION_SEAM | EXPLICIT_CARGO_NAME_REQUIRED |
| ARAS_ORDER_CREATE | MOCK_PIPELINE_PROVEN |
| ARAS_VERIFICATION | GetOrderWithIntegrationCode_ONLY |
| ARAS_LABEL_ARTIFACT | GetBarcode → persist → reprint storage |
| ARAS_REPRINT_FROM_STORAGE | YES (no refetch) |
| ARAS_COD | FAIL_CLOSED_UNVERIFIED_VALUE_TABLE |
| ARAS_HEALTH_ACCOUNT_SCOPE | aras::marketplaceAccountId |
| ARAS_TENANT_ISOLATION | APPLICATION_SCOPED |
| ARAS_LIVE_WRITE_GATE | BLOCKED internal_test |
| ARAS_ROLLOUT | INTERNAL_TEST |
| MIGRATION | NONE (connector_credentials path) |
| LIVE_PROVIDER_VERIFICATION | NOT_PERFORMED |
| PILOT_READY | NO |
| ARAS_EXPANSION | READY_FOR_REVIEW |

## Next action

Review PR #8; do not push/merge protected branches. After approval, supervisor merges to `integration/roadmap`.
