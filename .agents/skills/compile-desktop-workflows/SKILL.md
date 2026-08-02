---
name: compile-desktop-workflows
description: Compile natural-language Windows desktop tasks into fast, resumable WinAppCLI transactions. Use for multi-step local desktop application workflows, cross-application desktop steps, UIA or screenshot-coordinate fallbacks, named-item search, scrolling, form entry, reading visible results, and workflows that must avoid a model round-trip after every click.
---

# Compile Desktop Workflows

Turn the whole Prompt into meaningful desktop transactions and run each stable transaction once
through `pnpm desktop:batch`. Do not translate Prompt sentences into separate shell calls.

## Compile

1. Extract applications, run inputs, required visible outputs, ordering constraints, user barriers,
   and authorized external writes from the complete Prompt.
2. Group adjacent work by application, window, material view state, and user barrier. Keep opening a
   known view, filling its fields, submitting it, and collecting its result in one transaction when
   no human or context boundary separates them.
3. Prefer interaction methods in this order:
   - stable UIA AutomationId or selector;
   - semantic text with an unambiguous UIA ancestor;
   - keyboard shortcut/navigation documented by the visible application;
   - cached window-relative coordinates with stable visual anchors;
   - screenshot-guided repair.
4. For a known named conversation, document, record, or menu item, prefer exact in-application
   search. Select the correct result category and require an exact semantic match. Use scrolling as
   a fallback when search is unavailable or the Prompt explicitly requests positional browsing.
5. Do not change window size or position unless the Prompt requires it. Use normalized coordinates
   relative to the current window; never copy screenshot pixels directly into screen coordinates.
6. Put run-varying content in run inputs or `valueFrom`. Use `env.NAME` for secrets and never place
   secret values in the transaction JSON.
7. Store the generated transaction at `.workflow-runs/<run-id>/`. It is run state, not a reusable
   script and not Cache content.

Read [references/transaction-schema.md](references/transaction-schema.md) when generating the
transaction JSON.

## Execute

Run one continuous transaction:

```bash
pnpm desktop:batch -- --run <run-id> \
  --file .workflow-runs/<run-id>/<transaction>.json
```

Use one boundary screenshot by default. Do not take screenshots between successful actions.
WinAppCLI command success is action telemetry; the final boundary is the business verification.
When the transaction belongs to a resumable run, include its `workflow` mapping in the generated
JSON, then commit the returned boundary once:

```bash
pnpm workflow commit --run <run-id> \
  --file .workflow-runs/<run-id>/last-boundary.json
```

If the transaction fails:

1. Stop at the returned `failure.actionId`.
2. Inspect only that window or relevant region.
3. Classify the failure as transient timing, stale UIA selector, changed window variant, incorrect
   result category, or stale relative geometry.
4. Repair the failed action or variant and resume from that transaction. Do not replay an
   irreversible action whose external result is uncertain.

## Typical boundaries

- Pause before a user-entered verification challenge, then continue the same run and window.
- Split when an action opens a materially different window or application unless the next window
  can be selected deterministically inside the batch.
- Treat sending messages, submitting forms, deleting data, and confirming dialogs according to the
  current Prompt's authorization. Do not invent an extra confirmation barrier.
- For applications without usable UIA, use one visual boundary screenshot. Let the model review
  that boundary once instead of checking every coordinate click.
