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

## Windows desktop execution

- Before automating a Windows desktop application, read
  `.agents/skills/winapp-ui-automation/SKILL.md` in full.
- Before compiling a multi-step desktop task, also read
  `.agents/skills/compile-desktop-workflows/SKILL.md` in full.
- Use only the repository-local WinAppCLI through `pnpm desktop`; do not depend on a global
  `winapp`, Winget installation, MCP server, or host-provided Computer Use capability.
- Execute a stable multi-action desktop transaction through `pnpm desktop:batch` instead of
  returning to the model after every successful click. Generate its declarative JSON only under
  `.workflow-runs/<run-id>`; it is run state, not a reusable script or Cache artifact.
- When consecutive desktop steps cross applications without a human or risk barrier, compile them
  into one multi-window desktop batch. Extract visible values and render downstream input inside
  the batch; do not return to the model merely to move data from one desktop app to another.
- For a resumable run, include the desktop transaction's workflow boundary mapping and commit the
  returned `.workflow-runs/<run-id>/last-boundary.json` once. Never checkpoint each desktop action.
- Target applications by process/title first and switch to an HWND when multiple windows match.
- Prefer UI Automation operations such as `invoke`, `set-value`, and `wait-for`. Use injected mouse
  or keyboard input only when the target control cannot be operated through UIA and the interactive
  desktop is unlocked.
- Prefer exact in-application search for a known named conversation, record, document, or menu item.
  Select the correct result category; use scrolling only when search is unavailable or positional
  browsing is part of the request.
- Preserve the user's window position and size unless the Prompt explicitly requests a change.
  Convert cached visual targets from normalized window-relative coordinates using the live UIA
  window rectangle. Never use screenshot-relative pixels as absolute Windows screen coordinates.
- On the fast path, capture at most one screenshot at the transaction boundary. Capture an
  additional screenshot only on failure or a declared human/visual boundary. Applications without
  usable UIA may require the model to review that one boundary screenshot.
- Let the desktop runner's default `activation.mode=auto` keep UIA-only transactions in the
  background. It restores and activates a window only for foreground-dependent mouse, wheel, or
  `send-input` actions. Use an explicit `restore` only when foreground visibility is itself part of
  the Prompt. For ad-hoc exploration use `pnpm desktop:window -- --hwnd <hwnd> --mode restore`.
  Never use `screenshot --focus` as a window-management operation; the project wrapper rejects it.
- Store durable screenshots only under `.workflow-runs/<run-id>/evidence/<transaction-id>/` and
  failed exploratory screenshots only under `.workflow-runs/<run-id>/diagnostics/<transaction-id>/`.
  Never place PNG files directly in the run root. The runner removes its transaction diagnostics
  after a later successful execution; Cache never contains screenshots.
- Treat desktop selectors like browser locators: discover them from the current UI, cache only stable
  AutomationIds or validated semantic selectors, and re-inspect the affected window when a cached
  selector or boundary check fails.
- Desktop support is optional and independent from browser execution. Do not route a browser task
  through WinAppCLI or change an existing Playwright workflow merely because WinAppCLI is installed.

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
- Treat counts and collections supplied at run time as parameters, never as compiler topology.
  Compile “repeat N times” as one transaction with `iteration.mode=repeat` and `countFrom`; compile
  “for each item” with `iteration.mode=foreach` and `itemsFrom`. Never create N nodes, N routes, or
  N scripts from the current value of `num` or an array length.
- Address the active item through `loop.index`, `loop.iteration`, `loop.item`, or the declared
  iteration aliases. Persist generated items before irreversible execution and resume from the
  saved `nextIndex`; do not regenerate an item after a failure.
- Derive loop data from the Prompt and current run, not from framework defaults. Runtime arrays
  supply `foreach` items directly. For `repeat`, put fields shared by every route in
  `iteration.generate` and put branch-only fields in `iteration.generateByRoute.<route-id>`.
  Resolve the route from structural run inputs before generating the item. Do not invent business
  constraints such as uniqueness, price ranges, or option sets unless the Prompt declares them.
- Treat a field rule explicitly supplied for the current task as a run override. Pass it through
  `workflow init --generation <node>.<route>.<field>.<setting>=<value>`. The run snapshots the
  effective generation profile, so later profile changes cannot alter an active batch. Unless the
  user says the rule is only for this run, successful completion promotes the override into the
  Prompt's shared defaults; use `--remember-generation false` for one-run rules.
- Materialize and validate the complete loop batch before the first irreversible iteration. A
  failure resumes from the persisted item and index; it must not regenerate the remaining batch.
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
- Loop completion automatically writes `executionSummary.<node-id>`. A separate report node should
  either compute declared outputs or use `reportFromLoop`; do not add an empty report node merely
  to mark the workflow complete.
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
- `.workflow-cache` has a strict canonical whitelist: compiled definitions belong only at
  `definitions/<prompt-key>/<prompt-hash>.json`, reusable page actions belong only at
  `pages/<prompt-key>/shared/<page-id>.json`, and remembered field defaults belong only at
  `profiles/<prompt-key>/defaults.json`. Every other file, including compiler drafts and otherwise
  declarative root JSON, is invalid. Reusable implementation belongs in `src`; run-specific JSON,
  materialized loop items, evidence, and executor-generated temporary files belong under
  `.workflow-runs/<run-id>`.
- Prefer `pnpm compile -- --prompt-key <prompt-key> --stdin true` and pipe the compiler artifact
  through stdin. If a diagnostic compiler file is necessary, keep it outside `.workflow-cache`
  and remove it after compilation. Use `pnpm cachectl clear --scope drafts` to preview legacy
  non-canonical artifacts at any cache depth and add `--apply true` only when they should be
  removed. Use `pnpm cachectl clear --scope orphans` to preview canonical cache directories whose
  Prompt file was removed.
- On a valid recipe and page-variant hit, execute the continuous cached browser segment through
  `pnpm execute -- --run <run-id>`. It executes successive page transactions, commits their
  resumable boundaries, resolves cached decision and report nodes locally, and stops only for a
  declared human or runtime-confirmation boundary, missing route fact, cache mismatch, or the end of the
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
  - retry transient loading or timing failures without changing cache only for read or reversible
    nodes; never automatically retry an irreversible node whose external result may be uncertain;
  - repair the locator candidate when business meaning is unchanged;
  - learn a new page variant when role, locale, tenant, or UI version changed;
  - learn a new guarded recipe route when a previously unseen business type appears;
  - version the affected recipe node when the business sequence itself changed.
- Never overwrite an old page variant merely because another tenant or role has a different layout. Never reuse a cached batch blindly for an irreversible or high-impact operation.
- Preview cache deletion with
  `pnpm cachectl clear --prompt-key <key> --scope <current|pages|profile|workflow>`.
  Add `--apply true` only after verifying the exact targets printed by the preview.

## Safety

- Do not guess business values or claim success without visible evidence.
- Treat an explicit Prompt instruction to create, submit, update, or repeat an external write as
  authorization for that action within the Prompt's declared target, count, and value constraints.
  `num=N` authorizes the complete bounded batch; generated values that remain inside declared
  rules do not require per-item confirmation.
- Keep `risk`, `authorization`, and `barrier` independent. Risk describes impact; authorization
  describes the approved scope; a barrier alone determines whether execution pauses.
- Compile an explicitly requested write with `authorization.mode=prompt`. Use
  `authorization.mode=runtime` and a risk barrier only when the Prompt asks for review or approval,
  when the exact action is outside the original authorization envelope, or when a materially
  different target, count, environment, or impact is discovered at runtime.
- Payments, production releases, approvals on behalf of another person, and other materially
  high-impact actions require runtime confirmation unless the current Prompt explicitly and
  unambiguously authorizes that exact bounded action.
- Record every submitted item's actual values and visible result as evidence. A valid prompt
  authorization does not become invalid merely because constrained random values were generated.
  Runtime confirmations remain invalidated when their reviewed facts, decisions, or outputs change.
- Treat the current prompt as the complete source of workflow-specific steps, facts, policies, expected results, and constraints.
- A new workflow requires no repository changes.
