# Agent Workflow Kit

This repository executes browser workflows described directly in the user's current prompt.
The prompt is the workflow definition. Do not require the user to create a Skill, YAML contract,
configuration file, selector map, or project-specific script before starting.

## Browser execution

- Before browser work, read `.agents/skills/playwright-cli/SKILL.md` in full.
- Use only the repository-local CLI through `pnpm browser`.
- Keep one named browser session for the whole request.
- Do not use Codex Browser, browser MCP, host-level browser scripts, or files outside this repository.
- Follow the current business Prompt for credential entry, verification challenges, and human participation. Do not impose a repository-wide password or CAPTCHA policy.
- Do not inspect hidden network payloads.

## Interpreting prompts

- Before creating or revising a reusable Workflow Recipe, read
  `.agents/skills/compile-browser-workflows/SKILL.md` in full and follow it.
- Treat the whole Prompt as source code. Compile it into business facts, outputs, policies, hard
  constraints, barriers, and page transactions before browser execution; do not turn sentences
  into commands one by one.
- Prompt paragraph order is a soft hint. Preserve explicit ordering, data dependencies,
  authentication, human checkpoints, context changes, and irreversible operations as hard
  constraints.
- Group compatible work by system, page kind, material page state, tab role, and variant. If the
  Prompt mentions fields from the same stable page in different places, collect their union during
  one page transaction.
- Classify every produced value as exactly one of: page `collects`, boundary `asserts`, or local
  `computes`. Never manually add a fact that the compiled transaction declares as produced.
- Store workflow-specific explanatory text in the compiled Workflow fields (`description`,
  facts, policies, transaction operations). Do not put business descriptions into this file or a
  reusable Skill.
- Infer routine browser actions from the current UI; do not ask the user for selectors, refs, or command syntax.
- Let visible labels and page state determine how to interact when the UI differs from the prompt.
- Report ambiguity only when it changes business meaning, creates risk, or cannot be resolved from the page.
- Present results in the format requested by the user. If no format is requested, return a concise readable summary.

## State and human checkpoints

- For every multi-system or resumable workflow, maintain a local run through `pnpm run workflow --`. This is internal Agent behavior and must not add setup work for the user.
- Treat every execution as a separate run. Never reuse a previous run for a different order, ticket, service, environment, branch, customer, or other business object.
- Extract values that vary between executions from the current prompt and save them as immutable run inputs, for example `--input order.id=A` or `--input service=payment`.
- Start a run with `pnpm run workflow -- init`. Save a concise summary plus an `--intent` that preserves the workflow rules needed by a future Agent session. Use `--workflow-name` for the reusable workflow identity. When invoked from a Prompt file, associate the run through its shell-safe `--prompt-key`.
- Use the run id as the Playwright browser session name.
- Instantiate the run plan from the cached recipe when it is ready. On first learning, compile the
  complete Prompt through `pnpm compile` into meaningful page transactions; do not record
  individual clicks or Prompt sentences as plan steps.
- Save state once per meaningful business boundary with `pnpm run workflow -- commit --file <json>`. One commit may contain step updates, facts, decisions, outputs, evidence, the recovery cursor, selected recipe routes, and timing. Do not issue a separate process for every fact or output.
- When an observed fact selects a conditional route, resolve it deterministically from the cached route guards. Ask the model to plan only when a route is unknown or ambiguous.
- A decision or report transaction must calculate and commit its declared facts and outputs before
  it is marked complete. Do not replace deterministic local computation with separate `fact`,
  `decision`, `output`, or `complete` commands.
- Save a boundary before a long wait or risky action. It must identify the current step, next action, current Web system, and last useful URL.
- Never copy inputs, facts, decisions, or outputs from another run unless the current prompt explicitly requires it.
- When recovering without conversation context, select the run by its business inputs. Do not assume the most recently updated run is the intended one when multiple runs could match.
- Read `pnpm run workflow -- context --run <run-id>` before continuing. Re-observe the current browser page because stored element refs and prior page assumptions are not resumable state.
- When the business Prompt requires a human checkpoint, preserve the same run and browser session. Record the expected observable condition with `pause --until`, wait with the official Playwright CLI, call `resume`, and continue automatically.

## Prompt-scoped cache

- For a reusable Prompt file, run `pnpm run cachectl -- list`, select the matching Prompt, and use its shell-safe key with `pnpm run cachectl -- prepare --prompt-key <key>` before planning or browser exploration. When the workspace has exactly one Prompt, selection may be omitted.
- If `prepare` reports `uncompiled` or `needs-recompile`, compile the complete Prompt with the
  Workflow Compiler Skill before normal execution. A legacy click-oriented Recipe is not a valid
  continuous fast path.
- Workflow definitions are versioned by Prompt file identity plus content hash. Stable page actions are
  shared across content versions of the same Prompt file, but never across different Prompt files.
  Different run inputs for the unchanged Prompt reuse both layers.
- Treat the definition as a parameterized Workflow Recipe, not a transcript of one run. Cache ordered business nodes with `recipe-node` and locally guarded routes with `recipe-route`.
- Keep high-cardinality instance values such as order ids, ticket ids, resource names, and branches in run inputs. Put only values that change execution structure, such as order type or environment, in a route's `--when` guards.
- Declare each node's routing dependencies with `--depends-on`. Resolve a run with `recipe-resolve --value key=value`. A `ready` result is executable; `needs-facts` means observe only the missing facts; `needs-learning` or `ambiguous` returns control to the model for that node only. Never execute another route as a fallback for an unknown value.
- Page caches store named variants. A variant represents a material UI context such as role, locale, tenant, or page version, and contains a fingerprint, semantic actions, locator candidates, postconditions, and result telemetry. They must not store snapshot refs, live DOM nodes, credentials, verification values, cookies, tokens, or run-specific business values.
- On a valid recipe and page-variant hit, execute the continuous cached browser segment through
  `pnpm execute -- --run <run-id>`. It executes successive page transactions, commits their
  resumable boundaries, resolves cached decision and report nodes locally, and stops only for a
  human or unconfirmed risk boundary, missing route fact, cache mismatch, or the end of the
  segment. Do not return to the model between successful transactions.
- Use `pnpm run recipe -- --run <run-id> --node <node-id>` only to learn, test, repair, or resume a
  single failed transaction.
- The Recipe Runner waits for the next cached page fingerprint after SPA navigation. On retry it detects the current matching page group and resumes there, skipping earlier navigation groups. Do not manually force the browser back to a route's first page when a later cached page already matches.
- After a same-URL action that refreshes asynchronous content, cache a structured `wait` action
  before extracting or clicking results. Free-text `postcondition` is documentation, not an
  executable wait.
- Parameterize repeated result locators with the current run input or fact (`hasTextFrom`) and an
  explicit cardinality (`strict`, `first`, or `nth`). Do not cache a broad row locator whose meaning
  depends on result ordering.
- When an action opens a new tab, learn a `page/switch-page` action with a stable URL glob and tab
  role. The Runner selects it from the existing browser context and subsequent page groups continue
  on that tab without returning to the model.
- At transaction entry, rely on the transaction affinity and cached page fingerprint to identify
  the correct page across all open tabs. Do not prepend a source-page switch workaround merely
  because a previous executor invocation focused another tab. Collect all required source-page
  fields before an action that leaves or switches that page.
- After a successful recipe node, commit its generated `.workflow-runs/<run-id>/last-boundary.json` with one `workflow commit`. Do not call `page-show`, `action-result`, `fact`, `decision`, or `output` separately for every action or field on a successful fast path. Use `action-result-batch` only when browser work could not run through the recipe runner.
- Prefer cached user-facing Playwright locators. Use a scoped CSS locator when the page lacks usable
  semantics. A non-semantic custom widget may use a cached `x,y` vision click only when the viewport
  and visual anchors match.
- Do not pre-check and post-check every cached click or fill. Validate once at page entry when the variant is uncertain and once at the business boundary. Use screenshots or targeted checks only for evidence, branching, or recovery.
- If a cached batch fails or its boundary postcondition is false: stop at the failed action, record the batch failure, take a screenshot, and inspect only the relevant page region. Classify the failure before updating cache:
  - retry transient loading or timing failures without changing cache;
  - repair the locator candidate when business meaning is unchanged;
  - learn a new page variant when role, locale, tenant, or UI version changed;
  - learn a new guarded recipe route when a previously unseen business type appears;
  - version the affected recipe node when the business sequence itself changed.
- Never overwrite an old page variant merely because another tenant or role has a different layout. Never reuse a cached batch blindly for an irreversible or high-impact operation.
- Preview cache deletion with `pnpm cachectl clear --prompt-key <key> --scope <current|pages|workflow>`.
  Add `--apply true` only after verifying the exact targets printed by the preview.

## Safety

- Do not guess business values or claim success without visible evidence.
- Before an irreversible or high-impact action such as submitting a CR, publishing, approving, paying, or starting a production release, show the pending result and obtain explicit user confirmation in the current conversation.
- Record confirmation only after the user confirms the exact pending action. Facts, decisions, or outputs changed after confirmation invalidate that confirmation and require a new review.
- Treat the current prompt as the complete source of workflow-specific steps, facts, policies, expected results, and constraints.
- A new workflow requires no repository changes.
