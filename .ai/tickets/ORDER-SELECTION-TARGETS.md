# Additional UX change — Order selection targets

Continue on feat/single-marketplace-account-001-trendyol after local commit
5c2374b35a61f8d49ed772a25e7fe5ecdb7d3a91. No push, merge or deploy.

Preserve the table layout, existing controlled selection/bulk callbacks,
filtering and pagination. Keep checkboxes. Make only the primary product image,
title and variant/barcode area toggle its row selection. Same target toggles off.
Reuse the selected-row theme. Expand, detail, overflow and other actions must
not select. No whole-row click, Shift-click or new bulk toolbar.

Enlarge the header checkbox target and link a visible adjacent label to the
same select-all control. Text: Tümünü seç at zero; N/M seçildi for partial/all
visible selections. Count only visible rows, preserving off-page selections.

DOM regressions must cover product select/deselect, checkbox synchronization,
detail/overflow/expand isolation, label-driven select/deselect all, and accurate
zero/partial/all-visible counts. Include keyboard access and empty-page behavior.

## Local delivery

COMPLETE / READY_FOR_USER_REVIEW. Independent gpt-6-astra review APPROVED.
16 new DOM tests; focused+filter18, UI473/50 files, related node65 pass.
TypeScript force/lint/build/diff pass; lint0 errors/6 existing warnings.
Synthetic light/dark QA verified 44px target, aligned checkbox column and
partial/all/none counts. Temporary preview removed. No provider/backend,
pagination/filtering or operational changes. No push/merge/deploy.

Files: src/components/OrdersTable.tsx, src/index.css,
src/test/orderSelectionTargets.dom.test.tsx, .ai/CURRENT_TASK.json,
.ai/CURRENT_CONTEXT.md, .ai/HANDOFF.md, this ticket.
