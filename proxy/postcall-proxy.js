/**
 * PostCall Universal Proxy - Complete Implementation
 * Demonstrates the full PostCall flow:
 * 1. User makes request without credentials
 * 2. Proxy returns provisioning URL from OAS++ spec
 * 3. User gets token and submits it
 * 4. Proxy stores token locally
 * 5. Proxy executes grounding chain
 * 6. Proxy makes the API call
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const yaml = require('yaml');

const { getToken, storeToken, deleteToken, hasToken, listTokens } = require('../lib/token-storage');
const { createGitHubClient, createConfluenceClient, fetchConfluenceCloudId } = require('../lib/api-client-simple');
const { executeGroundingChain, findOperation } = require('../lib/grounding-executor');

const app = express();
app.use(express.json());

// Load OAS++ specs
const specs = {};

function loadSpecs() {
  console.log('\n[Proxy] Loading OAS++ specifications...');

  const specsDir = path.join(__dirname, '../specs');
  const specFiles = {
    github: 'github-oas-plus.yaml',
    confluence: 'confluence-oas-plus.yaml',
  };

  for (const [api, filename] of Object.entries(specFiles)) {
    const filepath = path.join(specsDir, filename);
    try {
      const content = fs.readFileSync(filepath, 'utf8');
      specs[api] = yaml.parse(content);
      console.log(`  ✓ Loaded ${api} spec from ${filename}`);
    } catch (error) {
      console.error(`  ✗ Failed to load ${api} spec: ${error.message}`);
    }
  }

  console.log('[Proxy] Spec loading complete\n');
}

/**
 * Home page
 */
app.get('/', (req, res) => {
  const tokens = listTokens();
  const tokenStatus = tokens.map(t => `<li>${t.api}: ✓ Stored (${new Date(t.stored_at).toLocaleString()})</li>`).join('');

  res.send(`
    <html>
      <head>
        <title>PostCall Universal Proxy</title>
        <style>
          body { font-family: Arial, sans-serif; max-width: 900px; margin: 50px auto; padding: 20px; }
          h1 { color: #333; }
          .section { margin: 30px 0; padding: 20px; background: #f5f5f5; border-radius: 5px; }
          code { background: #e9ecef; padding: 2px 6px; border-radius: 3px; }
          pre { background: #e9ecef; padding: 15px; border-radius: 5px; overflow-x: auto; }
          .success { color: green; }
          .warning { color: orange; }
        </style>
      </head>
      <body>
        <h1>🚀 PostCall Universal API Proxy</h1>
        <p>Token-based authentication with grounding support for GitHub and Confluence.</p>

        <div class="section">
          <h2>Stored Tokens</h2>
          ${tokens.length > 0 ? `<ul>${tokenStatus}</ul>` : '<p class="warning">No tokens stored yet</p>'}
        </div>

        <div class="section">
          <h2>API Endpoints</h2>
          <ul>
            <li><code>POST /execute</code> - Execute an operation with grounding</li>
            <li><code>POST /provide-token</code> - Store API token</li>
            <li><code>GET /auth-info/:api</code> - Get auth discovery metadata</li>
            <li><code>DELETE /token/:api</code> - Delete stored token</li>
            <li><code>GET /status</code> - Check token status (JSON)</li>
          </ul>
        </div>

        <div class="section">
          <h2>Example: Create GitHub Issue</h2>
          <pre>POST /execute
{
  "api": "github",
  "operationId": "createIssue",
  "intent": {
    "repo_name": "test-repo",
    "title": "Bug: Login not working"
  }
}</pre>
          <p>If no token is stored, you'll get a provisioning URL to obtain one.</p>
        </div>

        <div class="section">
          <h2>Example: Add Confluence Comment</h2>
          <pre>POST /execute
{
  "api": "confluence",
  "operationId": "addPageComment",
  "intent": {
    "space_name": "Engineering",
    "page_name": "Onboarding",
    "comment_text": "Great guide!"
  },
  "body": {
    "comment_text": "Great guide!"
  }
}</pre>
        </div>
      </body>
    </html>
  `);
});

/**
 * Get token status
 */
app.get('/status', (req, res) => {
  const tokens = listTokens();
  res.json({
    tokens: tokens.map(t => ({
      api: t.api,
      hasToken: true,
      storedAt: t.stored_at,
    })),
    github: hasToken('github'),
    confluence: hasToken('confluence'),
  });
});

/**
 * Get auth discovery info for an API
 */
app.get('/auth-info/:api', (req, res) => {
  const { api } = req.params;

  if (!specs[api]) {
    return res.status(404).json({ error: `No spec found for API: ${api}` });
  }

  const authDiscovery = specs[api].info?.['x-postcall-auth-discovery'] || {};
  const provisioningUrl = specs[api].info?.['x-postcall-provisioning-url'] || null;

  res.json({
    api,
    has_token: hasToken(api),
    auth_discovery: authDiscovery,
    provisioning_url: provisioningUrl,
  });
});

/**
 * Store a token for an API
 */
app.post('/provide-token', (req, res) => {
  const { api, token, email, domain, cloudId } = req.body;

  if (!api) {
    return res.status(400).json({ error: 'Missing required field: api' });
  }

  if (!specs[api]) {
    return res.status(404).json({ error: `Unknown API: ${api}` });
  }

  // Store token based on API type
  if (api === 'github') {
    if (!token) {
      return res.status(400).json({ error: 'Missing required field: token' });
    }

    storeToken('github', {
      type: 'github_pat',
      token,
    });

    return res.json({
      success: true,
      message: 'GitHub token stored successfully',
      api: 'github',
    });
  }

  if (api === 'confluence') {
    if (!email || !token) {
      return res.status(400).json({ error: 'Missing required fields: email, token' });
    }

    storeToken('confluence', {
      type: 'confluence_api_token',
      email,
      apiToken: token,
      domain: domain || null,
      cloudId: cloudId || null,
    });

    return res.json({
      success: true,
      message: 'Confluence token stored successfully',
      api: 'confluence',
    });
  }

  res.status(400).json({ error: `Unsupported API: ${api}` });
});

/**
 * Delete a stored token
 */
app.delete('/token/:api', (req, res) => {
  const { api } = req.params;

  if (deleteToken(api)) {
    res.json({ success: true, message: `Token deleted for ${api}` });
  } else {
    res.status(404).json({ error: `No token found for ${api}` });
  }
});

/**
 * Execute an operation with grounding
 */
app.post('/execute', async (req, res) => {
  const { api, operationId, intent, body: requestBody } = req.body;

  console.log(`\n[Execute] Request: ${api} / ${operationId}`);
  console.log(`[Execute] Intent:`, intent);

  if (!api || !operationId) {
    return res.status(400).json({ error: 'Missing required fields: api, operationId' });
  }

  if (!specs[api]) {
    return res.status(404).json({ error: `No spec found for API: ${api}` });
  }

  // Check for stored token
  const tokenData = getToken(api);

  if (!tokenData) {
    // Return auth_required_challenge with provisioning URL
    const authDiscovery = specs[api].info?.['x-postcall-auth-discovery'] || {};
    const provisioningUrl = specs[api].info?.['x-postcall-provisioning-url'];

    console.log(`[Execute] No token found for ${api}`);

    return res.status(401).json({
      error: 'Authentication required',
      code: 'auth_required_challenge',
      message: `No credentials stored for ${api}. Please obtain a token and submit it via POST /provide-token`,
      auth_discovery: authDiscovery,
      provisioning_url: provisioningUrl,
      next_steps: {
        step1: `Visit: ${provisioningUrl}`,
        step2: 'Generate an API token',
        step3: `Submit via: POST /provide-token with { "api": "${api}", "token": "YOUR_TOKEN", ... }`,
      },
    });
  }

  console.log(`[Execute] Using stored ${api} token`);

  try {
    // Create API client
    let client;
    if (api === 'github') {
      client = createGitHubClient();
    } else if (api === 'confluence') {
      // Get cloudId if not stored
      let cloudId = tokenData.cloudId;
      if (!cloudId) {
        console.log('[Execute] Fetching Confluence Cloud ID...');
        cloudId = await fetchConfluenceCloudId();
        // Update stored token with cloudId
        storeToken('confluence', { ...tokenData, cloudId });
      }
      client = createConfluenceClient(cloudId);
    }

    // Execute grounding chain if needed
    let resolvedParams = {};
    const targetOp = findOperation(specs[api], operationId);
    if (!targetOp) {
      return res.status(404).json({ error: `Operation not found: ${operationId}` });
    }

    if (targetOp.operation['x-postcall-grounding']) {
      console.log('[Execute] Executing grounding chain...');
      resolvedParams = await executeGroundingChain(api, operationId, intent, specs[api], client);
    }

    // Build the primary request
    const primaryRequest = buildPrimaryRequest(targetOp, intent, resolvedParams, requestBody);

    console.log(`[Execute] Executing primary operation: ${targetOp.method} ${primaryRequest.url}`);

    // Execute the primary request
    const response = await client.request(primaryRequest);

    console.log(`[Execute] Success!`);

    res.json({
      success: true,
      api,
      operationId,
      grounding_executed: !!targetOp.operation['x-postcall-grounding'],
      resolved_params: resolvedParams,
      result: response.data,
    });
  } catch (error) {
    console.error(`[Execute] Error:`, error.message);

    res.status(error.status || 500).json({
      success: false,
      error: error.message,
      code: error.code,
      details: error.originalError || null,
    });
  }
});

/**
 * Build the primary API request
 */
function buildPrimaryRequest(operation, intent, resolvedParams, requestBody) {
  const { path, method } = operation;

  // Resolve path parameters
  let url = path.replace(/\{([^}]+)\}/g, (match, param) => {
    return resolvedParams[param] || intent[param] || match;
  });

  const config = {
    method: method.toLowerCase(),
    url,
  };

  // Add request body if needed
  if (['post', 'put', 'patch'].includes(config.method) && requestBody) {
    config.data = resolveBodyTemplate(requestBody, { intent, ...resolvedParams });
  }

  return config;
}

/**
 * Resolve body template with parameters
 */
function resolveBodyTemplate(body, params) {
  // Simple implementation - can be enhanced
  if (typeof body === 'string') {
    return body.replace(/\{\{([^}]+)\}\}/g, (match, key) => params[key] || match);
  }

  const resolved = JSON.parse(JSON.stringify(body));

  // For Confluence, build the storage format
  if (resolved.comment_text) {
    resolved.body = {
      storage: {
        value: `<p>${resolved.comment_text}</p>`,
        representation: 'storage',
      },
    };
  }

  return resolved;
}

/**
 * Start the server
 */
function start() {
  loadSpecs();

  const port = process.env.PROXY_PORT || 3000;

  app.listen(port, () => {
    console.log(`\n🚀 PostCall Universal Proxy running on http://localhost:${port}`);
    console.log(`\nQuick Start:`);
    console.log(`  1. Visit http://localhost:${port} in your browser`);
    console.log(`  2. Try making an API call (you'll get a provisioning URL)`);
    console.log(`  3. Get a token from the provisioning URL`);
    console.log(`  4. Submit it via POST /provide-token`);
    console.log(`  5. Retry your API call - grounding will happen automatically!\n`);
  });
}

if (require.main === module) {
  start();
}

module.exports = { app, start };
