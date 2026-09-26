# DevFactory handoff

Ticket: TICIMAX-001
Status: **REVIEW_FEEDBACK** (PR #7 findings addressed in tree; local gates pending)
Branch: `agent/TICIMAX-001`
HEAD (branch ref per shift context): `4233ab12dc11790e7f22534aff226b24bf834433` — `wip(TICIMAX-001): checkpoint claude`
Prior checkpoints: `ab9fdb2` (review-feedback-claude), `d212ad7` (superseded)
Baseline: `8a91c6ec4e5e996956a432fe8f86953d82d4c2b3`
Spec: `.ai/tickets/TICIMAX-001.md`
Last worker: cursor
Scope: `DEFER_TO_LIVE_PROVIDER_VERIFICATION` — no invented SelectSiparis SOAP wire

## Git state (reconstructed)

- Branch tip ref: `4233ab12dc11790e7f22534aff226b24bf834433`
- Working tree (shift context): only `.ai/CURRENT_CONTEXT.md`, `.ai/CURRENT_TASK.json` dirty
- Implementation files for PR #7 repair: `server/connectors/ticimax/ticimaxOrderNormalizer.ts`, `server/ticimax-connector-flow.test.mjs` (TICIMAX-8 / TICIMAX-8b)
- Attributed review paths unchanged this pass: `ticimaxClient.ts`, `ticimaxWireGate.ts` (wire gate / fail-closed SOAP — no alias/date/decimal logic)

Shell (`git` / `npm` / `npx` / `gh`): **Rejected** in this Cursor worker session — gates not re-run here.

## External review findings → evidence (PR #7)

| ID | Finding | Pack / rule | Fix |
|----|---------|-------------|-----|
| PR7-F1-ALIASES | Guessed order field aliases (`SiparisTarihi`, `OrderDate`, `ToplamTutar`, `ParaBirimi`, …) | `ORDER_MODEL.knownFields` only (8 fields) | `normalizeTicimaxOrder` maps **only** `TICIMAX_KNOWN_ORDER_FIELDS`; `orderDate`, `totalDecimal`, `currency` stay **null**; alias keys only in `rawOrder` |
| PR7-F2-OFFSETLESS-DATE | Offset-less timestamps → bogus UTC via `Date.parse` | `DATE_TIMEZONE_RULES.DECISION` — not guessed; canonical conversion off | `ticimaxDateToInstant` returns `instant: null` without trailing `Z` or `±HH:MM`; normalize does not read date fields |
| PR7-F3-DECIMAL | `ticimaxDecimalString` accepted invalid decimals | Strict decimal when helper used; no money field mapping until verified | Invalid strings (e.g. `119,99`, `not-a-number`) → **null**; `^-?\d+(\.\d+)?$` preserved |

**Preserved:** `TICIMAX_WIRE_CONTRACT.selectSiparisVerified=false`, `ticimaxWireGate.ts` defer reason, rollout off, live write gate blocked.

## Commands (human / next worker with shell)

```bash
npm run test:ticimax
npx tsc -b --force
npm run lint
```

Optional: refresh `.ai/.runtime/quality-gates.json` after the above; `gh run list --branch agent/TICIMAX-001` after push.

## Exact next action

1. Run the three commands above; fix any failure.
2. If branch is behind remote or review fixes are not on pushed tip, push `agent/TICIMAX-001` only (no protected branches).
3. Update `CURRENT_TASK.json` `qualityGates` + `headCommit` from fresh `git rev-parse HEAD`.
4. Set `status: READY_FOR_REVIEW` when CI is green on that commit and PR #7 findings are verified on the PR diff.
5. Do **not** merge, deploy, or flip rollout / wire verification.

## Blockers

| ID | Why |
|----|-----|
| `TICIMAX_WIRE_SOAP` | SelectSiparis QNames/namespaces deferred to live verification |
| `TICIMAX_LOCAL_GATES_SHELL` | Worker shell rejected — gates must be run locally |

Do not bypass `DEFERRED_TO_LIVE_PROVIDER_VERIFICATION`.
