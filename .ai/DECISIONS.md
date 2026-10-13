# Durable decisions

- Repo/git state is shared memory; agent chats are not.
- One worker per worktree.
- Builder cannot self-approve.
- Production remains human-controlled.
- Provider truth comes from verified contracts.
- internal_test/shadow cannot mutate live fulfillment.
- ikas webhook remains disabled until a verifiable signature contract exists.
- Product Tour is UX preference, not onboarding truth.
- With Surat + Aras both enabled, empty `cargoProviderName` does not default to Surat; create/print preflight requires an explicit carrier assignment (fail-closed ambiguity).
- Aras `internal_test` account scope uses `marketplace_accounts` + `connector_credentials` (provider `aras`); `UserName`/`Password` are never `providerAccountId`.
- Provider verification is per capability: no credential != development blocked; missing evidence blocks only the capability that depends on it. `IMPLEMENTATION_COMPLETE` needs no real account; `LIVE_VERIFIED` is operational verification, never a prerequisite for implementing or starting the next provider (see `.ai/QUALITY_GATES.md` > Provider verification standard).
- A missing fact may block progress only if it risks tenant/account bleed, duplicate or wrong fulfillment, an irreversible write, a money/billing error, permanent data loss, credential exposure or wrong provider routing; everything else is a warning or deferred verification item.
