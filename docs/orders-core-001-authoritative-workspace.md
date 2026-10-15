# ORDERS-CORE-001 — authoritative Orders workspace

Local delivery on `feat/orders-core-001-authoritative-fast-workspace`, based on
`7e5102d0b5901e3b372b45ed8ba6d7451ba48f22` (user-merged PR #24).
No production/provider access, migration, push, merge or deployment.
Validation closeout is recorded below and in `.ai/CURRENT_TASK.json`.

## Confirmed causes and behavior

| Concern | Before | After |
| --- | --- | --- |
| First entry | Auth bootstrap could paint `peekCachedOrders`; `OrdersPage` could project the pool before a workspace arrived. | Auth bootstrap starts empty. The mounted Orders consumer and exact query must match the workspace response key before the table appears. Until then the shell shows loading or a safe read error. |
| Return to Orders / changed filter | `shownWorkspaceRef` retained a previous operational snapshot. | A fresh consumer ID on remount, or a different query key, masks that snapshot. Same mounted/query background revalidation may keep its already validated view. |
| Pool overlay | App replaced workspace rows with matching pool objects, mixing old/optimistic operation fields with server counts and membership. | Only workspace items determine the visible rows and operation fields. Optional image enrichment uses the existing catalog and falls back to unchanged workspace items. |
| Manual refresh | Sync, count-only GET, potentially product sync/catalog reload, then workspace. | Exactly `POST /api/orders/sync` then `GET /api/orders/workspace` for an ordinary, otherwise idle refresh. No collection download, count GET or product sync. Concurrent canonical changes may require the one pending DB read. |
| Search debounce | The initial debounce assigned an equal-valued object, invalidating the workspace query memo and sometimes adding a GET during refresh. | Query memoization depends on the five search values. Equal text values do not request another page; real search changes retain the existing debounce. |
| Local label/archive actions | Local objects could change while workspace counts and membership stayed stale. | Successful canonical ready/printed/archive persistence notifies one DB-only revalidator. Current query membership and counts arrive without another user refresh. Create/track workflow completion also requests that same reader. |
| Print persistence failure | Print submission success could leave an optimistic PRINTED memory state and report success despite failed canonical persistence. | Print submission success remains reported, with a warning about persistence. The prior operational object is retained and the workspace remains authoritative. A successful READY write followed by failed PRINTED can only expose the DB's READY state. |
| Manual cargo handoff | Auth mode could claim a handoff that existed only in memory. | The existing auth action warns without changing status or making a request. There is no supported canonical manual-handoff write endpoint. Legacy behavior is preserved. |

"Barkod Bekliyor" and "Etiket Hazır" remain operation filters. The existing
"Yeni Siparişler" quick-tab semantics are unchanged; no bucket definitions were
rewritten to make transitions appear faster.

## State and scheduling contract

- `ordersWorkspace`: current server page, visible membership, total, tab counts,
  filter options and pagination. Auth mode cannot derive these from the pool.
- `canonicalOrderPool`: account-scoped in-session identity lookup for selection,
  off-page actions and detail navigation. Pooled cargo-to-order detail navigation
  remains covered by the existing real-App DOM tests.
- React `orders`: action/detail snapshot and optional presentation enrichment;
  legacy mode still uses its existing local projection.
- Provider sync: updates canonical server persistence. Page entry, filter changes
  and canonical-change revalidation only read `/api/orders/workspace`.

The revalidator has one running read and one pending bit. Same-turn requests share
a read; mutations during a read request one trailing read. Further commits during
that trailing read may require a later read, without building a queue or running
parallel workspace reads. It reads `workspaceQueryRef.current` when each read
starts. It releases the running slot before promise settlement so a commit in
that microtask interval cannot be lost.

Successful canonical writes invalidate earlier service read generations before
notification. Reads also capture account generation and deduplicate within that
generation. Stale responses cannot update the external-processing state, pool or
visible workspace. App checks request generation, account generation and consumer
identity. Account activation clears old workspace/pool state through the existing
config-save path; late archive responses cannot update the next account.

## Provider freshness audit — cadence retained

Evidence is the existing repository implementation and hermetic contracts:

- `server/marketplaces/trendyolStreamScheduler.ts`: default 15 minutes; explicit
  true/1 enablement; overlapping scheduler cycles are skipped. Resume requires a
  persisted cursor and the same filter fingerprint.
- `server/marketplaces/trendyolOrderStream.ts`: stream page limit 200, maximum
  window 14 days, history 90 days, minimum inter-page delay 5 seconds.
- `syncTrendyolStreamForOrganization` in `server/index.mjs`: an unfinished chain reuses
  its stored window. `NO_MORE_PAGES` starts a new recent window on the next cycle.
  Page persistence is account-scoped, incremental and non-reconciling.
- `POST /api/orders/sync` / `beginSyncFlight`: the existing server single-flight
  guard remains, as does the manual client double-click guard.
- `callTrendyolOrders`: manual paged reads retain bounded safe-GET retries,
  429 Retry-After handling, backoff and permanent-4xx rejection. Default retry
  delays remain 2/4/8 seconds with transient-error jitter. The stream callback
  uses `fetchTrendyolJson` directly; a failed page stops with `FETCH_FAILED` and
  preserves its resume cursor for a later run. No new stream retry was added.
- `test:runtime-memory`, status-sync and sync-resilience contracts exercise
  checkpoint/resume, overlap, partial results and retry boundaries offline.

The completed chain does not prove a cheap incremental tail. Increasing frequency
could repeatedly scan the recent window. There is no measured production request
budget or verified tail contract permitting a 60-second cadence, so cadence and
all production flags remain unchanged. This ticket improves local DB freshness;
it does not claim faster arrival of provider changes that have not been synced.

## Label latency audit — authority and intent retained

`src/providers/shipping/SuratKargoProvider.ts` calls the existing
`POST /api/shipments/surat/create` and consumes its shipment/carrier result. That
result is not the authoritative `ServerPrintContract` returned by
`GET /api/orders/:id/label` (`server/index.mjs` / `resolvePersistedLabel`).
`src/services/persistedLabelHydration.ts` intentionally fetches that contract even
when carrier source bytes are present, and strips client print sources when the
server denies printing. Skipping this GET would weaken provenance.

The create infrastructure is shared with the background label worker. Explicit
user activation is currently performed by `POST /api/orders/:id/label-ready` /
`markLabelReady` in `server/orders/orderPersistenceService.ts`. Background artifact
readiness alone must not set user activation. No new manual-intent contract or
atomic create/activation transaction is introduced here. Both that POST and
persisted-label hydration are retained. Reprints keep using persisted authority.

`SURAT_CREATE_CONCURRENCY` remains 2. No live carrier latency benchmark was run;
hermetic timing or fewer DB reads cannot establish Sürat network latency. No
second create path, uncertain-create retry, worker enablement or speculative
concurrency change was added. The existing UNKNOWN_AFTER_NETWORK regressions
remain required.

## Safe observability

New logs contain only these numeric/boolean scalars:

- `[orders-manual-refresh]`: `providerSyncMs`, `workspaceReloadMs`,
  `manualRefreshMs` (durations, not a claim about successful provider completion).
- `[orders-workspace]`: client `workspaceReloadMs` and existing server diagnostics
  `cacheHit`, `dbMs`, `projectionMs`; nonnumeric/unavailable diagnostics remain undefined.
- `[orders-label-persist]`: successful `labelReadyPersistMs` or
  `labelPrintedPersistMs` for the still-separate canonical writes.

Existing orchestrator preflight/lookup/create/hydrate/print/duration timings are
unchanged. The new logs include no order/customer identity, address, phone, raw
payload, ZPL or credential. No production latency improvement is claimed without
a controlled live measurement.

## Validation

| Gate | Result |
| --- | --- |
| New Orders DOM/service/coalescer | 23 passed |
| Focused package including existing cargo detail navigation | 28 passed |
| Full UI | 496 passed / 53 files |
| Performance acceptance | 55 passed |
| Runtime memory | 24 passed |
| Integration health | 53 passed |
| Billing party | 43 passed |
| Onboarding | 22 server + 13 UI passed |
| Affected existing server contracts | 72 passed |
| Full Sürat | 3,442 passed / 270 files / 7 batches |
| TypeScript: npx tsc -b --force | Passed |
| Lint | Passed; 0 errors / 6 pre-existing warnings |
| Build | Passed |
| git diff --check | Passed |

All test transports use synthetic fixtures/local services. Different-model
gpt-6-astra read-only review approved the implementation, pending-count guard
and equal-value debounce fix. Earlier failures exposed obsolete source-test
selectors and the duplicate-read debounce bug; both were corrected, with no
skips or weakened safety assertions. The final complete Sürat run exited 0.

## Changed files

Runtime:
`src/App.tsx`, `src/pages/OrdersPage.tsx`,
`src/services/orderWorkflowService.ts`,
`src/services/ordersWorkspaceRevalidation.ts`.

New focused tests:
`src/test/ordersCore.dom.test.tsx`, `src/test/ordersCoreService.test.ts`,
`src/test/ordersWorkspaceRevalidation.test.ts`.

Existing server source contracts updated to follow the shared DB reader and
consumer/query authority (behavioral safety assertions retained):
`server/account-scoped-loading-flow.test.mjs`,
`server/dashboard-order-display-flow.test.mjs`,
`server/live-order-projection-flow.test.mjs`,
`server/orders-sync-ondemand-flow.test.mjs`,
`server/orders-pagination-flow.test.mjs`,
`server/performance-acceptance-flow.test.mjs`,
`server/status-sync-contract-flow.test.mjs`,
`server/sync-resilience-flow.test.mjs`.
No new server test file, so suite registry additions are unnecessary.

Documentation/state:
this report, `.ai/tickets/ORDERS-CORE-001.md`, `.ai/CURRENT_TASK.json`,
`.ai/CURRENT_CONTEXT.md`, `.ai/HANDOFF.md`.

## Safety and remaining limits

No migration; no changes to production env/PM2/scheduler/worker activation,
shipping payer, carrier mapping, tenant authority, idempotency or uncertain-create
handling. No production order was read/retried; synthetic fixtures only. N11 epoch
verification and its checkpoint blocker remain untouched. This is local delivery;
hosted CI, live provider verification and production latency are not claimed.
