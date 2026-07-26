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

## First-run exploration

When no valid Prompt-scoped page cache exists, use snapshots to discover the current page. Never persist element refs:

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

Refs are valid only for the current page state. After a stable action succeeds, cache a user-facing locator, scoped CSS fallback, page fingerprint, and postcondition through `pnpm run cachectl --`; do not cache the ref.

## Cached fast path

For later runs of the unchanged Prompt:

1. Resolve the current business node against the parameterized recipe.
2. Select the matching guarded route and named page variant.
3. Execute the route with `pnpm run recipe -- --run <run-id> --node <node-id>`.
4. Let the runner verify page fingerprints, perform all safe actions, extract facts, and validate
   the business-boundary expectation inside one official Playwright CLI `run-code` call.
5. Commit the generated boundary payload once with `pnpm run workflow -- commit`.

Successful cached actions do not return to the Agent individually and do not need a full snapshot.
If a batch fails, take a screenshot first, then use a depth-limited or element-scoped snapshot only
when visual information is insufficient. Repair only the failed locator, page variant, guarded
route, or recipe node according to the actual scope of the change.

Use structured locator candidates for batchable actions:

```bash
pnpm run cachectl -- action-learn --prompt-key <prompt-key> \
  --page order-details --name submit-filter \
  --strategy locator --locator-kind role --role button \
  --target "筛选" --operation click \
  --postcondition "筛选结果可见"
```

Legacy free-form Playwright locator candidates remain readable, but the batch runner intentionally
does not evaluate them as JavaScript. Re-learn them with `--locator-kind`, or use a CSS candidate,
before enabling the fast path.

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

For a multi-step workflow, keep all commands in one named session. When the Agent creates an optional workflow run, use its run id as the session name, for example:

```bash
pnpm browser -s=20260724-payment-service-abc123 open <jenkins-url> --headed
pnpm browser -s=20260724-payment-service-abc123 snapshot
```

At the end of work, close the session:

```bash
pnpm browser -s=20260724-payment-service-abc123 close
```

## Boundaries

- Do not cache snapshot refs, live DOM nodes, credentials, verification values, cookies, or run-specific business data.
- Prefer user-facing locators, then scoped CSS. Use screenshot-guided coordinates only for non-semantic custom widgets with a matching viewport and visual anchors.
- Do not inspect hidden network request bodies.
- Do not run a production submit action until the user has explicitly confirmed the pending action.
