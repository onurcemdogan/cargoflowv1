# CargoFlow roadmap

## CLOSED
Connector Kernel → Contract Packs → Integration Health → Subscription → Shipping Billing Party → WooCommerce-001 → Print Platform-001 → Onboarding-001 → Catalog-001 → Product Tour-001 → Landing-001 → IKAS-001 → TICIMAX-001 → ARAS-EXPANSION.

## ACTIVE
None auto-selectable from `ROADMAP.json`; the queued items below wait on a human gate. Provider implementation tickets (e.g. HEPSIBURADA-LIVE-001, N11-LIVE-001) are supervisor-selected and do not depend on them.

## QUEUED
1. LIVE-PROVIDER-VERIFICATION — BLOCKED_HUMAN (real provider credentials).
2. PILOT-HARDENING — WAITING.
3. PRODUCTION-READINESS — WAITING.
4. PRODUCTION-ROLLOUT — HUMAN_APPROVAL.

## Verification policy
LIVE-PROVIDER-VERIFICATION is operational verification, not an implementation prerequisite: it blocks only `LIVE_VERIFIED` status and the pilot capabilities that depend on it, and its scope is the capabilities the pilot actually uses. See `.ai/QUALITY_GATES.md` → Provider verification standard.
