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

- Convert the user's natural-language steps into an internal checklist and execute them in order.
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
- Instantiate the run plan from the cached recipe when it is ready. On first learning, convert the Prompt into meaningful business nodes; do not record individual clicks as plan steps.
- Save state once per meaningful business boundary with `pnpm run workflow -- commit --file <json>`. One commit may contain step updates, facts, decisions, outputs, evidence, the recovery cursor, selected recipe routes, and timing. Do not issue a separate process for every fact or output.
- When an observed fact selects a conditional route, resolve it deterministically from the cached route guards. Ask the model to plan only when a route is unknown or ambiguous.
- Save a boundary before a long wait or risky action. It must identify the current step, next action, current Web system, and last useful URL.
- Never copy inputs, facts, decisions, or outputs from another run unless the current prompt explicitly requires it.
- When recovering without conversation context, select the run by its business inputs. Do not assume the most recently updated run is the intended one when multiple runs could match.
- Read `pnpm run workflow -- context --run <run-id>` before continuing. Re-observe the current browser page because stored element refs and prior page assumptions are not resumable state.
- When the business Prompt requires a human checkpoint, preserve the same run and browser session. Record the expected observable condition with `pause --until`, wait with the official Playwright CLI, call `resume`, and continue automatically.

## Prompt-scoped cache

- For a reusable Prompt file, run `pnpm run cachectl -- list`, select the matching Prompt, and use its shell-safe key with `pnpm run cachectl -- prepare --prompt-key <key>` before planning or browser exploration. When the workspace has exactly one Prompt, selection may be omitted.
- Cache scope is the Prompt file identity plus its content hash. Different Prompt files and different versions of one Prompt never share definitions or page actions. Different run inputs for the unchanged Prompt reuse the same cache.
- Treat the definition as a parameterized Workflow Recipe, not a transcript of one run. Cache ordered business nodes with `recipe-node` and locally guarded routes with `recipe-route`.
- Keep high-cardinality instance values such as order ids, ticket ids, resource names, and branches in run inputs. Put only values that change execution structure, such as order type or environment, in a route's `--when` guards.
- Declare each node's routing dependencies with `--depends-on`. Resolve a run with `recipe-resolve --value key=value`. A `ready` result is executable; `needs-facts` means observe only the missing facts; `needs-learning` or `ambiguous` returns control to the model for that node only. Never execute another route as a fallback for an unknown value.
- Page caches store named variants. A variant represents a material UI context such as role, locale, tenant, or page version, and contains a fingerprint, semantic actions, locator candidates, postconditions, and result telemetry. They must not store snapshot refs, live DOM nodes, credentials, verification values, cookies, tokens, or run-specific business values.
- On a valid recipe and page-variant hit, execute one business node through `pnpm run recipe -- --run <run-id> --node <node-id>`. It compiles all safe cached actions into one official Playwright `run-code` call, applies local actionability waits, validates the business-boundary expectation, and records action timings. Do not return to the model between successful actions.
- The Recipe Runner waits for the next cached page fingerprint after SPA navigation. On retry it detects the current matching page group and resumes there, skipping earlier navigation groups. Do not manually force the browser back to a route's first page when a later cached page already matches.
- After a successful recipe node, commit its generated `.workflow-runs/<run-id>/last-boundary.json` with one `workflow commit`. Do not call `page-show`, `action-result`, `fact`, `decision`, or `output` separately for every action or field on a successful fast path. Use `action-result-batch` only when browser work could not run through the recipe runner.
- Prefer cached user-facing Playwright locators. Use a scoped CSS locator when the page lacks usable semantics. Use screenshot-guided vision actions for non-semantic custom widgets when the viewport and visual anchors match.
- Do not pre-check and post-check every cached click or fill. Validate once at page entry when the variant is uncertain and once at the business boundary. Use screenshots or targeted checks only for evidence, branching, or recovery.
- If a cached batch fails or its boundary postcondition is false: stop at the failed action, record the batch failure, take a screenshot, and inspect only the relevant page region. Classify the failure before updating cache:
  - retry transient loading or timing failures without changing cache;
  - repair the locator candidate when business meaning is unchanged;
  - learn a new page variant when role, locale, tenant, or UI version changed;
  - learn a new guarded recipe route when a previously unseen business type appears;
  - version the affected recipe node when the business sequence itself changed.
- Never overwrite an old page variant merely because another tenant or role has a different layout. Never reuse a cached batch blindly for an irreversible or high-impact operation.

## Safety

- Do not guess business values or claim success without visible evidence.
- Before an irreversible or high-impact action such as submitting a CR, publishing, approving, paying, or starting a production release, show the pending result and obtain explicit user confirmation in the current conversation.
- Record confirmation only after the user confirms the exact pending action. Facts, decisions, or outputs changed after confirmation invalidate that confirmation and require a new review.
- Treat the current prompt as the complete source of workflow-specific steps, facts, policies, expected results, and constraints.
- A new workflow requires no repository changes.
