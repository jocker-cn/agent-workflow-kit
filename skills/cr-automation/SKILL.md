---
name: cr-automation
description: Use for prompt-driven Jenkins build and Change Request workflows through playwright-cli. Persists each run locally and requires explicit confirmation before CR submission.
---

# CR Automation

Use this Skill for CR, change request, Jenkins release, release-pipeline, Sonar report, or FOSS report requests.

## Runtime

- Use the `change-request` workflow contract and common project runtime. Do not repeat browser-operation or workflow-runtime commands here.
- Read `knowledge/<service>.md` when it exists. It is business knowledge, not a page automation script.

## Required workflow

### 1. Build

- Move the run to `BUILD`.
- Find an existing suitable successful build or trigger a build if the user requested it.
- Wait for a terminal build result; do not infer success from a page loading indicator.
- Record build number, URL and status.
- Record `build` evidence.

### 2. Collect release evidence

- Move to `COLLECT_ARTIFACTS`.
- Extract and record the exact image version, Sonar report/status and FOSS report/status.
- Record the source URL or a local screenshot/snapshot as evidence for each material value.
- Record Sonar and FOSS evidence with kinds `sonar` and `foss`.
- If a required value cannot be established, stop and clearly ask the user; do not guess or substitute a prior build.

### 3. CR draft and form

- Move to `CREATE_CR_DRAFT`, create a draft, and record its id and URL.
- Record CR evidence with kind `cr`.
- Move to `FILL_CR` and fill the current page form based on the user's request and observed labels/options.
- Required fields whose meaning is unclear must be reported to the user. Do not choose a plausible-looking value.

### 4. Pipeline

- Move to `CREATE_PIPELINE`.
- Create or associate the required CR pipeline and record its URL/status.
- Record pipeline evidence with kind `pipeline`.

### 5. Review and submit

- Move to `REVIEW` and present the generated review to the user.
- Move to `WAIT_FOR_CONFIRMATION`.
- Never submit a CR or start a production approval flow unless the user explicitly confirms the exact run in the current conversation.
- After explicit confirmation is recorded in the common runtime, move to `SUBMIT`, submit through the browser, record evidence, then move to `DONE`.

## Required facts

Record only stable, factual values. The required field names are enforced by `workflows/change-request/workflow.yaml`.

## Business safety

- Do not place passwords, tokens, cookies, browser profiles, or private report contents in state files, screenshots committed to Git, or prompts.
- Browser login is supplied by the local managed environment. If automatic login fails, stop and report it rather than attempting credential workarounds.
