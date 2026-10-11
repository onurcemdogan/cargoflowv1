# Multi-Agent Engineering Contract

This file is authoritative for Claude, Cursor, Codex, and future workers.

## Prime directive
DO NOT ASSUME. PROVE IT FIRST.

## Startup
Read, in order:
1. AGENTS.md
2. .ai/PROJECT_SPEC.md
3. .ai/ACCEPTED_FOUNDATION.md
4. .ai/ROADMAP.md
5. .ai/CURRENT_TASK.json
6. .ai/CURRENT_CONTEXT.md
7. .ai/HANDOFF.md
8. the active ticket

Then inspect git root, remote, branch, status, recent log and diff before editing.

## Shared memory
- Chat history is disposable; repository state is authoritative.
- Exactly one worker per worktree.
- Claude/Cursor/Codex continue the SAME ticket branch.
- Do not start the next roadmap ticket unless the supervisor selects it.
- Before normal exit, update CURRENT_TASK.json and HANDOFF.md.
- After abnormal exit, next worker reconstructs from git + logs + recovery snapshot.

## Git
- Protected: master, main, production.
- No direct protected-branch push. No force push. No production deploy.
- Ticket branches: agent/<TICKET-ID>.
- Merge target: integration/roadmap.
- Builder cannot self-approve; review uses a different model.
- Never reset/clean/delete unfamiliar changes.

## Engineering loop
Baseline → forensic inspection → reproduction → root cause → minimal patch → targeted regression → mutation proof when required → gates → handoff/state → checkpoint/push → different-agent review → CI → integration merge.

## Test rules
Never weaken tests for green. No hidden skip/todo. Long test waits are process-level, not LLM polling. Diagnose stalls via PID/CPU/log timestamp/current batch/tail; never kill unrelated processes.

## Security
Never log/commit secrets, tokens, PII, raw auth headers or decrypted provider payloads. Never invent provider contracts, bypass rollout/tenant gates, disable TLS validation or deploy production.

## Source hierarchy
1. active ticket
2. accepted foundation/ADRs
3. current code/tests
4. verified provider contracts
5. handoff/context
6. chat memory
