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
6. Compile run-time repetition parametrically:
   - use `iteration.mode=repeat` with `countFrom` for “perform N times”;
   - use `iteration.mode=foreach` with `itemsFrom` for collections;
   - use `loop.item` in cached actions and keep the compiled node count invariant for every run;
   - use declarative `iteration.generate` only for fields common to every route;
   - use `iteration.generateByRoute.<route-id>` for fields needed only by one structural branch.
   Runtime arrays supply `foreach` items directly. For `repeat`, the executor selects the route
   from run inputs, deterministically creates the route-shaped item, and persists it so retries
   reuse it. Do not invent uniqueness, value ranges, choices, or other business rules that are not
   present in the Workflow Prompt.
   Never unroll a current `num` into numbered nodes or routes, and never create parameter-specific
   orchestration scripts.
   Separate the three sources of generation behavior:
   - the compiled generator is the Prompt's stable structural rule;
   - the Prompt-scoped Defaults Profile remembers successful field preferences across runs;
   - the Run Overlay contains explicit rules for the current task and wins over remembered
     defaults.
   Pass current-task rules at run creation with repeated
   `--generation <node>.<route>.<field>.<setting>=<value>`. Use
   `--remember-generation false` only when the user says the rule is temporary. The executor
   snapshots the effective profile and materializes the complete batch before its first
   irreversible write.
7. For a same-route SPA mutation, insert one structured wait before dependent reads. Prefer a
   parameterized target that proves the requested business object is present, then require stable
   content for a short interval. Do not treat a prose postcondition as executable synchronization.
8. For lists and tables, bind the locator to the run input or fact with `hasTextFrom`; select an
   explicit cardinality. Use `strict` when exactly one match is a business invariant, `first` only
   when first-match semantics are intentional, and `nth` only when rank is the requested input.
9. Model a tab in `affinity.tab`. The executor re-identifies transaction entry across the browser
   context from page fingerprints. Add `switch-page` only directly after an action opens a tab
   inside the same transaction, not as a repair for lost focus between transactions.
10. Store workflow-specific descriptions in the compiler artifact fields. Keep this Skill limited
   to reusable compilation behavior.
11. Prefer streaming the internal compiler JSON without creating a draft:

   ```bash
   <producer> | pnpm compile -- --prompt-key <prompt-key> --stdin true
   ```

   For diagnostics only, `--file <compiler-json>` is supported when the file is outside
   `.workflow-cache`; remove the file after compilation.
12. Inspect the compiler result. Learn or repair page actions against the generated transactions.
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
For iteration nodes, the executor first persists all materialized items, then records the result
and `nextIndex` after every iteration. Completion automatically stores
`executionSummary.<node-id>` with counts, timing, distributions, and policy checks. Use
`reportFromLoop` only when an explicit report transaction must expose that summary; do not compile
an empty report transaction.
Resume the same node; do not generate a recovery script or expand the remaining indexes.
Automatic transient retries are limited to read or reversible nodes. An irreversible failure
returns to the Agent for visible-result reconciliation before another execution is started.

Treat `.workflow-cache` as strict canonical storage. The only valid files are compiled definitions
under `definitions/<prompt-key>/<prompt-hash>.json` and shared page actions under
`pages/<prompt-key>/shared/<page-id>.json`, plus remembered field defaults under
`profiles/<prompt-key>/defaults.json`. Compiler drafts, root JSON, executables, and orchestration
files are invalid even when temporary. Executor-created temporary Playwright files belong to the
run directory and are removed automatically. Preview legacy cache drafts with
`pnpm cachectl clear --scope drafts`; the preview includes non-canonical artifacts at any cache
depth. Remove them with the same command plus `--apply true`.
Preview canonical cache directories whose Prompt source file no longer exists with
`pnpm cachectl clear --scope orphans`.
