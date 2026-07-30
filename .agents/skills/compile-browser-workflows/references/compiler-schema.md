# Workflow compiler artifact

This JSON is generated and maintained by the Agent. It is not user configuration.

```json
{
  "workflow": {
    "name": "resource-validation",
    "summary": "Validate a resource across two Web systems",
    "description": "Business description retained with the compiled workflow"
  },
  "inputs": [
    {
      "key": "resource.name",
      "description": "Resource name supplied for this run",
      "required": true,
      "structural": false
    }
  ],
  "facts": [
    {
      "key": "search.referenceFollowers",
      "description": "Reference follower range",
      "source": {
        "system": "jinsuitui",
        "page": "video-resource-results",
        "state": "filtered",
        "tab": "main"
      }
    }
  ],
  "outputs": [
    {
      "key": "result.consistent",
      "description": "Whether the observed followers are in the reference range"
    }
  ],
  "policies": [
    {
      "description": "Read information only"
    }
  ],
  "constraints": [
    {
      "before": "search-and-collect",
      "after": "verify-bilibili",
      "reason": "The Bilibili URL is produced by the search result"
    }
  ],
  "transactions": [
    {
      "id": "search-and-collect",
      "title": "Search and collect all resource fields",
      "description": "Search once and collect the result count, reference range, and link",
      "type": "browser",
      "affinity": {
        "system": "jinsuitui",
        "page": "video-resource-results",
        "state": "filtered",
        "tab": "main",
        "variant": "default"
      },
      "requires": [
        "session.authenticated"
      ],
      "produces": [
        "search.exists",
        "search.referenceFollowers",
        "search.videoUrl"
      ],
      "collects": [
        "search.referenceFollowers",
        "search.videoUrl"
      ],
      "asserts": [
        {
          "key": "search.exists",
          "value": true,
          "description": "The stabilized result row proves the resource exists"
        }
      ],
      "after": [
        "login"
      ],
      "barrier": "none",
      "risk": "read",
      "authorization": {
        "mode": "not-required",
        "scope": "Search and read one resource"
      },
      "operations": [
        {
          "id": "apply-filter",
          "kind": "interact",
          "description": "Apply the Bilibili and resource-name filters"
        },
        {
          "id": "collect-result-fields",
          "kind": "collect",
          "description": "Read all later-needed fields from the stabilized result"
        }
      ]
    }
  ]
}
```

An explicitly requested bounded write is prompt-authorized even when its generated values are not
known before execution:

```json
{
  "id": "submit-resources",
  "title": "Create the requested resources",
  "type": "browser",
  "risk": "irreversible",
  "barrier": "none",
  "authorization": {
    "mode": "prompt",
    "scope": "Create resources in the Prompt target system",
    "countFrom": "num",
    "maxCount": 20,
    "constraints": [
      "Generate fields only from the ranges declared in the Prompt"
    ]
  }
}
```

Use runtime confirmation only when the Prompt requests it or additional authority is needed:

```json
{
  "risk": "irreversible",
  "barrier": "risk",
  "authorization": {
    "mode": "runtime",
    "scope": "Publish the final reviewed production release"
  }
}
```

A run-time count must not change the compiled node count. Use one parameterized browser
transaction:

```json
{
  "id": "submit-resources",
  "title": "Submit the requested resources",
  "type": "browser",
  "risk": "irreversible",
  "authorization": {
    "mode": "prompt",
    "scope": "Submit the requested resource batch",
    "countFrom": "num",
    "maxCount": 100
  },
  "iteration": {
    "mode": "repeat",
    "countFrom": "num",
    "indexAs": "resourceIndex",
    "itemAs": "resource",
    "maxIterations": 100,
    "generate": {
      "price": {
        "op": "random-int",
        "min": 10,
        "max": 100
      },
      "nonce": {
        "op": "random-string",
        "length": 8
      }
    },
    "generateByRoute": {
      "xiaohongshu": {
        "name": {
          "op": "template",
          "template": "xhs-resource-${loop.iteration}"
        },
        "profileUrl": {
          "op": "copy",
          "from": "xiaohongshu.profileUrl"
        }
      },
      "weibo": {
        "name": {
          "op": "template",
          "template": "weibo-resource-${loop.iteration}"
        },
        "accountUrl": {
          "op": "copy",
          "from": "weibo.accountUrl"
        }
      }
    }
  },
  "dependsOn": ["resourceType"],
  "routes": [
    {"id": "xiaohongshu", "when": {"resourceType": "小红书资源"}},
    {"id": "weibo", "when": {"resourceType": "微博资源"}}
  ]
}
```

Cached actions for this transaction read values through `loop.item.name`, `loop.item.price`, and
other loop fields. For an existing array, use `mode: "foreach"` with `itemsFrom` instead of
`countFrom`. Structured arrays may be supplied to `workflow init` through `--inputs-file`.
The Runner resolves the structural route first, then merges common `generate` fields with only
that route's `generateByRoute` fields. Route guards for such a node therefore cannot depend on
`loop.*` or the item alias; those values do not exist until after route selection.

A local comparison/report transaction can calculate facts and outputs without returning to the
model:

```json
{
  "id": "report-result",
  "title": "Compare and report",
  "type": "report",
  "requires": ["search.referenceFollowers", "bilibili.followers"],
  "produces": ["followers.actual", "followers.range", "result.consistent"],
  "computes": [
    {"key": "followers.actual", "op": "parse-number", "from": "bilibili.followers"},
    {"key": "followers.range", "op": "parse-range", "from": "search.referenceFollowers"},
    {
      "key": "result.consistent",
      "op": "between",
      "from": "followers.actual",
      "rangeFrom": "followers.range"
    },
    {
      "key": "result.summary",
      "target": "output",
      "op": "template",
      "template": "Actual ${followers.actual}; consistent=${result.consistent}"
    }
  ]
}
```

## Field rules

- Put business explanations in `workflow.description`, transaction `description`, fact
  `description`, operation `description`, and policy `description`.
- Put run-varying values in run inputs, never in this artifact.
- Never copy passwords, verification values, cookies, tokens, or other secrets into this artifact.
- Use `requires` and `produces` for data dependencies.
- Every `produces` entry must be supplied by `collects`, `asserts`, or a fact-targeted `computes`
  entry. `asserts` are committed only after the route expectation succeeds.
- Supported deterministic computation operators are `copy`, `set`, `parse-number`, `parse-range`,
  `between`, `equals`, `contains`, `conditional`, and `template`. Use `target: "output"` for
  workflow output data; the default target is `fact`.
- Use `constraints` only for hard ordering not already implied by data.
- Use `affinity.state` for materially different states on the same URL.
- Use `barrier`: `none`, `human`, `decision`, `risk`, or `context`.
- Use `risk`: `read`, `reversible`, or `irreversible`.
- Use `authorization.mode`: `not-required`, `prompt`, or `runtime`.
- `prompt` means the current Prompt explicitly authorizes the action within `scope`, `count` or
  `countFrom`, `maxCount`, and `constraints`. It does not pause.
- `runtime` requires a `risk` or `human` barrier and a valid confirmation recorded for the node.
- An irreversible transaction must explicitly use `prompt` or `runtime`; irreversibility alone
  does not create a barrier.
- Use `iteration.mode=repeat` with `count` or `countFrom`; use `foreach` with `itemsFrom`.
- The executor supports deterministic item generators `literal`, `copy`, `template`, `random-int`,
  `choice`, and `random-string`. Generated values are seeded by run, node, index, and field, then
  persisted in run loop state.
- Use `iteration.generate` only for common item fields and
  `iteration.generateByRoute.<route-id>` for branch-specific fields. Generation rules come from
  the Workflow Prompt; the framework must not invent uniqueness, ranges, choices, or defaults.
- A failed iteration keeps its index. An uncertain irreversible attempt is not retried blindly;
  reconcile the visible external result before resuming.
- Never expand `num` into numbered transactions.
- Compile with `--stdin true` when possible. `.workflow-cache` accepts only canonical compiled
  definitions and shared page-action files; compiler drafts, root JSON, and executable glue are
  invalid. A diagnostic `--file` input must live outside the cache and be removed afterward.
- Describe semantic operations here. Stable Playwright locators remain in the page cache.
- After a same-URL search/filter mutation, learn a structured cache action with
  `--operation wait --wait-for stable`, usually scoped with `--has-text-from <input-or-fact>`.
  The action's free-text `--postcondition` remains documentation.
