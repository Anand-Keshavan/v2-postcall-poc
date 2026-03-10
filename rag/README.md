# PostCall POC — Phase 4: RAG for intent → operation selection

## What this does

- **build-index.js**: Loads all OAS++ specs from the `specs/` directory and extracts searchable chunks from:
  - `x-agent-guidance` (array of example natural-language queries per operation)
  - Operation `summary`
  Each chunk is associated with an `operationId`, path, and method. Resolver-only operations (find_*, lookup, search) are indexed for context but primary operations with guidance rank higher for user intents.

- **retrieve.js**: Given a natural language query, scores chunks using **word-overlap cosine similarity** (term-frequency vectors). No external API or embedding service required. Returns the top-k operations deduplicated by `operationId`.

## Usage

The proxy loads the RAG index at startup and exposes:

- **POST /query** — Body: `{ "query": "I want to update the Marketing project settings in Acme Corp", "topK": 5 }`. Returns `{ query, results: [{ operationId, score, summary, pathTemplate, method, matched_text }, ...] }`.
- **POST /execute-by-intent** — Body: `{ "query", "intent", "body" }`. Uses the top result from the index for the query, then runs the full execute flow (grounding + primary call).

## Adding more operations

Add more OAS++ specs under `specs/` or add operations with **x-agent-guidance** in existing specs. The index is rebuilt when the proxy starts. Example guidance:

```yaml
x-agent-guidance:
  - "Update the settings for the Marketing project in Acme Corp"
  - "Change notification preferences for Marketing in Acme Corp"
```

More varied phrases improve match quality for natural language queries.
