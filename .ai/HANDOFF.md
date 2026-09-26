# DevFactory handoff

Ticket: TICIMAX-001
Status: **REVIEW_FEEDBACK_REPAIR** (uncommitted normalizer fix on disk)
Branch: `agent/TICIMAX-001`
HEAD (committed): `ab9fdb24252f3cc93dd231752cdc6bab96cba1b8` — `wip(TICIMAX-001): checkpoint review-feedback-claude`
Prior stale metadata: `d212ad7` (superseded by `ab9fdb` on branch ref)
Baseline: `8a91c6ec4e5e996956a432fe8f86953d82d4c2b3`
Spec: `.ai/tickets/TICIMAX-001.md`
Last worker: cursor
Scope: `DEFER_TO_LIVE_PROVIDER_VERIFICATION` — no invented SelectSiparis SOAP wire

## Git state (reconstructed)

- Branch tip ref: `ab9fdb24252f3cc93dd231752cdc6bab96cba1b8`
- **Uncommitted** (this session):
  - `server/connectors/ticimax/ticimaxOrderNormalizer.ts` — PR #7 review repair (3 findings)
  - `server/ticimax-connector-flow.test.mjs` — TICIMAX-8 + TICIMAX-8b regressions
  - `.ai/CURRENT_TASK.json`, `.ai/HANDOFF.md`

Shell (`git` / `npm` / `npx` / `gh`): **Rejected** in Cursor worker session — local gates not re-run here.

## External review findings → evidence (PR #7)

| # | Finding | Pack / rule | Fix (current working tree) |
|---|---------|-------------|----------------------------|
| 1 | Guessed SOAP/order field aliases (`SiparisTarihi`, `OrderDate`, `ToplamTutar`, `ParaBirimi`, …) | `ORDER_MODEL.knownFields` only (8 fields) | `normalizeTicimaxOrder` maps **only** those fields; `orderDate`, `totalDecimal`, `currency` stay **null**; unverified keys remain only in `rawOrder` |
| 2 | Offset-less timestamps converted via `Date.parse` → bogus UTC instants | `DATE_TIMEZONE_RULES.DECISION` = not guessed; canonical conversion off | `ticimaxDateToInstant` returns `instant: null` when no trailing `Z` or `±HH:MM`; normalize does not read date fields |
| 3 | `ticimaxDecimalString` accepted non-decimal strings | `MONEY_RULES` unverified; absence = null | Invalid strings (e.g. `119,99`) → **null**; valid `\d+(\.\d+)?` preserved |

**Preserved:** `TICIMAX_WIRE_CONTRACT.selectSiparisVerified=false`, rollout `off`, live write gate blocked, `DEFERRED_TO_LIVE_PROVIDER_VERIFICATION` markers untouched.

## Exact next action

1. On `agent/TICIMAX-001`, commit normalizer + test changes (when authorized).
2. Run and record:
   ```bash
   npm run test:ticimax
   npx tsc -b --force
   npm run lint
   ```
3. Push ticket branch only; `gh run list --branch agent/TICIMAX-001` for CI on new commit.
4. Update `.ai/CURRENT_TASK.json` `headCommit` + `qualityGates` from fresh logs.
5. Do **not** merge, deploy, or flip rollout / wire verification.

## Completed criteria (unchanged scaffold)

Under `server/connectors/ticimax/` — endpoint, identity, wireGate, writeGuard, client, connection, pagination, sync; hermetic tests; `test:ticimax`.

## Blockers

| ID | Why |
|----|-----|
| `TICIMAX_WIRE_SOAP` | SelectSiparis QNames/namespaces deferred to live verification |
| `TICIMAX_LOCAL_GATES_SHELL` | Worker shell rejected — human must run gates after commit |

Do not bypass `DEFERRED_TO_LIVE_PROVIDER_VERIFICATION`.
