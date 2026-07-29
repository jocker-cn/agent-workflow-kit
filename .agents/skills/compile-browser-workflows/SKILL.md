---
name: compile-browser-workflows
description: Compile a user's natural-language, multi-system browser process into optimized, resumable page transactions. Use when starting or revising a reusable Prompt workflow, when one page is mentioned across scattered Prompt steps, or when a cached workflow must be regenerated after its business flow changes.
---

# Compile Browser Workflows

Treat the Prompt as source code and the cached Workflow Recipe as a compiled artifact. Do not ask
the user to author nodes, selectors, YAML, or a business Skill.

## Compile

1. Extract run inputs, required outputs, business facts, conditions, policies, irreversible actions,
   and human checkpoints from the whole Prompt. Do not translate sentences one by one.
2. Work backwards from outputs and decisions to identify every required fact and its Web source.
3. Give each candidate transaction a page affinity: system, page kind, material page state,
   tab role, and variant.
4. Preserve hard ordering from data dependencies, explicit before/after rules, authentication,
   human checkpoints, context changes, and irreversible actions. Treat paragraph order as a soft
   hint.
5. Put all compatible reads and reversible actions for the same affinity into one candidate
   transaction. Split only at a navigation state that changes the affinity or at a declared
   barrier.
6. Store workflow-specific descriptions in the compiler artifact fields. Keep this Skill limited
   to reusable compilation behavior.
7. Write the internal compiler JSON inside the project and run:

   ```bash
   pnpm compile -- --prompt-key <prompt-key> --file <compiler-json>
   ```

8. Inspect the compiler result. Learn or repair page actions against the generated transactions.
   The user must not maintain the compiler JSON.

Read [references/compiler-schema.md](references/compiler-schema.md) when constructing the compiler
artifact.

## Execute

Use one continuous invocation for a cached browser segment:

```bash
pnpm execute -- --run <run-id>
```

Do not return to the model between successful transactions. Continue until the executor reports a
human or unconfirmed risk barrier; missing routing facts; a cache mismatch; or the end of the
workflow segment. Cached decision and report nodes execute locally.

On `repair-required`, inspect only the failed transaction and relevant page region, repair or learn
that transaction, then resume:

```bash
pnpm execute -- --run <run-id> --from <failed-node-id>
```

Persist state at transaction boundaries, not after individual clicks or extracted fields.
