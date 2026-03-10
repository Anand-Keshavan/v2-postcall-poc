# Forge GraphQL API — Schema++ Reference

## Overview

The Forge Project Management API is a GraphQL API covered by a **Schema++** specification (`specs/forge-schema-plus.yaml`). Schema++ is the GraphQL counterpart to OAS++ (used for REST APIs). It annotates a GraphQL schema with PostCall extensions that enable the agent to:

- Understand API operations in natural language (via `x-agent-guidance`)
- Authenticate automatically (via `x-postcall-auth-discovery`)
- Resolve human-readable names to technical IDs (via `x-postcall-grounding`)

## Running the API

```bash
node mock-forge-api.js
# Forge GraphQL API running on http://localhost:9000/graphql
# GraphiQL explorer available at http://localhost:9000/graphql
```

**Authentication:** Single API key — `forge-api-key-postcall-2024` — sent in the `X-API-Key` header.
The agent reads this key directly from the Schema++ spec; no manual token entry is needed.

## Data Model

```
Team  ──< Member  (team has many members)
Team  ──< Project (team owns many projects)
Project ──< Task  (project contains tasks)
Member ──< Task   (member is assigned tasks)
```

**Mock data:**
| Type | Count |
|------|-------|
| Teams | 4 (Engineering, Product, Design, Marketing) |
| Members | 8 (Alice Chen, Bob Kumar, Carol White, …) |
| Projects | 6 (API Gateway Redesign, Mobile App v2, …) |
| Tasks | 10 (Implement rate limiting, Write API docs, …) |

## Schema++ Format

```yaml
graphqlSchemaPlus: "1.0.0"

info:
  title: ...
  x-postcall-auth-discovery:
    type: api_key
    location: header
    header_name: X-API-Key
    api_key: forge-api-key-postcall-2024
  x-postcall-provisioning-url: http://localhost:9000/docs

server:
  url: http://localhost:9000/graphql
  protocol: graphql

schema: |
  # Embedded GraphQL SDL

operations:
  myOperation:
    type: query | mutation
    summary: Short description
    description: |
      Longer description for the planner.
    x-agent-guidance:
      - "example user query {with_placeholders}"
    x-postcall-grounding:        # optional
      steps:
        - operationId: resolverOp
          description: Resolve X to ID
          variables:
            name: "{{intent.x_name}}"
          extract:
            xId: "resolverField.id"
    graphql: |
      query MyOp($xId: ID!) { ... }
    variables:
      xId:
        type: ID!
        source: grounding
        groundingParam: xId
        description: Resolved automatically
    response:
      dataPath: fieldName   # top-level field in GraphQL response data
```

## Supported Operations

### Simple (no grounding)

| Operation | Example query |
|-----------|---------------|
| `listTeams` | "list all teams in Forge" |
| `listAllMembers` | "show everyone in Forge" |
| `listAllProjects` | "show all projects" |

### Resolver operations (used by grounding chains)

| Operation | Resolves |
|-----------|----------|
| `findTeamByName` | team name → team ID |
| `findMemberByName` | member name → member ID |
| `findProjectByName` | project name → project ID |

### Grounding-capable (names → IDs auto-resolved)

| Operation | Example query | Grounding |
|-----------|---------------|-----------|
| `listTasksByTeam` | "show tasks for the Engineering team" | team name → teamId |
| `listProjectsByTeam` | "what projects does Design own" | team name → teamId |
| `listMembersByTeam` | "who is in the Marketing team" | team name → teamId |
| `listTasksByProject` | "show tasks in API Gateway Redesign" | project name → projectId |
| `listTasksByMember` | "what is Alice Chen working on" | member name → memberId |

## Grounding Chain Example

When the user asks *"show tasks for the Engineering team"*:

1. **RAG match** → `listTasksByTeam` (grounded operation)
2. **Doc-aware planner** extracts `entityValues: { team_name: "Engineering" }`
3. **GraphQL grounding chain** runs:
   ```graphql
   query FindTeamByName($name: String!) {
     teamByName(name: $name) { id name }
   }
   # variables: { name: "Engineering" }
   # extracts: teamId = teamByName.id = "1"
   ```
4. **Main query** runs with resolved `teamId`:
   ```graphql
   query ListTasksByTeam($teamId: ID!) {
     tasksByTeam(teamId: $teamId) {
       id title status priority
       assignee { name email }
       project { name }
     }
   }
   # variables: { teamId: "1" }
   ```

## RAG Index

The Forge operations are indexed in `.rag-index-docs.json` alongside REST operations.
Each operation generates 10 user-intent queries via OpenAI (`gpt-4o-mini`).

To rebuild the Forge index (after modifying the spec):
```bash
node scripts/build-graphql-index.js
# or specify a custom spec:
node scripts/build-graphql-index.js path/to/other-schema-plus.yaml
```

The builder appends to the existing index, removing previous entries for the same API to prevent duplicates.

## Key Files

| File | Purpose |
|------|---------|
| `mock-forge-api.js` | GraphQL mock server (Express + graphql-http) |
| `specs/forge-schema-plus.yaml` | Schema++ specification |
| `lib/graphql-executor.js` | GraphQL execution: grounding chains, request building, client creation |
| `scripts/build-graphql-index.js` | Index builder for Schema++ operations |
