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

- For every multi-system or resumable workflow, maintain a local run through `pnpm workflow`. This is internal Agent behavior and must not add setup work for the user.
- Treat every execution as a separate run. Never reuse a previous run for a different order, ticket, service, environment, branch, customer, or other business object.
- Extract values that vary between executions from the current prompt and save them as immutable run inputs, for example `--input order.id=A` or `--input service=payment`.
- Start a run with `pnpm workflow init`. Save a concise summary plus an `--intent` that preserves the workflow rules needed by a future Agent session. When invoked from a Prompt file, associate the run through its shell-safe `--prompt-key`.
- Use the run id as the Playwright browser session name.
- Convert the prompt into dynamic plan steps with `plan-add`. Update meaningful step status with `step`; do not record individual clicks as plan steps.
- Save values observed in a Web system with `fact`, including a visible source when useful. Save final or cross-system values with `output`.
- When an observed fact selects a conditional route, record the selected branch and reason with `decision`, then add only the newly relevant plan steps. Mark already-planned alternatives as `skipped`.
- Save `checkpoint` after a meaningful business boundary and before a long wait or risky action. It must identify the current step, next action, current Web system, and last useful URL.
- Never copy inputs, facts, decisions, or outputs from another run unless the current prompt explicitly requires it.
- When recovering without conversation context, select the run by its business inputs. Do not assume the most recently updated run is the intended one when multiple runs could match.
- Read `pnpm workflow context --run <run-id>` before continuing. Re-observe the current browser page because stored element refs and prior page assumptions are not resumable state.
- When the business Prompt requires a human checkpoint, preserve the same run and browser session. Record the expected observable condition with `pause --until`, wait with the official Playwright CLI, call `resume`, and continue automatically.

## Prompt-scoped cache

- For a reusable Prompt file, run `pnpm cachectl list`, select the matching Prompt, and use its shell-safe key with `pnpm cachectl prepare --prompt-key <key>` before planning or browser exploration. When the workspace has exactly one Prompt, selection may be omitted.
- Cache scope is the Prompt file identity plus its content hash. Different Prompt files and different versions of one Prompt never share definitions or page actions. Different run inputs for the unchanged Prompt reuse the same cache.
- If the cached definition already has steps and branches, instantiate the current run plan from it instead of parsing the entire Prompt again. If it is empty, compile the Prompt once and record reusable steps and branch rules with `definition-step` and `definition-branch`.
- Page caches store page fingerprints, semantic actions, locator candidates, postconditions, and success/failure history. They must not store snapshot refs, live DOM nodes, credentials, verification values, cookies, tokens, or run-specific business values.
- On a page cache hit, verify the cached URL/title/anchors, choose a healthy cached action candidate, execute it with Playwright CLI raw output, and verify its postcondition. Record the result with `action-result`.
- Prefer cached user-facing Playwright locators. Use a scoped CSS locator when the page lacks usable semantics. Use screenshot-guided vision actions for non-semantic custom widgets when the viewport and visual anchors match.
- Do not run a full snapshot on every successful cached action. Use screenshots or targeted checks for cheap validation. For exploration, prefer a screenshot first, then a depth-limited or element-scoped snapshot only when needed.
- If a cached action fails or its postcondition is false: record the failure, take a screenshot, inspect only the relevant page region when possible, learn a replacement candidate, retry, and write the successful candidate back to the same Prompt cache.
- If the page fingerprint no longer matches, invalidate that page cache before exploration. Never reuse a cached action blindly for an irreversible or high-impact operation.

## Safety

- Do not guess business values or claim success without visible evidence.
- Before an irreversible or high-impact action such as submitting a CR, publishing, approving, paying, or starting a production release, show the pending result and obtain explicit user confirmation in the current conversation.
- Record confirmation only after the user confirms the exact pending action. Facts, decisions, or outputs changed after confirmation invalidate that confirmation and require a new review.
- Treat the current prompt as the complete source of workflow-specific steps, facts, policies, expected results, and constraints.
- A new workflow requires no repository changes.
