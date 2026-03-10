# Spec Authoring Patterns — OAS++ and Schema++

This document describes three required patterns that every spec author must follow when onboarding a new API (REST via OAS++ or GraphQL via Schema++). Skipping any of these patterns causes silent failures at runtime that are hard to diagnose.

---

## Overview

When the agent executes a query like *"Show me the PostCall page"* against an API, three things must work correctly:

1. **Entity extraction** — the agent must pull the right named entity (e.g. "PostCall") out of the query and bind it to the right parameter name (e.g. `page_name`)
2. **Grounding path correctness** — the intermediate resolver call must extract the right field from its response (e.g. `results[0].id`) and fail loudly if nothing is found
3. **Response completeness** — the final operation must return enough data to answer the question (not just shallow metadata)

All three are purely spec authoring concerns. The agent runtime is generic — it cannot compensate for a poorly authored spec.

---

## Pattern 1 — Entity Extraction Hints

### Problem

The doc-aware planner extracts named entities from the user query (e.g. "PostCall", "Engineering team", "Alice Chen") and binds them to `intent` variables. It does this using GPT, guided by the `x-agent-guidance` block. If the block has no explicit mapping from parameter name to natural-language description, the LLM may guess wrong or skip the extraction entirely — leaving grounding variables like `{{intent.page_name}}` unresolved.

### Rule

For every grounding variable `{{intent.X}}` used anywhere in an operation's grounding chain, there must be a corresponding entry in `x-agent-guidance.entity_extraction` on that operation.

---

### OAS++ (REST)

Add an `entity_extraction` map directly inside `x-agent-guidance`:

```yaml
# specs/confluence-oas-plus.yaml
/wiki/rest/api/content/{id}:
  get:
    operationId: getPageById
    x-agent-guidance:
      - "get page {page_name}"
      - "show me the {page_name} page in {space_name}"
      entity_extraction:
        page_name: "The title or name of the Confluence page the user is looking for"
        space_name: "The Confluence space name or key, if mentioned"
    x-postcall-grounding:
      steps:
        - operationId: searchContent
          parameters:
            cql: "type=page AND title~\"{{intent.page_name}}\""
```

**Rules:**
- Each key is the `intent.X` variable name (without `intent.`)
- The value is a natural-language description that helps the LLM recognize it in the query
- Only include variables that appear in `{{intent.X}}` templates in the grounding chain or parameters

---

### Schema++ (GraphQL)

Identical field — `entity_extraction` nested inside `x-agent-guidance`:

```yaml
# specs/forge-schema-plus.yaml
operations:
  listTasksByProject:
    x-agent-guidance:
      - "show tasks in {project_name}"
      - "list tasks for the {project_name} project"
      entity_extraction:
        project_name: "The name of the project the user is referring to"
    x-postcall-grounding:
      steps:
        - operationId: findProjectByName
          variables:
            name: "{{intent.project_name}}"
```

The pattern is identical across REST and GraphQL. Every `{{intent.X}}` needs a matching entry.

---

## Pattern 2 — Grounding Path Validation

### Problem

Grounding steps use an `extract` map to pull values out of a resolver response (e.g. `results[0].id`). If the resolver returns zero results — because the named entity was not found, or the search query was too strict — the extract path silently returns `undefined`. The downstream operation then executes with a blank or literal `{{intent.page_name}}` path parameter, producing a cryptic 400 or 404 error with no indication of what actually failed.

### Rule

Every grounding step that produces a value required for the downstream operation must be marked `required: true` and include a human-readable `error_message`. The agent will abort early and surface the error rather than continue with an unresolved parameter.

---

### OAS++ (REST)

```yaml
# specs/confluence-oas-plus.yaml
x-postcall-grounding:
  steps:
    - operationId: searchContent
      description: "Find page by title"
      parameters:
        cql: "type=page AND title~\"{{intent.page_name}}\""
        limit: 1
      extract:
        id: "results[0].id"
      required: true
      error_message: "Could not find a page matching '{{intent.page_name}}'. Check the page title."
```

For optional enrichment steps (e.g. resolving a display name that is nice-to-have but not blocking), omit `required` or set `required: false`.

---

### Schema++ (GraphQL) — extract path is relative to `dataPath`

```yaml
# specs/forge-schema-plus.yaml
operations:
  listTasksByProject:
    x-postcall-grounding:
      steps:
        - operationId: findProjectByName
          variables:
            name: "{{intent.project_name}}"
          extract:
            project_id: "project.id"      # relative to dataPath of findProjectByName
          required: true
          error_message: "No project found matching '{{intent.project_name}}'. Check the project name in Forge."
```

**Critical GraphQL difference:** The extract path is relative to the **`response.dataPath`** of the resolver operation, not the raw GraphQL response. If `findProjectByName` has `response.dataPath: "projectByName"`, then the GraphQL response looks like:

```json
{ "data": { "projectByName": { "id": "42", "name": "API Gateway" } } }
```

After `dataPath` extraction, the resolved value is `{ "id": "42", "name": "API Gateway" }`. So the extract path must be `"id"`, not `"data.projectByName.id"` or `"projectByName.id"`.

**Rule:** Always verify the extract path against the resolver operation's `response.dataPath`.

---

### Multi-step grounding

When a chain has multiple steps and a later step references a value from an earlier one (via `{{steps[N].field}}`), mark each step `required: true` independently:

```yaml
x-postcall-grounding:
  steps:
    - operationId: listSpaces
      parameters:
        limit: 100
      filter: "name contains '{{intent.space_name}}'"
      extract:
        spaceKey: "results[0].key"
      required: true
      error_message: "Could not find space '{{intent.space_name}}'."

    - operationId: searchContent
      parameters:
        cql: "space={{steps[0].spaceKey}} AND type=page AND title~'{{intent.page_name}}'"
        limit: 1
      extract:
        id: "results[0].id"
      required: true
      error_message: "Could not find page '{{intent.page_name}}' in space '{{intent.space_name}}'."
```

---

## Pattern 3 — Response Completeness

### Problem

Many APIs return a minimal response by default — IDs, titles, and status flags — but not the actual content the user needs. Without spec-level guidance, the agent will never add optional expansion parameters and the response will be too shallow to answer the user's question.

Example: Confluence `getPageById` without `expand=body.storage` returns the page title and metadata but not the page body. The agent sees the response, calls the enricher, and produces a summary of metadata — but cannot tell the user what the page says.

### OAS++ (REST) — two complementary fixes

**Fix A: Set a `default` on the expansion parameter.**

The executor injects default values for any parameter with a `default` that was not explicitly set. This is the simplest fix.

```yaml
parameters:
  - name: expand
    in: query
    description: |
      Comma-separated list of properties to expand.
      Use "body.storage,version,space" to get the full page content.
    schema:
      type: string
      default: "body.storage,version,space"
    example: "body.storage,version"
```

**Fix B: Add `intent_hints` in `x-agent-guidance` for intent-driven expansion.**

When different user intents need different expansion sets, map intent patterns to the required expand values:

```yaml
x-agent-guidance:
  - "get page {page_name}"
  - "show me the {page_name} page"
  entity_extraction:
    page_name: "The title of the page"
  intent_hints:
    "show content|read page|show me": "expand=body.storage,version,space"
    "get metadata|find page|page exists": "expand=version,space"
```

The planner matches the user's phrasing against the intent patterns and injects the corresponding expand value. Use this when the `default` is not enough — e.g. an operation that serves both "does this page exist?" (no body needed) and "show me the page" (body required).

---

### Schema++ (GraphQL) — pre-select all needed fields in the query

GraphQL has no optional expansion parameters. The query itself is the field selector. The agent cannot add fields at runtime that are not in the spec's `graphql:` query.

**The completeness burden falls entirely on the spec author.**

Wrong — minimal query that cannot answer content questions:

```yaml
operations:
  getTask:
    graphql: |
      query GetTask($id: ID!) {
        task(id: $id) {
          id
          title
          status
        }
      }
    response:
      dataPath: "task"
```

Right — complete query that returns everything the user might ask about:

```yaml
operations:
  getTask:
    graphql: |
      query GetTask($id: ID!) {
        task(id: $id) {
          id
          title
          status
          priority
          assignee {
            id
            name
            email
          }
          project {
            id
            name
          }
          team {
            id
            name
          }
        }
      }
    response:
      dataPath: "task"
```

**Rules for GraphQL field selection:**
- Include all scalar fields on the primary type
- Always expand nested object fields (assignee, project, team) — IDs alone are not useful to users
- When in doubt, include more fields; GraphQL servers handle unused fields gracefully
- Avoid `__typename` unless needed for polymorphism

---

## Comparison Table

| Pattern | OAS++ (REST) | Schema++ (GraphQL) |
|---|---|---|
| **Entity extraction** | `x-agent-guidance.entity_extraction: { param: "description" }` | Identical — same field under the operation |
| **Grounding path validation** | `required: true` + `error_message` on each grounding step; path relative to raw JSON response | Same flags; path is relative to `response.dataPath` of the resolver op |
| **Response completeness** | `default:` on expand param; optionally `intent_hints` for multi-intent ops | Pre-select all needed fields in the `graphql:` query — no runtime fix possible |

---

## Checklist for Onboarding a New Operation

Before marking an operation as complete in any spec:

- [ ] Every `{{intent.X}}` variable has a matching `entity_extraction` entry
- [ ] Every mandatory grounding step has `required: true` and `error_message`
- [ ] Extract paths have been verified against the actual resolver response shape
- [ ] For REST: expansion parameters have a `default` or `intent_hints` set
- [ ] For GraphQL: the `graphql:` query includes all scalar fields and nested objects the user might ask about
- [ ] For multi-step chains: later steps reference `{{steps[N].field}}` using the exact field name from the extract map of step N

---

## Where This Fits in the Redesign Document

When adding this to **Postcall Universal Platform - Redesign.md**, copy the sections as follows:

| Section in this doc | Where to paste in the redesign doc |
|---|---|
| **Pattern 1 — Entity Extraction Hints** | Into the **OAS++ / Schema++ Spec Format** section, as a subsection under `x-agent-guidance` |
| **Pattern 2 — Grounding Path Validation** | Into the **Grounding Chains** section, after the basic grounding chain description |
| **Pattern 3 — Response Completeness** | Into the **Spec Authoring Guidelines** or **API Onboarding** section, as a new subsection |
| **Comparison Table** | As a quick-reference summary at the end of the **Spec Authoring Guidelines** section |
| **Checklist** | As a standalone callout box or appendix in the **API Onboarding** section |

If the redesign doc does not yet have a dedicated **Spec Authoring Guidelines** section, create one. It should live after the spec format reference (OAS++ / Schema++) and before the runtime architecture description.
