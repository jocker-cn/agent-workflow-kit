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
    "geometryTolerancePx": 2
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
    "file": ".workflow-runs/<run-id>/open-named-conversation.png"
  }
}
```

## Target

- Supply `app`, `process`, `title`, `className`, or a known `hwnd`. Multiple matching windows are an
  error; narrow the target rather than picking the first window.
- `preserveGeometry` defaults to `true`. Geometry-changing shortcuts such as `win+up` are rejected,
  and the runner compares the final window rectangle with its starting rectangle.
- `activation` may contain a `send-keys` action body when a minimized application must be restored
  before the transaction baseline is recorded.

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
- `wait-for`: use `selector` and optional `gone`, `property`, `value`, `contains`, `timeoutMs`.
- `scroll`: use a UIA `selector` with `direction`, `to`, or `wheel`.

Fallback commands:

- `send-keys`: use `keys` or `valueFrom`, optional `target`, `via`, and `verbatim`.
- `click` with `relative: {"x": 0..1, "y": 0..1}` clicks relative to the live window rectangle.
- `drag` endpoints accept a selector string, an absolute `"x,y"` screen point, or
  `{"relative":{"x":0..1,"y":0..1}}`. Prefer selectors or relative points.
- `pause` uses `durationMs`; keep it short and use `wait-for` when UIA exposes a condition.
- `screenshot` is for an explicit intermediate business boundary. Normal evidence belongs in the
  top-level `evidence` block.

## Evidence policy

- `boundary`: capture once after all successful actions and also on failure.
- `failure`: capture only when an action or geometry check fails.
- `none`: no automatic screenshot; use only when an executable UIA boundary fully proves success.

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
