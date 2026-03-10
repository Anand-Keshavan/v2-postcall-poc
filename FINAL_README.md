# PostCall AI Agent - Complete Implementation

**Natural language → API calls** with automatic authentication and grounding.

## 🎯 The PostCall Experience

```
You: show me issues in my test-repo

🤖 PostCall Agent
   Query: "show me issues in my test-repo"

[1/5] Matching query to operation...
      ✓ Matched: github / listIssues (confidence: 95%)
      Intent: { repo_name: "test-repo" }

[2/5] Checking authentication...
      ⚠ No credentials found for github

╔════════════════════════════════════════════════════════════╗
║       GitHub Authentication Required                       ║
╚════════════════════════════════════════════════════════════╝

PostCall needs a GitHub Personal Access Token.

Steps:
1. Visit: https://github.com/settings/tokens/new?...
2. Give it a name: "PostCall Agent"
3. Select scopes: repo, read:user, user:email
4. Click "Generate token"
5. Copy the token (starts with ghp_)

Paste your GitHub token (input hidden): **************

      ✓ Credentials stored!

[3/5] Creating API client...
      ✓ Client ready

[4/5] Resolving parameters...
      Executing grounding chain...
      [Grounding] Step 1: Get authenticated user → octocat
      [Grounding] Step 2: Search for test-repo → octocat/test-repo
      ✓ Parameters resolved: { owner: "octocat", repo: "test-repo" }

[5/5] Calling API...
      GET /repos/octocat/test-repo/issues

✅ Success!

📋 Found 5 issue(s):

1. #42: Bug: Login button not working
   State: open
   URL: https://github.com/octocat/test-repo/issues/42

2. #41: Feature: Add dark mode
   State: open
   URL: https://github.com/octocat/test-repo/issues/41

... and 3 more
```

## 🚀 Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. (Optional) Add OpenAI API Key

For better natural language understanding:

```bash
# Create .env file
echo "OPENAI_API_KEY=sk-your-key-here" > .env
```

Without OpenAI, the agent uses keyword matching (still works!).

### 3. Build the Documentation-Aware Index (Recommended)

Generate natural language query variations AND extract complete API documentation:

```bash
npm run build-doc-index
```

This creates a comprehensive index with:
- 8-10 query variations per endpoint
- Complete parameter documentation with constraints
- Request/response schemas
- Examples and usage patterns
- Vector embeddings for semantic search

**Alternative:** Basic index (faster, but less intelligent)
```bash
npm run build-index
```

Only needs to be run once (or when specs change).

### 4. Run the Agent

```bash
npm start
```

### 5. Ask a Question

```
You: list my repositories
```

**The agent will:**
1. ✓ Understand your query using RAG
2. ✓ Create a multi-step execution plan (reasoning)
3. ✓ Prompt for credentials in console (if needed)
4. ✓ Execute grounding chains to resolve "test-repo" → owner/repo
5. ✓ Execute plan (single or multi-step API calls)
6. ✓ Display results

## 🎭 What Makes This PostCall

### 1. Natural Language Interface
- No curl commands
- No technical parameters
- Just ask in plain English

### 2. Intelligent Operation Matching
- RAG with OpenAI embeddings (semantic)
- Falls back to keyword matching (no OpenAI needed)
- Matches query to operation using `x-agent-guidance`

### 3. Interactive Auth Provisioning
- Agent prompts in console with provisioning URL
- Masked password input (token not visible)
- Token stored securely and encrypted
- Never needed again!

### 4. Automatic Grounding
- User: "my test-repo"
- Agent: Resolves to `octocat/test-repo` automatically
- Multi-step chains (space → page → comment)

### 5. Multi-Step Reasoning
- Agent creates execution plans for complex queries
- Uses OpenAI for intelligent planning (or rule-based fallback)
- Executes multiple API calls in sequence
- Aggregates results automatically

### 6. Documentation-Aware Intelligence 🆕
- **Reads and understands** complete API documentation before making calls
- Extracts parameter descriptions, constraints, examples
- Understands special syntax (like GitHub's `org:name` qualifier)
- Validates parameters against schemas
- Generates correct parameters from natural language
- See [DOC-AWARE-SYSTEM.md](DOC-AWARE-SYSTEM.md) for details

### 7. Self-Healing Error Recovery 🆕
- **Automatic error correction** using OpenAI
- When API calls fail: analyzes error → fixes parameters → retries
- Works with **ANY API** generically
- No manual intervention needed
- See [ERROR-RECOVERY.md](ERROR-RECOVERY.md) for details

### 8. OAS++ Driven
- `x-postcall-provisioning-url` - Where to get tokens
- `x-postcall-auth-discovery` - How to use them
- `x-postcall-grounding` - How to resolve IDs
- `x-agent-guidance` - Natural language examples

## 📚 Supported Queries

### GitHub

```
• "show me issues in my test-repo"
• "list issues in test-repo"
• "list my repositories"
• "show my repos"
```

### Confluence

```
• "list spaces in Confluence"
• "list spaces"
• "search for Onboarding"
```

## 🏗️ Architecture

```
Natural Language Query
       ↓
RAG Matcher (Documentation-Aware Vector DB)
  → Semantic search with OpenAI embeddings
  → Matches from 8-10 query variations per endpoint
  → Returns operation + FULL DOCUMENTATION
       ↓
📚 READ DOCUMENTATION
  → Complete parameter descriptions
  → Constraints (enum, pattern, range)
  → Examples and special syntax
  → Request/response schemas
       ↓
🧠 UNDERSTAND WITH AI (OpenAI reads docs)
  → Identifies required parameters
  → Understands special syntax (like GitHub "org:")
  → Generates correct parameters from query
  → Validates against constraints
       ↓
Reasoning Planner
  → Creates multi-step execution plan
  → Uses documentation-informed parameters
  → Analyzes dependencies
       ↓
Auth Check
  → Has token? Continue
  → No token?
      → Display provisioning URL
      → Prompt for token (masked input)
      → User pastes token
      → Store encrypted locally
       ↓
Grounding Execution (if needed)
  → Execute resolver chain
  → Resolve names → IDs
       ↓
API Call (with Auto Error Recovery)
  → Execute with correct parameters
  → If error: Send to OpenAI for analysis
  → OpenAI fixes parameters → Retry
  → Success!
       ↓
Results (formatted)
```

## 🔑 Key Files

### Agent
- `agent/postcall-agent-v2.js` - Main reasoning agent with multi-step planning

### Libraries
- `lib/rag-matcher.js` - RAG-based operation matching (loads pre-built index)
- `lib/reasoning-planner.js` - Multi-step reasoning and planning
- `lib/console-auth.js` - Console-based auth with masked password input
- `lib/grounding-executor.js` - Grounding chain execution
- `lib/token-storage.js` - Local encrypted token storage

### Scripts
- `scripts/build-rag-index.js` - Generate query variations and embeddings

### Specs
- `specs/github-oas-plus.yaml` - GitHub API with OAS++ extensions
- `specs/confluence-oas-plus.yaml` - Confluence API with OAS++ extensions

### Generated
- `.rag-index.json` - Pre-built vector database (auto-generated)

## 🎬 Demo Flow

### First Time (No Credentials)

```bash
npm start

You: list issues in test-repo

# Agent shows GitHub auth screen
# Displays link to get token
# Prompts: "Paste your GitHub token (input hidden): "
# User pastes token (hidden with ***)
# Token stored
# Grounding executes automatically
# Results displayed
```

### Second Time (Credentials Stored)

```bash
npm start

You: show me issues in my other-repo

# No browser! Uses stored token
# Grounding resolves other-repo
# Results displayed immediately
```

## 🔬 Testing Without Credentials

The agent will demonstrate the auth flow:

```bash
npm start

You: list my repositories

# Agent shows:
# - RAG matching (95% confidence)
# - Auth screen with provisioning URL
# - Masked password prompt
# - You can press Ctrl+C to exit
```

To test the full flow, get a real token from the provisioning URL.

## 🌟 OAS++ Extensions Demonstrated

### Auth Discovery
```yaml
info:
  x-postcall-provisioning-url: https://github.com/settings/tokens/new?...
  x-postcall-auth-discovery:
    type: token
    scheme: bearer
```

### Grounding Chain
```yaml
x-postcall-grounding:
  steps:
    - operationId: getAuthenticatedUser
      extract:
        owner: "login"
    - operationId: searchRepos
      parameters:
        q: "{{intent.repo_name}} user:{{steps[0].owner}}"
      extract:
        owner: "items[0].owner.login"
        repo: "items[0].name"
```

### Agent Guidance
```yaml
x-agent-guidance:
  - "show me issues in my {repo_name} repo"
  - "list issues in {repo_name}"
```

## 💡 Design Principles

1. **User Never Sees Technical Details**
   - No `owner/repo` required
   - No manual token management
   - No curl commands

2. **OAS++ is Source of Truth**
   - Provisioning URLs in spec
   - Grounding chains in spec
   - Natural language examples in spec

3. **Agent Handles Everything**
   - Operation matching
   - Auth provisioning
   - Parameter resolution
   - Error recovery

## 🎓 What This Demonstrates

✅ **Natural Language API Interface**
- RAG-based query understanding
- Intent extraction
- No technical knowledge required

✅ **Seamless Authentication**
- Interactive browser flow
- Automatic token storage
- Never needed again

✅ **Intelligent Grounding**
- Multi-step resolver chains
- Name → ID resolution
- Completely transparent to user

✅ **OAS++ Specification**
- Machine-readable auth metadata
- Grounding chains
- Agent guidance

This is **PostCall** - making APIs agent-ready!

## 📖 References

- **OAS++ Specification**: See `specs/` directory
- **POC Guide**: See `POC-GUIDE.md`
- **Design Document**: See `PostCall Universal API Platform - Redesign-030326-020734.pdf`
