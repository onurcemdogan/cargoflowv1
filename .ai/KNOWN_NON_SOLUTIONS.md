# Known non-solutions

Do not:
- treat configured Sürat as historically verified;
- use provider secrets as store identity;
- trust client-authored carrier ZPL as server-authoritative artifact;
- infer RAW printer availability from printerName alone;
- assume all print pages are globally 100x100;
- refetch provider data merely to reprint;
- collapse account-scoped providers into provider-wide truth;
- let internal_test/shadow mutate live fulfillment;
- accept unsigned ikas webhook data;
- advance reconciliation checkpoints on partial pagination;
- burn LLM turns polling long-running tests.
