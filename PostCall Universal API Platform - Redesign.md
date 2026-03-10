 

# **PostCall Universal API Platform \- Redesign**

*This document is still under construction. During the POC stage we discovered several issues with the current API definition standards which are blockers . To overcome these we are looking at a redesign from first principles to achieve the goals of PostCall.*

## **Executive Summary**

This document proposes a new architecture for [**PostCall**, a universal API invocation platform](https://postmanlabs.atlassian.net/wiki/spaces/AGENTMODE/pages/6764101786) designed to act as an "Autonomous API Courier" for AI agents. Following iterations during the Proof of Concept (POC) stage, several critical blockers were identified: missing machine-readable authentication metadata, difficulty mapping natural language names to technical IDs, and inconsistent API payload definitions.

To resolve these, this document proposes three new interoperable standards (**OAS++**, **Schema++**, and **MCP++**) and a rigorous **Publishing Validation Gate**. Unlike standard registries, PostCall will mandate 100% metadata compliance (required fields, examples, and auth discovery) at the point of ingestion. To facilitate this, an **LLM-Powered Normalization Service** will be provided to assist publishers in "upgrading" legacy documentation into agent-ready specifications. Execution is handled by a **Universal Proxy** that normalizes REST, GraphQL, and MCP server interactions into a single agentic workflow.

---

## **1\. PostCall Vision and Goals**

PostCall aims to provide a seamless gateway for global API interaction by humans and AI agents. The platform is driven by four primary objectives:

* **Universal Access:** A single interface that abstracts REST, GraphQL, and MCP protocols.  
* **Natural Language Control:** Invoking complex functions using high-level "intent" rather than technical parameters.  
* **Autonomous Operation:** Enabling agents to plan workflows, refresh tokens, and resolve errors independently.  
* **Federated Discovery:** A searchable, RAG-enabled directory of global API capabilities.

### **Lessons from the POC Stage**

Initial iterations revealed that current API standards are not "agent-ready." Key blockers included:

* **Missing Auth Metadata:** Schemas lack OAuth authorization URLs, preventing the CLI from starting login flows.  
* **The "ID Problem":** Agents cannot map human names to opaque technical IDs required by APIs.  
* **Payload Inconsistency:** Missing "required" field indicators force the CLI to prompt users for every variable.  
* **Discovery Walls:** Searchable directories cannot be built for gated MCP servers before authentication.

The details of the POC data are available [here](https://postmanlabs.atlassian.net/wiki/spaces/~996232551/pages/7529234568)

This document proposes formal extensions and strict publishing gates to embed this missing metadata directly into the protocol layer.

---

## **2\. Summary of Proposed Schema Extensions**

### **2.1 Extensions to OpenAPI 3.0 / 3.1 (OAS++)**

* `x-postcall-auth-discovery`: Provides machine-readable endpoints for OAuth 2.1/OIDC discovery (RFC 8414\) and Protected Resource Metadata (RFC 9728).  
* `x-postcall-provisioning-url`: A direct link for users to generate API keys or register credentials manually.  
* `x-postcall-grounding`: (Array of Steps) Defines an ordered sequence of resolver operations to map natural language names to technical IDs. Each step references a valid `operationId` and maps parameters from the user's intent or previous step outputs. Each step supports a `required: true` flag and an `error_message` field. When `required` is set, the proxy aborts with a clear diagnostic if the step's `extract` path resolves to nothing — preventing the silent failure mode where an unresolved `undefined` ID propagates into downstream calls and produces cryptic 400/404 errors with no indication of what actually failed.  
     
* `x-context-scope`: (Enum: `user` | `organization` | `session`) Provides a contextual hint to the agent regarding the boundary of the required data. This ensures the agent knows whether to retrieve state from the active user profile, the global organizational configuration, or the current interaction session .  
* `x-agent-guidance`: (Array of Strings) A list of example queries used to trigger specific endpoints. It also supports an `entity_extraction` sub-map that explicitly tells the planner which words in a user query bind to which intent parameter names (e.g., `page_name`, `project_name`, `team_name`). Every grounding variable `{{intent.X}}` used in a grounding chain **must** have a matching `entity_extraction` entry; without it, the binding may be silently skipped and the grounding chain will execute with an unresolved parameter.
* **Mandatory Standards Enforcement**: OAS++ makes existing standard OpenAPI 3.x `required` arrays and `example` fields **non-optional**. Schemas that omit these fields are rejected at the publishing gate to ensure deterministic model behavior.

***A note on “grounding”:***

| Grounding connects an AI agent’s abstract reasoning to real-world data and actions. It bridges vague natural language conversations to deterministic, actionable tasks by providing specific context. In APIs, this often involves "Entity Grounding," mapping a human-friendly name to a unique technical identifier required by the software. For example, if a user asks to "check the shipping status of my blue jacket," grounding resolves "blue jacket" to a specific `tracking_id` (like `TRK-12345`) from the user's order history before making the API call. Similarly, if a user wants to "update the Marketing workspace," grounding identifies the correct `workspace_id` so the agent avoids guessing or hallucinating an ID. Ideally, the publisher provides a specific "resolver" or "lookup" API call to facilitate grounding.   Without a dedicated grounding operation, an autonomous agent may hallucinate or guess a technical ID, causing silent failures or incorrect results. The proposed OAS++ architecture formalizes this through the `x-postcall-grounding` extension, where an endpoint declares a specific `resolver_operation` the agent calls first to map a human-friendly name to the required ID.   For example, a service requiring a `cartId` should expose a companion "search" or "list" tool allowing the agent to find the active cart by name or date before executing the primary task. This dedicated call keeps the agent grounded in actual system data rather than abstract reasoning. *This is one of the hardest problems in making APIs available to AI Agents. Adding a link to a “grounding” resolver may be a possible solution.*Example of grounding resolver in REST:In this scenario, the user intent is: *"Update the settings for the 'Marketing' project in the 'Acme Corp' organization.* `paths:   /projects/{projectId}/settings:     patch:       summary: "Update project settings"       parameters:         - name: "projectId"           in: "path"           required: true           x-context-scope: "organization"           x-postcall-grounding:             steps:               - operationId: "find_org_by_name"                 description: "Resolves 'Acme Corp' to an org_id"                 parameters:                   name: "{{intent.org_name}}"               - operationId: "find_project_in_org"                 description: "Resolves 'Marketing' to a project_id within the org"                 parameters:                   orgId: "{{steps.id}}"                   projectName: "{{intent.project_name}}"           schema: { type: "string" }` Supporting Resolver Operations The agent uses the `operationId` references above to locate and execute these specific tools from the registry. Step 1: The Org Resolver Target Call: `GET /organizations/search?name=Acme+Corp` Response Payload: `{"id": "org_8821", "name": "Acme Corp"}`  Step 2: The Project Resolver (Scoped by Step 1\) Target Call: `GET /organizations/org_8821/projects/lookup?projectName=Marketing` Response Payload: `{"id": "proj_abc_123", "status": "active"}`  Resulting Execution The agent captures the `id` from the final step (`proj_abc_123`) and injects it into the primary request, completing the grounding process without any "ID guesswork" or manual user data entry.    `/organizations/search:     get:       operationId: "find_org_by_name"       parameters:         - name: "name"           in: "query"           required: true           schema: { type: "string" }   /organizations/{orgId}/projects/lookup:     get:       operationId: "find_project_in_org"       parameters:         - name: "orgId"           in: "path"           required: true         - name: "projectName"           in: "query"           required: true`  Example in GraphQL:Hierarchical Resolver Chain The agent executes the defined query chain sequentially, passing the results forward to resolve the final `id` argumen `schema:   sdl: |     enum ContextScope { USER, ORG, SESSION }     directive @grounding(resolvers:, scope: ContextScope) on ARGUMENT_DEFINITION     type Query {       projectDetails(         id: ID! @grounding(           resolvers: [             { query: "resolveOrg", args: { name: "$intent.org" } },             { query: "resolveProject", args: { orgId: "$steps.id", name: "$intent.proj" } }           ],            scope: ORG         )       ): Project     }`   |   |
| ----- | ----- |
|      |   |

### **2.2 Extensions to GraphQL (Schema++)**

* **YAML Manifest Wrapper**: metadata file providing service-wide intent and auth discovery.
* `@agentGuidance(queries:)`: A custom directive for fields providing example queries for the RAG index. Like the OAS++ counterpart, it supports an `entity_extraction` sub-map to bind named entities in the query (e.g., a team name, a member name) to the specific variable names used in the grounding chain. This is equally mandatory in Schema++: every `{{intent.X}}` variable must be declared here.
* `@auth(scopes:)`: A directive mapping field-level permissions to the discovery layer.
* `@grounding(resolvers:, scope: ContextScope)`: A directive for arguments or fields defining a chain of queries or mutations to resolve entities. It allows the agent to follow a multi-step lookup path while respecting the defined security and data `scope` (USER, ORG, or SESSION). Resolver steps support `required: true` and `error_message` for fail-fast validation. Note that in Schema++, extract paths in each step are relative to the `response.dataPath` of the resolver operation, not the raw GraphQL response root — a common authoring mistake that causes silent extraction failures.
* **Pre-selected Field Sets**: GraphQL has no optional expansion parameters — the query itself defines which fields are returned. Schema++ spec authors must pre-select all fields the user might need directly in the `graphql:` query block. The agent cannot add fields at runtime; shallow queries produce shallow answers regardless of user intent.

### **2.3 Extensions to MCP (MCP++)**

* `authDiscovery` **field in** `initialize`: Servers advertise authentication requirements during the handshake.  
* `mode: sensitive` **in** `elicitation/request`: Masks user input to prevent secrets from being logged in LLM history.  
* `auth_required_challenge` **error code**: Standardizes how servers request token refreshes or MFA checks mid-execution.

Postman will need to build partnerships to create these standard extensions

---

### **2.4 Spec Authoring Contract — Three Required Patterns**

The extensions described above are the vocabulary. The authoring contract is the discipline. POC experience showed that declaring the right extension fields is necessary but not sufficient — three specific patterns must be applied correctly or the agent will fail silently at runtime. These patterns apply equally to OAS++ and Schema++.

#### **Pattern 1 — Entity Extraction Hints**

Every grounding chain contains `{{intent.X}}` variable references. These only resolve correctly if the doc-aware planner was told, at spec authoring time, what kind of natural language phrase maps to `X`. Without this hint the LLM may extract the wrong word, extract nothing, or bind the right word to the wrong parameter name.

**Rule:** For every `{{intent.X}}` variable used anywhere in a grounding chain, add a corresponding entry in `x-agent-guidance.entity_extraction` (OAS++) or the equivalent manifest block (Schema++).

```yaml
# OAS++ example — getPageById operation
x-agent-guidance:
  - "get page {page_name}"
  - "show me the {page_name} page in {space_name}"
  entity_extraction:
    page_name: "The title or name of the page the user is looking for"
    space_name: "The Confluence space name or key, if mentioned"
x-postcall-grounding:
  steps:
    - operationId: searchContent
      parameters:
        cql: "type=page AND title~\"{{intent.page_name}}\""
```

```yaml
# Schema++ equivalent — listTasksByProject operation
x-agent-guidance:
  - "show tasks in {project_name}"
  entity_extraction:
    project_name: "The name of the project the user is referring to"
x-postcall-grounding:
  steps:
    - operationId: findProjectByName
      variables:
        name: "{{intent.project_name}}"
```

The pattern is identical across both spec formats. Each key in `entity_extraction` is an `intent.X` variable name (without the `intent.` prefix); each value is a natural-language description that guides extraction.

---

#### **Pattern 2 — Grounding Path Validation**

Grounding steps use an `extract` map to pull values out of a resolver's response (e.g., `results[0].id`). If the resolver returns zero results — because the named entity was not found or the search was too strict — the extract path silently returns `undefined`. The downstream operation then executes with a blank or literal path parameter, producing a cryptic 400 or 404 error with no indication of what actually failed.

**Rule:** Mark every grounding step that produces a parameter required by the downstream operation as `required: true` and provide a human-readable `error_message`. The proxy aborts early and surfaces the diagnostic rather than continuing with an unresolved value.

```yaml
# OAS++ — mandatory grounding step with fail-fast validation
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

```yaml
# Schema++ — same flags; note extract path is relative to response.dataPath
x-postcall-grounding:
  steps:
    - operationId: findProjectByName
      variables:
        name: "{{intent.project_name}}"
      extract:
        project_id: "project.id"     # relative to dataPath of findProjectByName, not raw response
      required: true
      error_message: "No project found matching '{{intent.project_name}}'."
```

**Schema++ critical note:** The `extract` path is relative to the resolver operation's `response.dataPath` field, not the raw GraphQL response. If `findProjectByName` has `dataPath: "projectByName"`, the GraphQL response is `{ data: { projectByName: { id: "42" } } }` — after the platform extracts `projectByName`, the correct path is simply `"id"`, not `"projectByName.id"`. Always verify extract paths against the actual resolver response shape.

For optional enrichment steps (resolving a display name that is nice-to-have but not blocking) omit `required` or set `required: false`.

---

#### **Pattern 3 — Response Completeness**

Many APIs return a minimal payload by default — IDs, titles, and status flags — but not the content the user actually needs. Without spec-level guidance the agent will never add optional expansion parameters, and the summary will be a description of metadata rather than an answer to the question.

**OAS++ — set a `default` on the expansion parameter:**

```yaml
parameters:
  - name: expand
    in: query
    description: |
      Comma-separated list of properties to expand.
      Use "body.storage,version,space" to retrieve the full page content.
    schema:
      type: string
      default: "body.storage,version,space"
```

The proxy injects the default value for any expansion parameter not explicitly set by the planner. This is the minimum fix. For operations that serve multiple distinct user intents (e.g., "does this page exist?" vs "show me the page content"), add `intent_hints` to map the phrasing to the required expansion:

```yaml
x-agent-guidance:
  - "get page {page_name}"
  - "show me the content of {page_name}"
  entity_extraction:
    page_name: "The title of the page"
  intent_hints:
    "show content|read page|show me":     "expand=body.storage,version,space"
    "get metadata|find page|page exists": "expand=version,space"
```

**Schema++ — pre-select all needed fields in the `graphql:` query:**

GraphQL has no optional expansion parameters. The query itself is the field selector and the agent cannot add fields at runtime. The completeness burden falls entirely on the spec author.

```yaml
# Wrong — minimal query that cannot answer content questions
operations:
  getTask:
    graphql: |
      query GetTask($id: ID!) {
        task(id: $id) { id title status }
      }

# Right — complete query including all fields the user might ask about
operations:
  getTask:
    graphql: |
      query GetTask($id: ID!) {
        task(id: $id) {
          id title status priority
          assignee { id name email }
          project  { id name }
          team     { id name }
        }
      }
    response:
      dataPath: "task"
```

Rules for GraphQL field selection: include all scalar fields on the primary type; always expand nested objects (assignee, project, team) since raw IDs are not useful in a summary; when in doubt include more — servers handle unused fields gracefully.

---

#### **Comparison: OAS++ vs Schema++**

| Pattern | OAS++ (REST) | Schema++ (GraphQL) |
| :---- | :---- | :---- |
| **Entity extraction** | `x-agent-guidance.entity_extraction: { param: "description" }` | Identical field under the operation |
| **Grounding path validation** | `required: true` + `error_message` on each step; path relative to raw JSON response | Same flags; path is relative to `response.dataPath` of the resolver op |
| **Response completeness** | `default:` on expand param; optionally `intent_hints` for multi-intent ops | Pre-select all needed fields in the `graphql:` query — no runtime fix possible |

---

#### **Onboarding Checklist**

Before marking an operation as complete in any spec:

- [ ] Every `{{intent.X}}` variable has a matching `entity_extraction` entry with a natural-language description
- [ ] Every mandatory grounding step has `required: true` and `error_message`
- [ ] Extract paths have been verified against the actual resolver response shape (and against `dataPath` for Schema++)
- [ ] For REST: expansion parameters have a `default` or `intent_hints` covering the primary user intent
- [ ] For GraphQL: the `graphql:` query includes all scalar fields and nested objects the user might ask about
- [ ] For multi-step chains: later steps reference `{{steps[N].field}}` using the exact key name from the `extract` map of step N

---

## **3\. Unified Authentication Configuration**

These standardized blocks provide agents with machine-readable setup instructions across all formats.

| Auth Mode | Extension Requirement | Purpose |
| :---- | :---- | :---- |
| **OAuth 2.1** | `metadata_url` & `registration_url` | Automates client registration and token acquisition. |
| **API Key** | `provisioning_url` & `elicitation_mode: sensitive` | Directs user to keys and hides them from logs. |
| **AWS SigV4** | `service_name` & `region` | Provides parameters for the signature signing algorithm. |
| **Basic Auth** | `x-agent-guidance` (Array) | Informs agent that legacy LDAP credentials are required. |

---

## **4\. Global Registry & Publishing Pipeline**

The Global Registry is a decentralized system where independent sub-registries ingest and mirror public metadata. To ensure "Garbage In, Garbage Out" does not break the agentic ecosystem, all manifests must pass through a multi-stage validation pipeline.

### **4.1 How Publishers Add to the Registry**

Publishers follow a protocol-specific workflow by hosting manifests at `/.well-known/` locations (e.g., `openapi.yaml`, `graphql-manifest.yaml`, or `server.yaml`).

### **4.2 Publishing, Governance and Knowledge Base Transformation**

The federated architecture introduces specific challenges regarding deduplication and trust across distributed sub-registries. To ensure the integrity of the ecosystem, the following transformation and governance rules are proposed:

* **Canonical Identification and Versioning**: Every published manifest MUST include a globally unique canonical identifier and an immutable version reference, following standards like **SPDX identifiers** or **OCI image references**. This allows registries to identify and deduplicate identical services hosted across different mirrors while maintaining a clear history of schema evolution.  
* **Signature and Schema Validation**: Registries and crawlers MUST validate both the manifest schema and its cryptographic signature before mirroring or indexing. This "Validation-Before-Mirroring" gate is critical for preventing the propagation of divergent or spoofed copies of a service manifest, ensuring that agents only consume verified guidance.  
* **Ingestion and Chunking**: The system syncs only manifests that pass the signature check. Searchable fragments are then extracted from the `x-agent-guidance` query arrays and operation summaries.  
* **Vector Indexing**: These fragments are embedded into a **Vector Database** to enable high-accuracy, intent-driven tool selection (RAG).  
* **Identity Graphing**: Chained `x-postcall-grounding` metadata is processed to build a system-wide identity graph, allowing the Universal Proxy to resolve complex entity hierarchies autonomously.  
   

### **4.3 LLM-Powered Normalization Service**

To lower the barrier for publishers with legacy or unstructured documentation, PostCall provides a transformation service (inspired by OASBuilder) designed to "upgrade" these specs into agent-ready OAS++ or Schema++ formats. Recognizing that LLM inference can be non-deterministic, this service incorporates the following safeguards:

 

* **Confidence Scoring and Attribution**: The service MUST attach a confidence score (0.0 to 1.0) to every inferred property (e.g., `required` flags, `example` values, and parameter types). This allows the ingestion pipeline to automatically flag low-confidence inferences for manual review rather than indexing potentially incorrect metadata.  
     
* **Publisher Review Workflow**: PostCall provides a dedicated review interface where publishers can inspect "Draft" manifests generated by the service. Inferred properties are highlighted, allowing providers to verify, edit, or approve the metadata before it is cryptographically signed and published to the federated registry.  
     
* **Multi-Modal Verification (High-Value APIs)**: For high-priority or widely used services, the service cross-checks inferred schemas through two advanced methods:  
  * **Traffic Analysis**: It analyzes sampled API request/response traffic (via Postman) to empirically verify which fields are actually required in practice.  
       
  * **Fuzzing-Based Inference**: It utilizes an automated fuzzer to probe endpoints with varying payloads, confirming if the inferred schema correctly handles edge cases and mandatory parameter constraints.  
       
* **Certification Requirements**: A manifest is only declared "**PostCall Certified**" and prioritized in retrieval after it passes the confidence threshold and completes the multi-modal verification process. This ensures that the RAG Knowledge Base remains grounded in verified truth rather than LLM guesses.  
   

### **4.4 Knowledge Base Transformation**

1. **Ingestion:** The crawler syncs only manifests that pass the Validation Gate.  
2. **Semantic Chunking:** Searchable fragments are created from `x-agent-guidance` query arrays.  
3. **Vector Embedding:** Fragments are stored in a **Vector Database** for intent-based discovery.

---

## **5\. Execution via the Universal Proxy**

The Universal Proxy acts as a protocol-agnostic execution engine that handles the lifecycle of an API call without human intervention.

 

* **The Auth Handshake**: Upon receiving an `auth_required_challenge`, the proxy uses `authDiscovery` metadata to refresh tokens or securely elicit keys without breaking the agent's reasoning chain.  
* **Protocol Translation**:  
  * **REST**: Enforces `required` and `example` fields to drive model determinism and prevent unnecessary user prompts.  
  * **GraphQL**: Generates precise queries based on field-level directives and `@agentGuidance` context.  
       
  * **MCP**: Forwards JSON-RPC 2.0 messages and manages the elicitation lifecycle autonomously.  
       
* **Chained Entity Resolution**: The proxy identifies multi-step grounding chains and coordinates their sequential execution, passing resolved IDs as parameters to subsequent calls to prevent "ID guesswork".  
* **Agentic Observability Plane**: The proxy serves as a high-fidelity observability layer for agentic workloads. It captures **structured execution traces** that map the full lifecycle from the user's natural language intent through all intermediate grounding steps to the final protocol-specific payload.  
* **Continuous Evaluation Loop**: These traces are fed back into the **Agent Evaluation Loop** to systematically identify failures that static validation cannot catch, such as persistent hallucinations, missing or circular grounding resolvers, and intermittent authentication regressions. This telemetry allows the system to auto-generate "patches" for OAS++ and Schema++ manifests, improving the reliability of the federated registry over time.  
   

---

## **6\. Practical Considerations for Production Readiness**

### **6.1 Standardized Error Taxonomy**

Introduce an `error-type` taxonomy (e.g., **Type I: Tool Hallucination**, **Type III: Context Drift**) in OAS++ and MCP++. This allows the proxy to provide specific "recommender hints" to help the agent recover autonomously.

* Issue: Agents lack a structured way to classify failures, and engineers lack the telemetry to build automated policies.  
* Proposed Solution: Introduce an error-type taxonomy (e.g., Type I: Tool Hallucination, Type II: Parameter Binding Failure, Type III: Context Drift). These types MUST be emitted as structured fields in proxy logs and execution traces rather than purely descriptive labels.    
* Automation: Structured logs allow for automated policies, such as reducing tool temperature on Type I errors or re-running with stricter system prompt constraints on Type II errors.

### **6.2 Security: Integrity of Public Manifests and Trust Roots**

* Issue: Relying on public /.well-known/ manifests creates a risk of Tool Poisoning or Indirect Prompt Injection, where an attacker hosts malicious guidance to hijack an agent's reasoning.  
* Proposed Solution: Mandate cryptographic signing for all published manifests. This document proposes using established industry standards for signatures rather than proprietary mechanisms:  
  * Standard Formats: Implementations SHOULD use W3C Verifiable Credentials (VC) or JOSE (JWS/JWT) to provide tamper-evident proofs of authorship and content integrity.  
  * Trust Root Advertisement: Registries MUST advertise the trust roots they accept, such as organization-specific public keys or CA-issued certificates. This makes the federation more predictable and auditable, ensuring PostCall only indexes guidance from verified domains.

### **6.3 Operational Constraints (Rate Limits and Budgets)**

Include `x-postcall-usage-limits` metadata in OAS++. This gives agents machine-readable "tokens per minute" or "cost per call" data to drive throttling and planning.

### **6.4 Context Window Management**

Implement **Result-Set Summarization** in the Universal Proxy using `x-postcall-summarization-hint` to prevent "Context Overload" from large API responses.

### **6.5 Credential Mapping for Legacy Chains**

Add a **JIT Credential Mapping Layer** to the proxy. It uses verified user identity assertions to lookup mapped legacy static secrets in a secure vault, keeping the "Chain of Trust" unbroken.

---

## **7\. Where does Postman fit in?**

Postman serves as the foundational environment to enable and govern the PostCall ecosystem.

* **Registry Facilitation:** The Postman client and Public API Network can facilitate the initial creation and hosting of the Federated Global Registry.  
* **API Repackaging:** Postman provides the tooling to help publishers re-package existing services, implementing the required grounding tools and agent guidance.  
* **Semantic Search Gateway:** PostCall serves as the entry point for managing indexing and retrieval logic.  
* **PostCall as an MCP Service:** The PostCall engine itself can be exposed as an MCP service for third-party agents.

---

## **8\. Addressing PostCall Goals and POC Blockers**

| POC Blocker | Impacted Goal | Architectural Solution |
| :---- | :---- | :---- |
| **Missing Auth Metadata** | Transparent Auth | `x-postcall-auth-discovery` mandates RFC 8414 URLs. |
| **The "ID Problem"** | Natural Language Input | `x-postcall-grounding` declares resolver tools for mapping. |
| **Payload Inconsistency** | Autonomous Execution | **Validation Gate** enforces `required` and `example` fields at publishing. |
| **Discovery behind Auth** | Federated Discovery | Manifests at `/.well-known/` allow semantic indexing before login. |
| **Maintenance Intensity** | Scalability | **LLM Normalizer** automates documentation conversion. |

---

## **9\. Implementation Roadmap for the next stage**

1. **Finalize Standard Specs**: Finalize YAML schemas for `oas-plus.yaml`, `schema-plus.yaml`, and `server.yaml`, incorporating the three authoring contract patterns (entity extraction, grounding path validation, response completeness) as first-class fields.
2. **Build Validation Gate & Normalizer**: Develop the automated linter and LLM-powered spec enrichment service. The linter must enforce the authoring contract: reject any operation whose grounding chain contains an `{{intent.X}}` variable with no `entity_extraction` entry, any mandatory grounding step missing `required: true`, and any REST operation with expansion parameters missing a `default`.
3. **Deploy Agentic RAG**: Build the intent-driven tool selection engine using `x-agent-guidance` arrays and `entity_extraction` hints.
4. **Launch Proxy Alpha**: Deliver the Universal Proxy with support for identity chaining, grounding chain fail-fast validation, and AWS SigV4 signing.

   
 