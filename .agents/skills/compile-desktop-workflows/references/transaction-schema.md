# Desktop transaction schema

The Agent generates this JSON inside `.workflow-runs/<run-id>/`. Users do not maintain it.

```json
{
  "schemaVersion": 1,
  "id": "open-named-conversation",
  "description": "Open an exact local conversation and capture its visible message boundary",
  "target": {
    "app": "Weixin",
    "process": "Weixin",
    "title": "微信",
    "titleMode": "exact",
    "className": "Qt51514QWindowIcon",
    "preserveGeometry": true,
    "geometryTolerancePx": 2,
    "activation": { "mode": "auto", "timeoutMs": 3000 }
  },
  "actions": [
    {
      "id": "focus-search",
      "command": "click",
      "relative": { "x": 0.28, "y": 0.07 }
    },
    {
      "id": "enter-name",
      "command": "send-keys",
      "valueFrom": "conversation.name",
      "via": "send-input"
    },
    {
      "id": "wait-results",
      "command": "pause",
      "durationMs": 400
    }
  ],
  "evidence": {
    "screenshot": "boundary",
    "file": ".workflow-runs/<run-id>/evidence/open-named-conversation/final.png"
  }
}
```

## Target

- Supply `app`, `process`, `title`, `className`, or a known `hwnd`. Multiple matching windows are an
  error; narrow the target rather than picking the first window.
- `preserveGeometry` defaults to `true`. Geometry-changing shortcuts such as `win+up` are rejected,
  and the runner compares the final window rectangle with its starting rectangle.
- `activation.mode=auto` is the default. UIA pattern operations remain in the background; the runner
  restores and foregrounds the window only before `click`, `drag`, `send-keys --via send-input`,
  `scroll --wheel`, or screen capture. `restore` forces eager restore/foreground and `activate`
  forces eager foreground without restoring. Set `activation` to `false` only when the caller
  guarantees foreground state. Do not use keyboard shortcuts or `screenshot --focus` for window
  management.

For a continuous cross-application transaction, replace `target` with named `targets` and select
one using each action's `window` field:

```json
{
  "targets": {
    "terminal": { "app": "SecureCRT", "activation": { "mode": "auto" } },
    "chat": { "app": "Weixin", "activation": { "mode": "auto" } }
  },
  "actions": [
    { "id": "read-title", "window": "terminal", "command": "window-info", "saveAs": "terminal-window" },
    {
      "id": "extract-status",
      "window": "terminal",
      "command": "extract-regex",
      "sourceFrom": "observations.terminal-window.title",
      "pattern": "^STATUS=(?<status>.+)$",
      "saveAs": "service"
    },
    {
      "id": "compose-message",
      "window": "terminal",
      "command": "template",
      "template": "Service status: ${observations.service.status}",
      "saveAs": "message"
    },
    { "id": "send-message", "window": "chat", "command": "send-keys", "valueFrom": "observations.message" }
  ],
  "evidence": { "screenshot": "boundary", "window": "chat" }
}
```

## Runtime values

`valueFrom` resolves from workflow inputs, facts, data, then repeated `--input key=value` flags.
Use `env.NAME` to read a secret without writing it into the plan or result.

## Commands

Semantic/UIA commands:

- `invoke`, `click`, `focus`: use `selector`.
- `set-value`: use `selector` plus `value` or `valueFrom`.
- `get-value`: use `selector`; add `saveAs` to retain the JSON observation.
- `get-property`: use `selector`, `property`, and optional `saveAs`.
- `search`, `inspect`: optionally use `selector`; add `saveAs` when the result is required.
- `window-info`: save the live title, process, class, HWND, and rectangle without a screenshot.
- `extract-regex`: use `sourceFrom`, `pattern`, optional `flags`, and `saveAs`. Named capture groups
  become an observation object.
- `template`: render `${path}` values from run data or earlier `observations` and save the result.
- `wait-for`: use `selector` and optional `gone`, `property`, `value`, `contains`, `timeoutMs`.
- `scroll`: use a UIA `selector` with `direction`, `to`, or `wheel`.

Fallback commands:

- `send-keys`: use `keys` or `valueFrom`, optional `target`, `via`, and `verbatim`.
- `click` with `relative: {"x": 0..1, "y": 0..1}` clicks relative to the live window rectangle.
- `drag` endpoints accept a selector string, an absolute `"x,y"` screen point, or
  `{"relative":{"x":0..1,"y":0..1}}`. Prefer selectors or relative points.
- `pause` uses `durationMs`; keep it short and use `wait-for` when UIA exposes a condition.
- `screenshot` is only for an explicit diagnostic boundary and its output must be under
  `.workflow-runs/<run-id>/diagnostics/<transaction-id>/`. It never focuses or restores a window.
  Normal evidence belongs in the top-level `evidence` block.

## Evidence policy

- `boundary`: capture once after all successful actions under `evidence/<transaction-id>/`; on
  failure capture under `diagnostics/<transaction-id>/` instead.
- `failure`: capture only when an action or geometry check fails under the diagnostics directory.
- `none`: no automatic screenshot; use only when an executable UIA boundary fully proves success.

Never put PNG files directly in `.workflow-runs/<run-id>/`. A successful rerun removes the
transaction's diagnostic directory. Evidence is not Cache and is never used as a future locator.

The result includes per-action duration, the first failed action, collected observations, geometry
comparison, and the evidence path. It never includes values read through `env.*`.

## Workflow boundary

For a resumable node, add:

```json
{
  "workflow": {
    "nodeId": "read-conversation",
    "title": "Read the requested conversation",
    "system": "wechat",
    "next": "Continue with the next application transaction",
    "routeId": "exact-search",
    "routeSignature": "default",
    "facts": [
      { "key": "conversation.messages", "from": "observations.messages" }
    ],
    "outputs": []
  }
}
```

`from` paths read from `observations.*` or `result.*`. The runner writes one
`.workflow-runs/<run-id>/last-boundary.json`; commit it once, never once per desktop action.
