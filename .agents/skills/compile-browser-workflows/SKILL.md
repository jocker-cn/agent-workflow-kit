---
name: compile-browser-workflows
description: Compile a user's natural-language, multi-system browser process into optimized, resumable page transactions. Use when starting or revising a reusable Prompt workflow, when one page is mentioned across scattered Prompt steps, or when a cached workflow must be regenerated after its business flow changes.
---

# Compile Browser Workflows

Treat the Prompt as source code and the cached Workflow Recipe as a compiled artifact. Do not ask
the user to author nodes, selectors, YAML, or a business Skill.

## Compile

1. Extract run inputs, required outputs, business facts, conditions, policies, irreversible actions,
   authorization scope, and human checkpoints from the whole Prompt. Do not translate sentences
   one by one. Separate:
   - `risk`: impact of the operation;
   - `authorization`: whether the Prompt already authorizes its bounded scope;
   - `barrier`: whether execution must stop for runtime participation.
   An explicit instruction such as “submit `num` resources” is prompt authorization for that
   bounded batch, including generated values that satisfy the Prompt's constraints.
2. Work backwards from outputs and decisions to identify every required fact and its Web source.
   Classify each produced value:
   - `collects`: read from the visible page by a cached extract action;
   - `asserts`: proven by the successful transaction boundary, such as an authenticated landing
     page proving `session.authenticated=true`;
   - `computes`: deterministically derived from inputs or facts and executed locally.
3. Give each candidate transaction a page affinity: system, page kind, material page state,
   tab role, and variant.
4. Preserve hard ordering from data dependencies, explicit before/after rules, authentication,
   human checkpoints, context changes, and irreversible actions. Treat paragraph order as a soft
   hint.
   Do not introduce a confirmation barrier merely because an operation is irreversible.
   Use `authorization.mode=runtime` only when the Prompt requests review/approval or the operation
   requires authority beyond the Prompt's declared target, count, constraints, or environment.
5. Put all compatible reads and reversible actions for the same affinity into one candidate
   transaction. Split only at a navigation state that changes the affinity or at a declared
   barrier.
   Collect all later-needed fields before leaving the page.
6. For a same-route SPA mutation, insert one structured wait before dependent reads. Prefer a
   parameterized target that proves the requested business object is present, then require stable
   content for a short interval. Do not treat a prose postcondition as executable synchronization.
7. For lists and tables, bind the locator to the run input or fact with `hasTextFrom`; select an
   explicit cardinality. Use `strict` when exactly one match is a business invariant, `first` only
   when first-match semantics are intentional, and `nth` only when rank is the requested input.
8. Model a tab in `affinity.tab`. The executor re-identifies transaction entry across the browser
   context from page fingerprints. Add `switch-page` only directly after an action opens a tab
   inside the same transaction, not as a repair for lost focus between transactions.
9. Store workflow-specific descriptions in the compiler artifact fields. Keep this Skill limited
   to reusable compilation behavior.
10. Write the internal compiler JSON inside the project and run:

   ```bash
   pnpm compile -- --prompt-key <prompt-key> --file <compiler-json>
   ```

11. Inspect the compiler result. Learn or repair page actions against the generated transactions.
   The user must not maintain the compiler JSON.

Read [references/compiler-schema.md](references/compiler-schema.md) when constructing the compiler
artifact.

## Execute

Use one continuous invocation for a cached browser segment:

```bash
pnpm execute -- --run <run-id>
```

Do not return to the model between successful transactions. Continue until the executor reports a
declared human or runtime-confirmation barrier; missing routing facts; a cache mismatch; or the end of the
workflow segment. Cached decision and report nodes execute locally.

On `repair-required`, inspect only the failed transaction and relevant page region, repair or learn
that transaction, then resume:

```bash
pnpm execute -- --run <run-id> --from <failed-node-id>
```

Persist state at transaction boundaries, not after individual clicks or extracted fields.
