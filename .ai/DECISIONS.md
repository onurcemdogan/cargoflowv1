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
