# PostCall MVP POC - Quick Start Guide

## Current Status

✅ **Phase 1 Complete**: OAuth infrastructure implemented
- Environment configuration system
- OAuth 2.0 flow for GitHub and Confluence
- HTTP client with error handling and retry logic
- Session management for tokens
- Universal proxy server with OAuth endpoints

## What You Need to Do Now

### Step 1: Install Dependencies

```bash
npm install
```

This will install:
- `axios` - HTTP client
- `express` - Web server
- `express-session` - Session management
- `dotenv` - Environment variables
- `cookie-parser` - Cookie handling

### Step 2: Set Up OAuth Applications

Follow the instructions in `OAUTH_SETUP.md`:

1. **GitHub OAuth App**: https://github.com/settings/developers
   - Create new OAuth app
   - Set callback URL: `http://localhost:3000/callback/github`
   - Copy Client ID and Secret

2. **Confluence OAuth App**: https://developer.atlassian.com/console/myapps/
   - Create OAuth 2.0 integration
   - Set callback URL: `http://localhost:3000/callback/confluence`
   - Add scopes: `read:confluence-space.summary`, `read:confluence-content.all`, `write:confluence-content`
   - Copy Client ID and Secret

### Step 3: Create .env File

```bash
cp .env.example .env
```

Then fill in your OAuth credentials in `.env`:

```env
# GitHub OAuth
GITHUB_CLIENT_ID=your_github_client_id_here
GITHUB_CLIENT_SECRET=your_github_client_secret_here
GITHUB_REDIRECT_URI=http://localhost:3000/callback/github

# Confluence OAuth
CONFLUENCE_CLIENT_ID=your_confluence_client_id_here
CONFLUENCE_CLIENT_SECRET=your_confluence_client_secret_here
CONFLUENCE_REDIRECT_URI=http://localhost:3000/callback/confluence

# Proxy Configuration
PROXY_PORT=3000
DEBUG=true

# Session secret
SESSION_SECRET=generate_random_string_here
```

Generate a session secret:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Step 4: Test the OAuth Flow

Start the proxy server:

```bash
npm run proxy:real
```

You should see:
```
🚀 PostCall Universal Proxy running on http://localhost:3000

Quick Start:
  1. Visit http://localhost:3000 in your browser
  2. Click "Authenticate with GitHub" or "Authenticate with Confluence"
  3. Make API calls via POST /execute
```

### Step 5: Authenticate

1. Open http://localhost:3000 in your browser
2. Click "Authenticate with GitHub"
   - You'll be redirected to GitHub
   - Authorize the app
   - You'll be redirected back with success message
3. Click "Authenticate with Confluence"
   - You'll be redirected to Atlassian
   - Select your Confluence site
   - Authorize the app
   - You'll be redirected back with success message

### Step 6: Verify Authentication

Visit http://localhost:3000/status to see your auth status:

```json
{
  "github": {
    "authenticated": true,
    "cloudId": null
  },
  "confluence": {
    "authenticated": true,
    "cloudId": "abc-123-def-456"
  }
}
```

## What's Next

Now that OAuth is working, the next steps are:

1. **Create test resources**:
   - GitHub: Create a test repository
   - Confluence: Create a test space with pages

2. **Analyze grounding chains**:
   - Document user intents
   - Map them to API call sequences

3. **Create OAS++ specs**:
   - GitHub operations with grounding metadata
   - Confluence operations with grounding metadata

4. **Implement grounding execution**:
   - Chain resolver calls
   - Extract IDs and inject into primary operation

5. **Build end-to-end demos**:
   - "Create issue in my repo" → GitHub API
   - "Add comment to page in Marketing space" → Confluence API

## Project Structure

```
v2-postcall-poc/
├── config/
│   └── index.js          # Configuration and env loading
├── lib/
│   ├── oauth.js          # OAuth flow implementation
│   └── api-client.js     # HTTP client with auth
├── proxy/
│   └── universal-proxy-real.js  # Main OAuth-enabled proxy
├── specs/                # Will contain OAS++ specs
├── .env.example         # Environment variables template
├── OAUTH_SETUP.md       # OAuth app registration guide
└── QUICKSTART.md        # This file
```

## Troubleshooting

### "Cannot find module 'dotenv'"
Run `npm install` to install dependencies.

### "GITHUB_CLIENT_ID is not set"
Make sure you've created `.env` file and filled in your OAuth credentials.

### OAuth redirect mismatch
Verify your OAuth app callback URL exactly matches:
- GitHub: `http://localhost:3000/callback/github`
- Confluence: `http://localhost:3000/callback/confluence`

### Confluence: "No resources available"
Make sure your Atlassian account has access to at least one Confluence site.

## Current Implementation Status

✅ Completed:
- [x] OAuth 2.0 authorization flow (GitHub & Confluence)
- [x] Token exchange and storage
- [x] Session management
- [x] Automatic token refresh (Confluence)
- [x] Error handling (401, 403, 404, 422)
- [x] Rate limit detection
- [x] Retry logic with exponential backoff
- [x] Configuration system

🚧 In Progress:
- [ ] OAS++ spec creation
- [ ] Grounding chain execution
- [ ] Test scenarios

📋 Pending:
- [ ] RAG implementation with embeddings
- [ ] GraphQL support
- [ ] Full end-to-end demos

## Need Help?

1. Check `OAUTH_SETUP.md` for detailed OAuth setup instructions
2. Check logs in terminal for detailed error messages
3. Set `DEBUG=true` in `.env` for verbose logging
4. Verify your `.env` file has no syntax errors (no quotes, no spaces around `=`)

## Demo Video Ideas

Once OAS++ specs and grounding are implemented, you can demo:

1. **Traditional approach** (manual):
   - User finds repo ID manually
   - Constructs API request with curl
   - Multiple steps, error-prone

2. **PostCall approach** (automated):
   - User says: "Create issue in my test-repo"
   - Proxy reads grounding chain
   - Automatically resolves repo → ID
   - Creates issue
   - Single step, natural language

This demonstrates the value proposition of PostCall!
