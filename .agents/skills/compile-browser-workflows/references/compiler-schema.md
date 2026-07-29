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

## Field rules

- Put business explanations in `workflow.description`, transaction `description`, fact
  `description`, operation `description`, and policy `description`.
- Put run-varying values in run inputs, never in this artifact.
- Never copy passwords, verification values, cookies, tokens, or other secrets into this artifact.
- Use `requires` and `produces` for data dependencies.
- Use `collects` for the subset of `produces` that must be extracted directly by cached page
  actions. Postcondition or locally computed facts do not belong in `collects`.
- Use `constraints` only for hard ordering not already implied by data.
- Use `affinity.state` for materially different states on the same URL.
- Use `barrier`: `none`, `human`, `decision`, `risk`, or `context`.
- Use `risk`: `read`, `reversible`, or `irreversible`.
- Mark an irreversible transaction with a `risk` or `human` barrier.
- Describe semantic operations here. Stable Playwright locators remain in the page cache.
