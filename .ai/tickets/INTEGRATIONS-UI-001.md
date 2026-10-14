# INTEGRATIONS-UI-001 — Standardize provider connection UI

Status: implemented locally, READY_FOR_USER_REVIEW. Branch:
`feat/integrations-ui-001-standardize-connections`; baseline after PR #21:
`891e8f9ef83e47cef56aa14bcf2e72780a55fb7d`.

The user selected a presentation-only integration refactor. Reuse current
CargoFlow Card/Badge/Alert/Field/button and light/dark tokens. HB, n11, WooCommerce,
ikas and Aras need consistent provider/account/form/action hierarchy. Carrier
routing and shipping payer remain separate settings concepts. Keep the existing
status board and categories; board clicks focus the actual provider management
surface. Trendyol/Sürat remain the visual benchmark with unchanged handlers.

Preserve all endpoints, credentials, OAuth returns, tenant authority, verification
and rollout/capability gates. No calls to providers on opening a panel. Existing
explicit Test/Sync/Save/Connect actions retain their handlers. HB unknown paths
fail closed; N11_EPOCH_SEMANTICS_UNVERIFIED/BLOCKED_EXTERNAL remain;
Aras internal_test production shipment/label paths remain closed. No production
access, migration, scheduler change, push or deploy.

Delivered shared pure presentation components, five provider refactors, separate
settings cards, accurate read-status badges, seven-provider board focus and
responsive wrapping. Aras's form is outside the general settings form to avoid
unrelated form submission. Seven provider/settings business statement prefixes
remain byte-identical to baseline. Backend runtime is unchanged.

All requested suites plus affected status/carrier/payer and new presentation/DOM
checks passed; tsc, lint (0 errors/6 existing warnings), build and diff check passed.
Different-model gpt-6-astra review APPROVED. Synthetic local light/dark desktop
and mobile previews verified; temporary harness removed. Local branch HEAD is
the delivery commit. User review is next; do not push until authorized.

Full inventory, provider before/after and tests:
[delivery report](../../docs/integrations-ui-001-connections.md).
