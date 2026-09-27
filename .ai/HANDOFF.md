# DevFactory handoff

Ticket: TICIMAX-001
Status: **REVIEW_FEEDBACK_ADDRESSED** (PR #7 findings already in tree; gates not re-run this session)
Branch: `agent/TICIMAX-001`
HEAD (reflog tip): `a11c3b82d8e98cee3001788df40ee62409c92ee2` — `wip(TICIMAX-001): checkpoint review-feedback-cursor`
Prior: `4233ab12dc11790e7f22534aff226b24bf834433` — `wip(TICIMAX-001): checkpoint claude`
Baseline: `8a91c6ec4e5e996956a432fe8f86953d82d4c2b3`
Spec: `.ai/tickets/TICIMAX-001.md`
Last worker: cursor
Scope: `DEFERRED_TO_LIVE_PROVIDER_VERIFICATION` — no invented SelectSiparis SOAP wire

## Git state (reconstructed without shell)

- Branch tip from `.git/logs/HEAD`: `a11c3b82d8e98cee3001788df40ee62409c92ee2`
- This pass did not commit. Dirty files: `.ai/CURRENT_TASK.json`, `.ai/HANDOFF.md` (and whatever the shift already had dirty)
- Shell (`git` / `npm` / `npx` / `gh`): **Rejected** again. No new test, lint, or typecheck log.

## External review findings → evidence (PR #7)

Re-read on this pass. No further code edit. Behavior matches the contract pack.

| ID | Finding | Pack / rule | Evidence in tree |
|----|---------|-------------|------------------|
| PR7-F1-ALIASES | Guessed order field aliases (`SiparisTarihi`, `OrderDate`, `ToplamTutar`, `ParaBirimi`) | `ORDER_MODEL.knownFields` only | `normalizeTicimaxOrder` maps only `SiparisID`, `SiparisNo`, `SiparisKodu`, `SiparisDurumu`, `OdemeTipi`, `UyeID`, `KargoTakipNo`, `AliciAdi`. `orderDate`, `totalDecimal`, `currency` are null. Alias keys stay on `rawOrder`. TICIMAX-8 |
| PR7-F2-OFFSETLESS-DATE | Offset-less timestamps must not become UTC via `Date.parse` | `DATE_TIMEZONE_RULES.DECISION` = `TAHMİN EDİLMEZ.` | `ticimaxDateToInstant` returns `instant: null` unless the text ends in `Z` or `±HH:MM`. `normalizeTicimaxOrder` does not read date fields (`orderDate` always null). TICIMAX-8b |
| PR7-F3-DECIMAL | Invalid decimals must not be accepted | Strict `^-?\d+(\.\d+)?$` when the helper is used; no money field is mapped | `ticimaxDecimalString` returns null for non-matching strings (`119,99`, `not-a-number`). TICIMAX-8b |

**Preserved:** `TICIMAX_WIRE_CONTRACT.selectSiparisVerified=false`, `ticimaxWireGate.ts` reason `DEFERRED_TO_LIVE_PROVIDER_VERIFICATION`, rollout off, live write gate blocked. `ticimaxClient.ts` still fail-closes before SOAP.

## Commands

Not run this session (shell rejected).

Last recorded gate (`.ai/.runtime/quality-gates.json`, 2026-09-26T22:20:12Z):

- `npm run test:ticimax` — exit 0

Still required before `READY_FOR_REVIEW`:

```bash
npm run test:ticimax
npx tsc -b --force
npm run lint
```

## Exact next action

1. Run the three commands above on `agent/TICIMAX-001`.
2. If they pass, set `CURRENT_TASK.status` to `READY_FOR_REVIEW` and refresh `qualityGates` from that run.
3. Do not re-open PR7-F1/F2/F3 unless a new review fingerprint appears.
4. Do not merge, deploy, push `master`/`main`/`production`, or set `selectSiparisVerified` / rollout past the current off state.

## Failures

- None in the normalizer relative to PR7-F1/F2/F3.
- Local gates not re-executed: shell rejected.

## Blockers

| ID | Why |
|----|-----|
| `TICIMAX_WIRE_SOAP` | SelectSiparis QNames/namespaces stay deferred to live verification |
| `TICIMAX_LOCAL_GATES_SHELL` | This worker could not run `npm`/`npx`/`git`/`gh` |

Do not bypass `DEFERRED_TO_LIVE_PROVIDER_VERIFICATION`.
