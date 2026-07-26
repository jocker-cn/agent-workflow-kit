# Agent Workflow Kit

This repository provides reusable, prompt-driven browser workflow modules for coding agents.

## Workflow routing

- Before executing a business workflow, inspect `skills/` and read the relevant `SKILL.md` in full.
- Read the matching `workflows/<workflow-id>/workflow.yaml`; it is the enforced contract for phase ordering, required evidence, and confirmation gates.
- For Jenkins, Change Request, release pipeline, Sonar, or FOSS tasks, use `skills/cr-automation/SKILL.md`.
- For the explicit Bilibili video metrics demo, use `skills/bilibili-video-metrics/SKILL.md`.
- Treat `knowledge/<service>.md` as stable business knowledge. Do not add selectors, element refs, credentials, cookies, or browser profiles there.

## Browser automation

- Read `.agents/skills/playwright-cli/SKILL.md` before using browser automation. It is the installed upstream Playwright CLI Skill and defines the normal browser interaction loop.
- Use the repository-local CLI only: `pnpm browser <command>`.
- Do not require or invoke a global `playwright-cli` installation.
- Do not use Codex Browser, MCP browser tools, host-level browser scripts, or files outside this repository to inspect or operate a workflow page. The repository-local CLI is the entire browser execution surface.
- Use a named browser session matching the workflow run id: `pnpm browser -s=<run-id> <command>`.
- Do not automate passwords, export cookies, or copy browser profiles. If the managed browser's automatic sign-in is unavailable, stop and report the issue.

## Workflow state and safety

- Start a workflow with `pnpm workflow init --workflow <name> --summary <text> ...`; record facts and evidence as it proceeds.
- Keep browser session id and workflow run id identical where possible.
- Use the workflow Skill's required phases and evidence rules; do not guess values for required business fields.
- Use `pause`, `resume`, and `latest` to carry a human checkpoint across the same run. Use the generic local secret helper for values that must not enter the Agent context, and the generic browser wait helper to observe the user-completed state.
- Decide the final terminal and chat presentation from the requested output; do not require a workflow-specific output formatter.
- Never submit a CR, production pipeline, or approval action without explicit user confirmation in the current conversation and the corresponding local confirmation record.
- Do not use raw browser JavaScript, network request bodies, or coordinate-based interactions in a normal business workflow.
- A user must complete passwords, SMS verification, CAPTCHAs, and similar human-only steps in the browser; the Agent must preserve and continue the same run after the observable state changes.

## Reference material

- `docs/playwright-cli.md` is a human-facing troubleshooting and setup reference. Read it only when CLI setup, sessions, browser attachment, or diagnostics require more detail.
