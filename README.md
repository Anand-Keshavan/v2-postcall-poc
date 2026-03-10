# PostCall Universal API Platform - MVP POC

A working proof-of-concept demonstrating PostCall's core vision: making APIs agent-ready through enhanced OpenAPI specifications with grounding chains and auth discovery.

## 🎯 What This POC Demonstrates

### 1. **Auth Discovery & Token Provisioning**
- OAS++ specs contain `x-postcall-provisioning-url`
- First API call → Proxy returns URL to get token
- User gets token → Submits to proxy → Stored locally
- Future requests use stored token automatically

### 2. **Grounding Chains**
- Converts natural language to technical IDs
- Example: "Create issue in my test-repo" → Resolves repo name to `owner/repo`
- Multi-step resolver chains (space → page → comment)

### 3. **Natural Language Intent**
- User provides high-level intent, not technical parameters
- Proxy executes grounding chain automatically
- `x-agent-guidance` enables RAG-based operation discovery

## 🏗️ Architecture

```
User Request (Natural Language)
       ↓
PostCall Proxy
       ├─→ Check Token Storage
       │   ├─→ No token? Return provisioning URL
       │   └─→ Has token? Continue
       ├─→ Load OAS++ Spec
       ├─→ Execute Grounding Chain
       │   ├─→ Step 1: Resolve user context
       │   ├─→ Step 2: Search for entity
       │   └─→ Step 3: Extract IDs
       └─→ Execute Primary API Call
             ↓
       Return Result
```

## 📁 Key Files

### OAS++ Specifications
- `specs/github-oas-plus.yaml` - GitHub API with grounding
- `specs/confluence-oas-plus.yaml` - Confluence API with grounding

### Core Libraries
- `lib/token-storage.js` - Local token storage (encrypted)
- `lib/grounding-executor.js` - Grounding chain execution
- `lib/api-client-simple.js` - HTTP clients for GitHub & Confluence

### Proxy
- `proxy/postcall-proxy.js` - Main PostCall Universal Proxy

## 🚀 Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Start the Proxy

```bash
npm start
```

Visit http://localhost:3000

### 3. Try a Request (Without Token)

```bash
curl -X POST http://localhost:3000/execute \
  -H "Content-Type: application/json" \
  -d '{
    "api": "github",
    "operationId": "createIssue",
    "intent": {
      "repo_name": "test-repo",
      "title": "Bug: Login not working"
    }
  }'
```

**Response:**
```json
{
  "error": "Authentication required",
  "code": "auth_required_challenge",
  "provisioning_url": "https://github.com/settings/tokens/new?description=PostCall&scopes=repo,read:user,user:email",
  "next_steps": {
    "step1": "Visit: https://github.com/settings/tokens/new...",
    "step2": "Generate an API token",
    "step3": "Submit via: POST /provide-token with {...}"
  }
}
```

### 4. Get a Token

Click the `provisioning_url` from the response, generate a token, then submit it:

```bash
curl -X POST http://localhost:3000/provide-token \
  -H "Content-Type: application/json" \
  -d '{
    "api": "github",
    "token": "ghp_YOUR_TOKEN_HERE"
  }'
```

### 5. Retry the Request

```bash
curl -X POST http://localhost:3000/execute \
  -H "Content-Type: application/json" \
  -d '{
    "api": "github",
    "operationId": "createIssue",
    "intent": {
      "repo_name": "test-repo",
      "title": "Bug: Login not working"
    }
  }'
```

**Now it works!** The proxy:
1. ✅ Uses stored token
2. ✅ Executes grounding chain:
   - Gets authenticated user → `octocat`
   - Searches for `test-repo user:octocat` → Finds `octocat/test-repo`
3. ✅ Creates the issue with resolved `owner` and `repo`

## 📚 Complete Examples

### Example 1: Create GitHub Issue

**Intent:** "Create an issue in my test-repo about a login bug"

```bash
curl -X POST http://localhost:3000/execute \
  -H "Content-Type: application/json" \
  -d '{
    "api": "github",
    "operationId": "createIssue",
    "intent": {
      "repo_name": "test-repo"
    },
    "body": {
      "title": "Bug: Login not working",
      "body": "When I click login, nothing happens",
      "labels": ["bug"]
    }
  }'
```

**Grounding Chain:**
1. `GET /user` → Extract `login: "octocat"`
2. `GET /search/repositories?q=test-repo+user:octocat` → Extract `owner` and `repo`
3. `POST /repos/{owner}/{repo}/issues` → Create issue

**Result:**
```json
{
  "success": true,
  "grounding_executed": true,
  "resolved_params": {
    "owner": "octocat",
    "repo": "test-repo"
  },
  "result": {
    "id": 123456,
    "number": 42,
    "title": "Bug: Login not working",
    "html_url": "https://github.com/octocat/test-repo/issues/42"
  }
}
```

### Example 2: Add Confluence Comment

**Intent:** "Add a comment to the Onboarding page in the Engineering space"

**First, provide Confluence token:**
```bash
curl -X POST http://localhost:3000/provide-token \
  -H "Content-Type: application/json" \
  -d '{
    "api": "confluence",
    "email": "you@example.com",
    "token": "YOUR_API_TOKEN",
    "domain": "yourcompany"
  }'
```

**Then execute:**
```bash
curl -X POST http://localhost:3000/execute \
  -H "Content-Type: application/json" \
  -d '{
    "api": "confluence",
    "operationId": "addPageComment",
    "intent": {
      "space_name": "Engineering",
      "page_name": "Onboarding"
    },
    "body": {
      "comment_text": "Great documentation!"
    }
  }'
```

**Grounding Chain:**
1. `GET /wiki/rest/api/space?limit=100` → Filter by `name contains 'Engineering'` → Extract `key: "ENG"`
2. `GET /wiki/rest/api/content/search?cql=space=ENG AND type=page AND title~'Onboarding'` → Extract `id: "12345"`
3. `POST /wiki/rest/api/content/12345/child/comment` → Add comment

## 🔑 API Endpoints

### POST /execute
Execute an operation with automatic grounding.

**Request:**
```json
{
  "api": "github|confluence",
  "operationId": "createIssue|addPageComment|...",
  "intent": {
    "repo_name": "my-repo",
    "page_name": "Documentation",
    ...
  },
  "body": { ... }
}
```

**Response (Success):**
```json
{
  "success": true,
  "grounding_executed": true,
  "resolved_params": { ... },
  "result": { ... }
}
```

**Response (No Token):**
```json
{
  "error": "Authentication required",
  "code": "auth_required_challenge",
  "provisioning_url": "https://...",
  "next_steps": { ... }
}
```

### POST /provide-token
Store an API token.

**GitHub:**
```json
{
  "api": "github",
  "token": "ghp_..."
}
```

**Confluence:**
```json
{
  "api": "confluence",
  "email": "you@example.com",
  "token": "YOUR_API_TOKEN",
  "domain": "yourcompany" (optional)
}
```

### GET /auth-info/:api
Get auth discovery metadata for an API.

**Response:**
```json
{
  "api": "github",
  "has_token": false,
  "auth_discovery": {
    "type": "token",
    "scheme": "bearer",
    "documentation_url": "https://..."
  },
  "provisioning_url": "https://github.com/settings/tokens/new?..."
}
```

### GET /status
Check which APIs have stored tokens.

### DELETE /token/:api
Delete a stored token.

## 📊 OAS++ Extensions

### `x-postcall-provisioning-url`
URL where users can obtain API credentials.

```yaml
info:
  x-postcall-provisioning-url: https://github.com/settings/tokens/new?description=PostCall&scopes=repo
```

### `x-postcall-auth-discovery`
Machine-readable authentication metadata.

```yaml
info:
  x-postcall-auth-discovery:
    type: token
    scheme: bearer
    documentation_url: https://...
    scopes:
      repo: Full repository access
```

### `x-postcall-grounding`
Resolver chain for mapping names to IDs.

```yaml
/repos/{owner}/{repo}/issues:
  post:
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

### `x-agent-guidance`
Natural language examples for RAG indexing.

```yaml
post:
  x-agent-guidance:
    - "create an issue in {repo_name}"
    - "file a bug in my {repo_name} repo"
    - "open an issue about {topic}"
```

### `x-context-scope`
Data scope hint for agents.

```yaml
post:
  x-context-scope: user  # or: organization, session
```

## 🧪 Testing

Create test resources:

**GitHub:**
1. Create a repository named "test-repo"
2. Note your GitHub username

**Confluence:**
1. Create a space named "Engineering"
2. Create a page named "Onboarding" in that space
3. Note your Confluence domain

Then run the examples above!

## 🎓 Key Concepts

### The "ID Problem"
APIs require technical IDs, but users think in names:
- User: "my test-repo"
- API: `owner=octocat&repo=test-repo`

**PostCall solution:** Grounding chains automatically resolve names to IDs.

### Grounding Execution
1. Parse user intent
2. Execute resolver operations in sequence
3. Extract IDs from each response
4. Pass to next step via template variables
5. Inject into primary operation

### Auth Discovery
Instead of hard-coding auth flows, specs declare:
- Where to get credentials (`x-postcall-provisioning-url`)
- How to use them (`x-postcall-auth-discovery`)
- Proxy handles the flow automatically

## 📖 Sources

- **GitHub API Spec:** [github/rest-api-description](https://github.com/github/rest-api-description)
- **Confluence API Spec:** [Atlassian Confluence REST API v2](https://developer.atlassian.com/cloud/confluence/rest/v2/)

## 🚧 Current Status

✅ **Implemented:**
- OAS++ specs with grounding chains
- Token storage and provisioning flow
- Grounding chain executor
- GitHub and Confluence API support
- Complete end-to-end flow

📋 **Next Steps:**
- RAG integration (intent → operation selection)
- GraphQL support (Schema++)
- MCP support (MCP++)
- Multi-modal verification
- Production hardening

## 🤝 Contributing

This is a POC to demonstrate PostCall concepts. See `POC-GUIDE.md` for architecture details.

## 📝 License

MIT
