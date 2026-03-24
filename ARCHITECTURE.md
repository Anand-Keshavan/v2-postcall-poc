# PostCall POC — Architecture & Source Code Map

## Overview

PostCall is a console-based AI agent that lets a user query multiple APIs using plain English. The agent maps a natural language sentence to the right API operation, resolves any required IDs through grounding chains, executes the call, and returns a formatted result — without the user ever writing a URL or parameter.

```
User: "list all tasks for the Engineering team"
         ↓
    RAG Matcher          ← find the right operation  (forge/listTasksByTeam)
         ↓
    Doc-Aware Planner    ← read the spec, extract intent params  (team_name: "Engineering")
         ↓
    Context Resolver     ← check session memory for team_id
         ↓  (cache miss)
    Grounding Executor   ← call listTeams(name="Engineering") → team_id: "1"
         ↓
    GraphQL Executor     ← run listTasksByTeam(teamId: "1")
         ↓
    Response Enricher    ← format + store result in context store
         ↓
User sees: "Engineering team has 3 tasks: API Gateway Redesign (ACTIVE) ..."
```

---

## Component Map

```
v2-postcall-poc/
│
├── agent/
│   └── postcall-agent-v2.js         ← Entry point / REPL loop
│
├── lib/
│   ├── rag-matcher.js               ← RAG: operation discovery
│   ├── context-store.js             ← RAG: session vector store
│   ├── context-resolver.js          ← RAG: context-first grounding
│   │
│   ├── doc-aware-planner.js         ← Planning: doc-informed param generation
│   ├── reasoning-planner.js         ← Planning: multi-step plan generation
│   ├── candidate-reranker.js        ← Planning: rerank RAG candidates
│   ├── doc-retriever.js             ← Planning: format docs for AI prompt
│   │
│   ├── grounding-executor.js        ← Grounding: REST resolver chains
│   ├── graphql-executor.js          ← Grounding + execution: GraphQL
│   ├── grounding-detector.js        ← Grounding: auto-inject at load time
│   │
│   ├── api-client-simple.js         ← HTTP: authenticated REST client
│   ├── console-auth.js              ← Auth: CLI credential prompts
│   ├── token-storage.js             ← Auth: AES-256 encrypted local store
│   │
│   ├── error-recovery.js            ← Recovery: OpenAI-guided retry
│   ├── response-enricher.js         ← Output: format + store result
│   │
│   ├── protocols/
│   │   ├── index.js                 ← Protocol router
│   │   ├── http-protocol.js         ← REST execution handler
│   │   └── graphql-protocol.js      ← GraphQL execution handler
│   │
│   ├── actions/
│   │   └── open-url.js              ← Action: open URL in browser
│   │
│   ├── terminal-link.js             ← Utility: clickable terminal links
│   └── abort-signal.js              ← Utility: Ctrl-C handling
│
├── specs/
│   ├── github-oas-plus.yaml         ← OAS++ spec: GitHub REST API
│   ├── confluence-oas-plus.yaml     ← OAS++ spec: Confluence REST API
│   ├── nile-oas-plus.yaml           ← OAS++ spec: Nile mock ecommerce API
│   └── forge-schema-plus.yaml       ← Schema++ spec: Forge GraphQL API
│
├── scripts/
│   ├── build-doc-aware-index.js     ← Index builder: REST specs
│   └── build-graphql-index.js       ← Index builder: GraphQL specs
│
├── .rag-index-docs.json             ← Generated vector index (30 MB)
│
├── mock-nile-api.js                 ← Test server: Nile REST API (port 8000)
├── mock-forge-api.js                ← Test server: Forge GraphQL API (port 9000)
│
├── oas-plus-tool/                   ← Converter: OpenAPI → OAS++
└── schema-plus-tool/                ← Converter: GraphQL SDL → Schema++
```

---

## 1. Agent Entry Point

**File:** `agent/postcall-agent-v2.js` (518 lines)

The single entry point for the entire system. It owns the REPL loop and orchestrates every other component.

**Boot sequence:**
1. Load the four OAS++/Schema++ specs from `specs/` into two maps: `specs{}` (REST) and `schemaSpecs{}` (GraphQL)
2. Run `grounding-detector` over every REST spec to auto-inject grounding chains for `*_id` path parameters that lack them
3. Call `loadIndex()` to read `.rag-index-docs.json` into memory
4. Print the welcome banner and start the readline REPL

**Per-query flow:**
1. Accept user input
2. Call `matchQueryTopN(query, 5)` to find candidate operations
3. Call `rerankCandidates()` to select the best one
4. Check if auth is needed for the target API; prompt if missing
5. Call `generateDocAwarePlan()` to produce a parameterised step plan
6. Call `executePlan()` from the reasoning planner
7. Call `enrichResponse()` and print results

**Key exports used:**
```
getToken / storeToken / hasToken    ← lib/token-storage.js
createClientFromSpec                ← lib/api-client-simple.js
executeGroundingChain               ← lib/grounding-executor.js
loadIndex / matchQueryTopN          ← lib/rag-matcher.js
rerankCandidates                    ← lib/candidate-reranker.js
requestAuthForSpec                  ← lib/console-auth.js
generatePlan / executePlan          ← lib/reasoning-planner.js
generateDocAwarePlan                ← lib/doc-aware-planner.js
enrichResponse                      ← lib/response-enricher.js
contextStore                        ← lib/context-store.js
```

---

## 2. RAG System

The RAG (Retrieval-Augmented Generation) system is split into three layers: a pre-built static index for finding operations, a live session store for reusing API results, and a resolver that checks the session store before running grounding chains.

### 2.1 Operation Index

**File:** `lib/rag-matcher.js` (320 lines)

Finds which API operation best matches a user's query.

**How it works:**
- At startup, loads `.rag-index-docs.json` — a flat JSON array of 663 entries, one per (operation × query string) pair, each carrying a 1536-dimension embedding vector
- On each user query, calls OpenAI `text-embedding-3-small` to embed the query
- Loops over the in-memory array computing cosine similarity in plain JavaScript
- Filters to score ≥ 0.2, deduplicates by `operationId`, returns top-N results
- Falls back to keyword (word overlap) matching if `OPENAI_API_KEY` is not set

**Index entry shape:**
```json
{
  "query":       "list all tasks for the Engineering team",
  "embedding":   [0.021, -0.043, ...],
  "api":         "forge",
  "operationId": "listTasksByTeam",
  "path":        null,
  "method":      null,
  "summary":     "List tasks assigned to a team",
  "documentation": { ... full doc object ... }
}
```

**Key functions:**
```
loadIndex()              → Loads .rag-index-docs.json into memory (synchronous)
matchQuery(query)        → Returns single best match
matchQueryTopN(q, n)     → Returns top-N distinct operations
getIndexStats()          → Returns { total, operations, queries, created }
```

---

### 2.2 Index Builders

**Files:** `scripts/build-doc-aware-index.js`, `scripts/build-graphql-index.js`

Run offline (via `npm run build-indexes`) to regenerate `.rag-index-docs.json`. Never called at runtime.

**`build-doc-aware-index.js`** (REST):
1. Reads all OAS++ specs from `specs/`
2. Runs `grounding-detector` on each spec
3. For each operation, sends a prompt to GPT asking for 10–15 diverse natural language query strings from a user's perspective
4. Embeds every query with `text-embedding-3-small`
5. Writes the full entry array (including the complete `documentation` object) to `.rag-index-docs.json`

**`build-graphql-index.js`** (GraphQL):
1. Reads `specs/forge-schema-plus.yaml`
2. Expands `x-agent-guidance` seeds using a hardcoded `EXAMPLE_VALUES` map — replacing `{team_name}` with "Engineering", "Platform", "Backend", etc., producing concrete query strings instead of placeholder tokens (this directly improves cosine similarity at query time)
3. Also generates 10 additional queries per operation via GPT
4. **Merges** its entries into the existing `.rag-index-docs.json` (removes old forge entries, appends new ones) — preserving the REST entries

**Run order matters:** REST script writes the file from scratch; GraphQL script appends to it. Always run together:
```bash
npm run build-indexes
# equivalent to:
node scripts/build-doc-aware-index.js && node scripts/build-graphql-index.js
```

---

### 2.3 Session Context Store

**File:** `lib/context-store.js` (211 lines)

In-memory vector store for data returned by API calls during a session. Enables the agent to reuse previously fetched values (e.g., space IDs, team IDs) without making duplicate API calls.

**How it works:**
- After every API call, `addResult()` receives the raw response
- It "explodes" the response into individual text facts — one fact per array item:
  ```
  "listSpaces items: id=\"123\", key=\"ENG\", name=\"Engineering\""
  ```
- All facts from one response are batch-embedded in a single OpenAI call
- Facts are stored in an in-memory `_facts[]` array (max 500, FIFO trim)
- `search(queryText, n)` embeds the query and returns facts with cosine similarity ≥ 0.5

**Key functions:**
```
addResult(api, operationId, query, data)  → async; explodes + embeds + stores
search(queryText, n)                       → async; returns scored fact matches
hasContext()                               → boolean
clear()                                    → wipe all facts
getFactCount()                             → number of stored facts
```

---

### 2.4 Context Resolver

**File:** `lib/context-resolver.js` (154 lines)

Checks the session context store before running live grounding chains. If the required ID was already retrieved in this session, the grounding API call is skipped entirely.

**How it works:**
1. Reads the grounding chain's `extract` paths to determine what field names are needed
2. Constructs a targeted search string: `"{resolverOperationId} {entityValue} {paramName}"`
   - Example: `"listSpaces Engineering spaceKey"`
3. Calls `contextStore.search()` for each required parameter
4. Applies an **entity guard**: the matched fact text must contain the user's entity value (case-insensitive) — prevents "Alice" facts from satisfying a search for "Bob"
5. Returns `{ params, source }` if all parameters are resolved, or `null` if any are missing

**Called by:** `reasoning-planner.js`, before falling through to `grounding-executor.js`

---

## 3. Planning System

### 3.1 Doc-Aware Planner

**File:** `lib/doc-aware-planner.js` (600 lines) — largest file in the project

The primary planner. Unlike a naive planner that just passes the user query to GPT, this one first **reads the matched operation's full documentation** and uses it to generate accurate parameters.

**How it works:**
1. Receives the matched operation object (including the full `documentation` block from the RAG index)
2. Calls `formatForAI(doc)` to convert the documentation into a structured prompt block covering parameters, types, constraints, examples, and grounding rules
3. Sends a prompt to GPT-4o that includes the documentation and the user query; asks for a JSON plan with `parameters`, `entityValues`, and `apiCall` fields
4. The `entityValues` field is critical — it contains the human-provided names that will feed into grounding chains (e.g., `{ team_name: "Engineering" }`)
5. Calls `enrichPlanForCompleteness()` to add any required `expand` parameters or default values specified in the spec

**Key functions:**
```
generateDocAwarePlan(query, matchedOperation, availableOps)
  → { api, operationId, parameters, entityValues, steps[] }

enrichPlanForCompleteness(plan, operation)
  → plan with defaults and expansion params injected
```

---

### 3.2 Reasoning Planner

**File:** `lib/reasoning-planner.js` (347 lines)

Executes the plan produced by the doc-aware planner. Handles multi-step workflows, grounding chain resolution, and dispatching to the correct protocol (REST or GraphQL).

**How it works:**
1. Receives a plan (array of steps)
2. For each step:
   - Merges `step.entityValues` into the intent context
   - Calls `tryResolveFromContext()` (context resolver) — if it returns params, skip grounding
   - Otherwise runs the grounding chain via `grounding-executor.js` (REST) or `graphql-executor.js` (GraphQL)
   - Detects protocol by checking `schemaSpecs[step.api]` — if the API name exists in the Schema++ map it is GraphQL, otherwise REST
   - Executes the resolved call via `protocols/`
3. Passes results to `response-enricher.js`

**Key functions:**
```
generatePlan(query, availableOps, specs)  → plan steps via GPT
executePlan(plan, specs, schemaSpecs)     → execute steps, return results
getAllOperations(specs, schemaSpecs)      → flat list of all ops across all APIs
```

---

### 3.3 Candidate Reranker

**File:** `lib/candidate-reranker.js` (106 lines)

Takes the top-N RAG candidates and applies a second-pass rerank before committing to an operation. Considers semantic score, whether the operation has grounding support for the detected entities, and whether the user's phrasing aligns with the operation's guidance examples.

**File:** `lib/doc-retriever.js` (349 lines)

Formats the raw `documentation` object from the RAG index into structured prompts suitable for GPT. Extracts required parameters, validates parameter values against schema constraints, and formats examples. Used exclusively by `doc-aware-planner.js`.

---

## 4. Grounding System

Grounding solves the "ID problem": APIs require technical IDs but users speak in names. The grounding system runs resolver API calls to map names to IDs before executing the target call.

### 4.1 Grounding Detector

**File:** `lib/grounding-detector.js` (219 lines)

Runs at agent startup, before any user query is handled. Scans every REST operation in every loaded spec and auto-injects `x-postcall-grounding` chains for path/query parameters that end in `_id`, `Id`, `Uid`, or similar patterns — if the spec doesn't already have one.

This means spec authors don't have to manually write grounding chains for obvious ID parameters; the detector infers them from parameter names and finds a suitable resolver operation in the same spec.

---

### 4.2 Grounding Executor (REST)

**File:** `lib/grounding-executor.js` (405 lines)

Executes `x-postcall-grounding` chains defined in OAS++ specs. A grounding chain is an ordered sequence of resolver API calls whose outputs feed into each other and ultimately produce the ID the target operation needs.

**How it works:**
1. Reads the `steps[]` array from `x-postcall-grounding`
2. For each step:
   - Resolves `{{intent.xxx}}` and `{{steps[N].field}}` template variables
   - Calls `findOperation()` to locate the resolver's spec entry
   - Executes the resolver via the authenticated REST client
   - Applies the `extract` path (e.g., `"results[0].id"`) to pull the value out
   - If `required: true` and the extract path returns nothing, aborts with the `error_message`
3. Returns the resolved parameter map to the reasoning planner

---

### 4.3 GraphQL Executor

**File:** `lib/graphql-executor.js` (176 lines)

Handles both grounding chain execution and direct query execution for GraphQL Schema++ operations.

**How it works:**
- Reads the `graphql:` query document from the Schema++ operation
- Resolves `variables:` definitions — `source: "intent"` pulls from user input, `source: "grounding"` pulls from a prior grounding step
- Executes grounding steps using `variables:` (not `parameters:`) with `{{intent.xxx}}` templates
- Extract paths are relative to the operation's `response.dataPath`, not the raw GraphQL response root
- Reads `info['x-postcall-auth-discovery'].api_key` directly from the Schema++ spec for auth — no token storage needed for Forge

**Key difference from REST grounding:** REST grounding uses `parameters:` with URL/query substitution; GraphQL grounding uses `variables:` with GraphQL variable injection.

---

## 5. Authentication System

### 5.1 Console Auth

**File:** `lib/console-auth.js` (256 lines)

Prompts the user for credentials at the terminal when the agent detects a token is missing or expired. Supports masked input (passwords are not echoed). Handles:
- **Bearer token** APIs (GitHub): prompts for a personal access token
- **Basic Auth** APIs (Confluence): prompts for email + API token, encodes as Base64
- **API key** APIs (Forge): reads key directly from the Schema++ spec — no prompt needed
- **OAuth 2.0** APIs (Nile): initiates the authorization code flow

---

### 5.2 Token Storage

**File:** `lib/token-storage.js` (201 lines)

Persists tokens encrypted on disk at `.tokens.json`. Uses AES-256-CBC with a random IV per encryption operation so each stored token produces a different ciphertext even if the value is the same.

The encryption key is derived from the machine's hostname — tokens stored on one machine cannot be read on another.

On decrypt failure (e.g., tokens written by an older version without IV), the entry is automatically cleared and the user is prompted to re-authenticate.

**Key functions:**
```
storeToken(api, tokenData)   → encrypt + write to .tokens.json
getToken(api)                → decrypt + return, or null
hasToken(api)                → boolean check without decrypting
deleteToken(api)             → remove entry
```

---

### 5.3 API Client

**File:** `lib/api-client-simple.js` (421 lines)

Creates pre-configured `axios` instances for each API, injecting the correct auth header. Reads tokens from `token-storage.js` and injects them as:
- `Authorization: Bearer <token>` for GitHub
- `Authorization: Basic <base64>` for Confluence
- `X-API-Key: <key>` for Forge
- `Authorization: Bearer <oauth_token>` for Nile

Also handles Confluence's Cloud ID resolution: the Confluence API requires a `cloudId` obtained from `https://{domain}.atlassian.net/_edge/tenant_info` before any API call can be made. This lookup is cached in the session.

**Key functions:**
```
createClientFromSpec(api, spec, token)   → returns configured axios instance
loadFromEnvVars(api)                     → load tokens from .env (for testing)
```

---

## 6. Protocol System

**Files:** `lib/protocols/index.js`, `lib/protocols/http-protocol.js`, `lib/protocols/graphql-protocol.js`

A thin plugin layer that routes execution to the correct protocol handler based on whether the operation is REST or GraphQL. The reasoning planner calls `protocols/index.js` without knowing which protocol is in use.

- **`http-protocol.js`**: Builds the request URL (substituting path params), sets query params and request body, calls the axios client, returns the response
- **`graphql-protocol.js`**: Sends a `POST` with `{ query, variables }` to the GraphQL endpoint, reads `data[response.dataPath]` from the response
- **`protocols/index.js`**: Exports a single `executeOperation(step, specs, schemaSpecs, clients)` that delegates to the right handler

---

## 7. Error Recovery

**File:** `lib/error-recovery.js` (388 lines)

Wraps every API execution in a retry loop with OpenAI-guided self-healing.

**How it works:**
1. Executes the API call
2. On any 4xx error (except 401/403 which are treated as non-recoverable auth failures):
   - Logs the full request payload and response body
   - Sends both to GPT-4o with the prompt: "What went wrong and what should the corrected request look like?"
   - Applies GPT's suggested fix (corrected parameters, different endpoint variant, adjusted headers)
   - Retries up to 3 times
3. 401/403 errors immediately trigger `requestAuthForSpec()` to re-prompt for credentials

---

## 8. Output

**File:** `lib/response-enricher.js` (297 lines)

Post-processes every API response before displaying it to the user:
1. Calls the appropriate protocol plugin to extract the relevant data section
2. Formats the result as human-readable text (tables for lists, key-value for single objects)
3. Calls `contextStore.addResult()` to embed and store the response data for future grounding
4. Generates and prints clickable terminal links for resources that have URLs

**File:** `lib/terminal-link.js` (24 lines)

Wraps text in OSC 8 ANSI escape sequences to produce hyperlinks in terminals that support them (iTerm2, Windows Terminal, VS Code terminal).

---

## 9. API Specs

**Folder:** `specs/`

Four extended API specifications loaded at runtime. Each embeds PostCall-specific extensions that the plain OpenAPI/GraphQL standard does not provide.

### OAS++ Specs (REST)

| File | API | Size | Operations |
|---|---|---|---|
| `github-oas-plus.yaml` | GitHub REST API | 44.6 KB | ~15 ops |
| `confluence-oas-plus.yaml` | Atlassian Confluence | 26.9 KB | ~12 ops |
| `nile-oas-plus.yaml` | Nile mock ecommerce | 12.7 KB | ~8 ops |

**OAS++ extensions used:**

```yaml
info:
  x-postcall-auth-discovery:       # machine-readable auth metadata
    type: token
    scheme: bearer
    env_vars: { token: GITHUB_TOKEN }
  x-postcall-provisioning-url:     # link to create API keys / tokens

paths:
  /repos/{owner}/{repo}/issues:
    get:
      x-agent-guidance:            # natural language query seeds for RAG index
        - "list open issues in {repo_name}"
        - "show me bugs in my repository"
        entity_extraction:         # maps query words to intent parameter names
          repo_name: "The name of the repository"
      x-postcall-entity-hints:     # entity types the user provides by name
        repo_name: "GitHub repository name"
      x-postcall-grounding:        # resolver chain: name → ID
        steps:
          - operationId: listUserRepos
            parameters:
              name: "{{intent.repo_name}}"
            extract:
              repo: "name"
            required: true
            error_message: "Could not find repo '{{intent.repo_name}}'"
```

### Schema++ Spec (GraphQL)

| File | API | Size | Operations |
|---|---|---|---|
| `forge-schema-plus.yaml` | Forge project management | 15.8 KB | 9 ops |

**Schema++ format:**

```yaml
graphqlSchemaPlus: "1.0.0"
info:
  title: "Forge GraphQL API (Schema++)"
  x-postcall-auth-discovery:
    type: api_key
    api_key: forge-api-key-postcall-2024   # read directly, no token storage

server:
  url: http://localhost:9000/graphql
  protocol: graphql

schema: |                                   # embedded SDL
  type Query { ... }

operations:
  listTasksByTeam:
    type: query
    summary: "List all tasks assigned to a team"
    x-agent-guidance:
      - "show tasks for the Engineering team"
    x-postcall-grounding:
      steps:
        - operationId: listTeams
          variables:
            name: "{{intent.team_name}}"   # uses variables: not parameters:
          extract:
            teamId: "results[0].id"        # relative to response.dataPath
          required: true
    graphql: |
      query ListTasksByTeam($teamId: ID!) {
        tasksByTeam(teamId: $teamId) {
          id title status priority
          assignee { id name }
          project  { id name }
        }
      }
    variables:
      teamId:
        type: "ID!"
        source: grounding
        groundingParam: teamId
    response:
      dataPath: tasksByTeam
```

---

## 10. Test / Mock Servers

### 10.1 Nile Mock API

**File:** `mock-nile-api.js` (416 lines) | **Port:** `8000`

A full Express REST server simulating an ecommerce API. Used to test REST grounding chains and OAuth flows without hitting a real API.

**Endpoints:**
```
GET  /products              listProducts       (supports ?name=, ?categoryId=)
GET  /products/:id          getProduct
GET  /categories            listCategories
GET  /categories/:id        getCategory
GET  /orders                listOrders
GET  /orders/:id            getOrder
GET  /customers             listCustomers
GET  /customers/:id         getCustomer

GET  /oauth/authorize       OAuth approval page
POST /oauth/authorize       Issue auth code + redirect
POST /oauth/token           Exchange code / refresh token
```

**Auth:** Implements a full OAuth 2.0 Authorization Code flow in-memory. Pre-registered client: `client_id: postcall-agent`, `client_secret: postcall-secret`. Access tokens expire in 1 hour; refresh tokens in 30 days.

**Mock data:** In-memory JS arrays of products, categories, orders, and customers. No database — restarts reset state.

**Start:**
```bash
node mock-nile-api.js
```

---

### 10.2 Forge GraphQL Mock API

**File:** `mock-forge-api.js` (303 lines) | **Port:** `9000`

A GraphQL server built with `express-graphql` simulating a project management tool. Used to test Schema++ grounding chains and GraphQL execution.

**Schema / Queries:**
```
listTeams(name: String)         → [Team]
getTeam(id: ID!)                → Team
listMembers(teamId: ID)         → [Member]
getMember(id: ID!)              → Member
listProjects(teamId: ID)        → [Project]
listTasksByTeam(teamId: ID!)    → [Task]
listTasksByMember(memberId: ID!)→ [Task]
getTask(id: ID!)                → Task
```

**Auth:** Requires `X-API-Key: forge-api-key-postcall-2024` header on every request. Returns HTTP 401 without it. The key is also embedded in `specs/forge-schema-plus.yaml` so the agent reads it from the spec automatically.

**Mock data:** In-memory arrays of teams (Engineering, Product, Design, Marketing), members (Alice, Bob, Carol, David, Eva...), projects, and tasks. No database.

**Start:**
```bash
node mock-forge-api.js
```

---

## 11. Spec Converter Tools

These are **offline tools** — not used at agent runtime. Run them once to convert a standard API spec into an OAS++/Schema++ spec that PostCall can index and execute.

### 11.1 OAS++ Converter

**Folder:** `oas-plus-tool/`

Converts a standard OpenAPI 3.x YAML/JSON spec into an OAS++ spec using a two-pass GPT-4o pipeline.

```
oas-plus-tool/
├── convert.js              ← CLI entry point
└── lib/
    ├── spec-loader.js      ← Parse YAML/JSON, resolve $refs, extract summaries
    ├── global-analyzer.js  ← Pass 0+1: web doc search + GPT analysis → auth + grounding map
    ├── operation-enricher.js ← Pass 2: per-operation guidance + entity hints (5 ops per batch)
    └── oas-writer.js       ← Merge extensions into spec, write OAS++ YAML
```

**Pass 0 — Web doc search** (`global-analyzer.js`):
Calls the OpenAI Responses API with the `web_search_preview` tool to search for official documentation. The summary is injected into the Pass 1 prompt to improve accuracy.

**Pass 1 — Global analysis** (`global-analyzer.js`):
Sends a condensed operation list to GPT-4o and asks for:
- `authDiscovery` — auth type, scheme, env var names
- `resolvers[]` — which operations can resolve names to IDs
- `groundingChains{}` — which operations need which resolvers

**Pass 2 — Operation enrichment** (`operation-enricher.js`):
Batches 5 operations per GPT call and generates `x-agent-guidance` queries and `x-postcall-entity-hints` for each.

**Usage:**
```bash
node oas-plus-tool/convert.js                          # all files in input-specs/
node oas-plus-tool/convert.js Postman-API.yaml         # specific file
node oas-plus-tool/convert.js Postman-API.yaml --verbose
```

---

### 11.2 Schema++ Converter

**Folder:** `schema-plus-tool/`

Same two-pass approach as the OAS++ converter but for GraphQL SDL files.

```
schema-plus-tool/
├── convert.js              ← CLI entry point
└── lib/
    ├── schema-loader.js    ← Parse SDL with graphql.buildSchema(), extract Query fields
    ├── global-analyzer.js  ← Pass 0+1: web doc search + GPT analysis
    ├── operation-enricher.js ← Pass 2: guidance + GraphQL query documents + variable defs (3 per batch)
    └── schema-plus-writer.js ← Write Schema++ YAML
```

**Additional output vs OAS++:** The Schema++ enricher also generates, for each operation:
- `graphql:` — the full GraphQL query document string
- `variables:` — Schema++ variable definitions with `source: intent|grounding`
- `responseDataPath:` — the top-level field name in `data {}` to extract

**Usage:**
```bash
node schema-plus-tool/convert.js                               # all .graphql in input-schemas/
node schema-plus-tool/convert.js rick-and-morty.graphql        # specific file
node schema-plus-tool/convert.js shopify-storefront.graphql --server-url https://...
```

---

## 12. Complete Request Flow (Annotated)

```
User types: "show me tasks Arash is working on"
                │
                ▼
┌─────────────────────────────────┐
│  rag-matcher.js                 │
│  matchQueryTopN(query, 5)       │
│  → embed query (OpenAI)         │
│  → cosine over 663 entries      │
│  → top-5 candidates             │
└─────────────┬───────────────────┘
              │ [{forge/listTasksByMember, score:0.91}, ...]
              ▼
┌─────────────────────────────────┐
│  candidate-reranker.js          │
│  rerankCandidates(candidates)   │
│  → select forge/listTasksByMember
└─────────────┬───────────────────┘
              │ matchedOperation (with full documentation)
              ▼
┌─────────────────────────────────┐
│  console-auth.js                │
│  hasToken("forge")?             │
│  → YES: key in spec, skip prompt│
└─────────────┬───────────────────┘
              │
              ▼
┌─────────────────────────────────┐
│  doc-aware-planner.js           │
│  generateDocAwarePlan(query,op) │
│  → reads operation documentation│
│  → sends to GPT-4o              │
│  → extracts:                    │
│    entityValues: {              │
│      member_name: "Arash"       │
│    }                            │
└─────────────┬───────────────────┘
              │ plan with entityValues
              ▼
┌─────────────────────────────────┐
│  reasoning-planner.js           │
│  executePlan(plan)              │
│  → merge entityValues into intent
│  → call context-resolver first  │
└─────────────┬───────────────────┘
              │ context miss (first query)
              ▼
┌─────────────────────────────────┐
│  graphql-executor.js            │
│  (grounding step)               │
│  → listMembers(name="Arash")    │
│  → extract results[0].id = "109"│
└─────────────┬───────────────────┘
              │ memberId = "109"
              ▼
┌─────────────────────────────────┐
│  protocols/graphql-protocol.js  │
│  → POST localhost:9000/graphql  │
│    query: listTasksByMember     │
│    variables: { memberId:"109" }│
│  → response: [Task, Task, ...]  │
└─────────────┬───────────────────┘
              │ raw response
              ▼
┌─────────────────────────────────┐
│  response-enricher.js           │
│  → format as readable table     │
│  → contextStore.addResult()     │
│    (embeds tasks as facts for   │
│     future queries)             │
└─────────────┬───────────────────┘
              │
              ▼
  "Arash has 2 tasks:
   - Build auth module (IN_PROGRESS, API Gateway Redesign)
   - Write unit tests (TODO, API Gateway Redesign)"
```

---

## 13. Running the System

### Start mock servers (in separate terminals)
```bash
node mock-nile-api.js     # Nile ecommerce REST API  → localhost:8000
node mock-forge-api.js    # Forge GraphQL API        → localhost:9000
```

### Rebuild RAG indexes (after editing specs or adding new APIs)
```bash
npm run build-indexes
# runs: build-doc-aware-index.js → build-graphql-index.js
# output: .rag-index-docs.json (663 entries, ~30 MB)
```

### Start the agent
```bash
npm start
# or: node agent/postcall-agent-v2.js
```

### Convert a new spec (offline, one-time)
```bash
node oas-plus-tool/convert.js MyAPI.yaml --verbose
node schema-plus-tool/convert.js my-schema.graphql --server-url https://api.example.com/graphql
```

---

## 14. Key Design Decisions

**Why a pre-built JSON index rather than a vector database?**
The POC uses a 30 MB flat JSON file loaded into a memory array. This eliminates infrastructure dependencies (no Postgres, no Pinecone) and is fast enough for ~50 operations. The trade-off is that the entire index must be rebuilt when specs change, and session context facts are lost on restart. A PGVector migration would address both without changing any calling code.

**Why two separate planners?**
`reasoning-planner.js` handles multi-step orchestration and protocol routing. `doc-aware-planner.js` handles the harder problem of reading parameter documentation and generating correct values. They compose: the doc-aware planner produces a step plan that the reasoning planner executes.

**Why concrete names in the GraphQL index?**
`build-graphql-index.js` replaces `{team_name}` placeholders with real names ("Engineering", "Alice") before embedding. Placeholder tokens produce embeddings that are semantically distant from real queries containing real names — which directly degrades cosine similarity scores. Concrete names in the index match concrete names in user queries.

**Why is Forge auth read from the spec rather than token-storage?**
Forge uses a static API key that is part of the mock server setup. Embedding it in `forge-schema-plus.yaml` under `x-postcall-auth-discovery.api_key` means the agent can read it at runtime without prompting the user — this models how a real registry-registered API would advertise its own key.
