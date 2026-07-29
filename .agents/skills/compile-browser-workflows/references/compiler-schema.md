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
- Mark an irreversible transaction with a `risk` or `human` barrier.
- Describe semantic operations here. Stable Playwright locators remain in the page cache.
- After a same-URL search/filter mutation, learn a structured cache action with
  `--operation wait --wait-for stable`, usually scoped with `--has-text-from <input-or-fact>`.
  The action's free-text `--postcondition` remains documentation.
