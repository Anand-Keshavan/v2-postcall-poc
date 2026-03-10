# RAG Index Builder

## Overview

The RAG Index Builder automatically generates natural language query variations for every API endpoint in your OpenAPI specs and creates vector embeddings for semantic search.

## How It Works

```
OpenAPI Specs (.yaml/.json)
         ↓
Extract all operations (GET, POST, etc.)
         ↓
For each operation:
  - Use OpenAI to generate 8-10 natural language query variations
  - Create vector embeddings for each query
         ↓
Save to .rag-index.json
         ↓
Agent loads pre-built index on startup
```

## Why This Approach?

**Before**: Manual `x-agent-guidance` in specs
- Limited query variations
- Manual maintenance required
- Hardcoded in YAML

**Now**: AI-generated query database
- 8-10 variations per endpoint automatically
- Rich semantic coverage
- Separation of concerns (indexing vs runtime)

## Usage

### 1. Build the Index

```bash
npm run build-index
```

This will:
- Read all `.yaml` and `.json` files from `specs/` directory
- Extract every API operation (endpoints)
- Use OpenAI to generate natural language queries for each
- Create embeddings using `text-embedding-3-small`
- Save to `.rag-index.json` (~500KB-2MB depending on API size)

**Example Output:**
```
╔════════════════════════════════════════════════════════════╗
║              RAG Index Builder                             ║
╚════════════════════════════════════════════════════════════╝

[1/4] Loading OpenAPI specs...
      ✓ Loaded github-oas-plus.yaml
      ✓ Loaded confluence-oas-plus.yaml
      ✓ Loaded 2 API spec(s)

[2/4] Extracting API operations...
      ✓ Found 12 operation(s)

[3/4] Generating natural language queries...
      [1/12] github / listUserRepos... 10 queries
      [2/12] github / listIssues... 9 queries
      [3/12] github / getAuthenticatedUser... 8 queries
      ...
      ✓ Generated 108 total queries

[4/4] Saving index to disk...
      ✓ Index saved to .rag-index.json
      Size: 1,234.56 KB

✅ RAG Index built successfully!
```

### 2. Run the Agent

```bash
npm start
```

The agent will automatically load the pre-built index:

```
[PostCall] Loading RAG index...
[RAG] ✓ Loaded index: 108 entries
[RAG]   Created: 3/5/2026, 10:30:00 AM
[RAG]   Operations: 12, Queries: 108
```

## Generated Query Examples

For `GET /user/repos` (List user repositories), OpenAI generates:

```json
[
  "list my repositories",
  "show me my repos",
  "what repos do I have?",
  "get my repositories",
  "display all my repositories",
  "show repositories",
  "list all repos I own",
  "fetch my repo list",
  "what repositories am I working on?",
  "show me all my GitHub repositories"
]
```

Each query gets its own embedding, so the agent can match any variation!

## Rebuilding the Index

Rebuild when you:
- Add new API operations to specs
- Update operation descriptions
- Want to regenerate query variations

```bash
npm run build-index
```

The agent automatically detects and loads the new index on next startup.

## Fallback Behavior

If `.rag-index.json` doesn't exist:

```
[RAG] ⚠ No pre-built index found
[RAG]   Run: node scripts/build-rag-index.js
[RAG]   Falling back to keyword matching
```

The agent will use the old method (reading `x-agent-guidance` from specs).

## File Structure

```
.rag-index.json          # Pre-built vector database
├── version              # Index format version
├── created_at           # Timestamp
├── total_operations     # Number of operations indexed
├── total_queries        # Total generated queries
└── index[]              # Array of entries
    ├── query            # Natural language query
    ├── embedding        # 1536-dim vector (OpenAI)
    ├── api              # "github" or "confluence"
    ├── operationId      # "listUserRepos"
    ├── path             # "/user/repos"
    ├── method           # "GET"
    └── summary          # Operation description
```

## Requirements

- **OPENAI_API_KEY** in `.env` file
- OpenAI API credits (embedding costs ~$0.0001 per 1K tokens)

Typical cost for indexing 10-20 operations: **< $0.10**

## Performance

**Before (building on startup):**
- 10-15 seconds to start agent
- Rebuilds every time

**Now (pre-built index):**
- <1 second to load index
- Only rebuild when needed

## Customization

Edit `scripts/build-rag-index.js` to:
- Change number of queries generated (default: 8-10)
- Adjust OpenAI temperature (default: 0.8 for diversity)
- Filter which operations to index
- Use different embedding models

## Troubleshooting

**"OPENAI_API_KEY not found"**
- Add `OPENAI_API_KEY=sk-...` to `.env` file

**"Failed to load specs"**
- Check specs are valid YAML/JSON
- Ensure specs are in `specs/` directory

**"OpenAI error: Rate limit"**
- Script includes 100ms delay between requests
- If hitting limits, increase delay in code

**Index too large**
- Each query needs ~6KB (1536-dim vector)
- 100 queries = ~600KB
- Acceptable for most projects
