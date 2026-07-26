# Playwright CLI integration

This repository pins `@playwright/cli` as a local development dependency. Always use it through `pnpm browser ...`; do not require a global installation.

## One-time setup

```bash
pnpm install
pnpm browser install --skills agents
```

`browser:install` initializes the CLI workspace and its local agent integration. It does not sign in to any website.

If the managed workstation does not already have a compatible browser for Playwright CLI, obtain approval before downloading one:

```bash
pnpm browser:install-browser
```

## Agent command loop

An Agent should use this loop, never pre-computing element references:

```bash
# 1. Open or navigate to the target page.
pnpm browser open <url> --headed

# 2. Inspect the current accessibility snapshot.
pnpm browser snapshot

# 3. Interact only with an element ref from that current snapshot.
pnpm browser click <ref>
pnpm browser fill <ref> "<value>"
pnpm browser select <ref> "<option>"

# 4. Inspect again after navigation, a modal, a submission, or asynchronous loading.
pnpm browser snapshot
```

Useful read-only or diagnostic commands:

```bash
pnpm browser find "Sonar"
pnpm browser screenshot
pnpm browser console
pnpm browser requests
pnpm browser list
```

## Sessions and company sign-in

Start with a non-production URL and check whether `open` obtains the expected Windows-integrated sign-in. Do not attempt password automation or export cookies.

When a new browser session cannot access the managed login state, investigate an approved attach mechanism instead of creating a persistent copy of a personal browser profile. The CLI supports browser attachment and separate named sessions; inspect the installed command help before selecting the company-approved mode:

```bash
pnpm browser:help
pnpm browser list
pnpm browser attach --help
```

For a multi-step workflow, keep all commands in one named session. The session name should be the CR run id, for example:

```bash
pnpm browser -s=20260724-payment-service-abc123 open <jenkins-url> --headed
pnpm browser -s=20260724-payment-service-abc123 snapshot
```

At the end of work, close the session:

```bash
pnpm browser -s=20260724-payment-service-abc123 close
```

## Boundaries

- Do not use `run-code`, raw `eval`, network request bodies, or coordinate actions in a normal business workflow.
- Use snapshots, current refs, labels and roles as the standard interaction method.
- Do not run a production submit action until the workflow's explicit confirmation step has been recorded.
