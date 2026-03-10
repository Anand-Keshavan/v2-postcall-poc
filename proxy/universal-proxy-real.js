/**
 * PostCall Universal Proxy with OAuth 2.0 Support
 * Handles authentication, grounding, and execution for GitHub and Confluence APIs
 */

const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const yaml = require('yaml');

const { config, logConfigStatus } = require('../config');
const {
  getAuthorizationUrl,
  exchangeCodeForToken,
  getConfluenceResources,
} = require('../lib/oauth');
const { makeAuthenticatedRequest, retryWithBackoff } = require('../lib/api-client');

const app = express();

// Middleware
app.use(express.json());
app.use(cookieParser());
app.use(
  session({
    secret: config.proxy.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false, // Set to true if using HTTPS
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    },
  })
);

// In-memory spec storage (loaded from files)
const specs = {};

/**
 * Load OAS++ specs from the specs directory
 */
function loadSpecs() {
  console.log('\n[Proxy] Loading OAS++ specifications...');

  const specsDir = path.join(__dirname, '../specs');
  const specFiles = {
    github: 'github-oas-plus.yaml',
    confluence: 'confluence-oas-plus.yaml',
  };

  for (const [api, filename] of Object.entries(specFiles)) {
    const filepath = path.join(specsDir, filename);
    if (fs.existsSync(filepath)) {
      try {
        const content = fs.readFileSync(filepath, 'utf8');
        specs[api] = yaml.parse(content);
        console.log(`  ✓ Loaded ${api} spec from ${filename}`);
      } catch (error) {
        console.error(`  ✗ Failed to load ${api} spec: ${error.message}`);
      }
    } else {
      console.warn(`  ○ ${filename} not found (will be created later)`);
    }
  }

  console.log('[Proxy] Spec loading complete\n');
}

/**
 * Home page with links to auth flows
 */
app.get('/', (req, res) => {
  const githubAuth = req.session.tokens?.github ? '✓ Authenticated' : '✗ Not authenticated';
  const confluenceAuth = req.session.tokens?.confluence ? '✓ Authenticated' : '✗ Not authenticated';

  res.send(`
    <html>
      <head>
        <title>PostCall Universal Proxy</title>
        <style>
          body { font-family: Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; }
          h1 { color: #333; }
          .status { margin: 20px 0; padding: 15px; background: #f5f5f5; border-radius: 5px; }
          .auth-link { display: inline-block; margin: 10px 10px 10px 0; padding: 10px 20px; background: #007bff; color: white; text-decoration: none; border-radius: 5px; }
          .auth-link:hover { background: #0056b3; }
          .authenticated { color: green; }
          .not-authenticated { color: orange; }
          code { background: #e9ecef; padding: 2px 6px; border-radius: 3px; }
        </style>
      </head>
      <body>
        <h1>PostCall Universal API Proxy</h1>
        <p>OAuth 2.0 enabled universal proxy for GitHub and Confluence APIs with grounding support.</p>

        <div class="status">
          <h2>Authentication Status</h2>
          <p><strong>GitHub:</strong> <span class="${req.session.tokens?.github ? 'authenticated' : 'not-authenticated'}">${githubAuth}</span></p>
          <p><strong>Confluence:</strong> <span class="${req.session.tokens?.confluence ? 'authenticated' : 'not-authenticated'}">${confluenceAuth}</span></p>
        </div>

        <h2>Authentication</h2>
        <a href="/auth/github" class="auth-link">Authenticate with GitHub</a>
        <a href="/auth/confluence" class="auth-link">Authenticate with Confluence</a>

        <h2>API Endpoints</h2>
        <ul>
          <li><code>POST /execute</code> - Execute an operation with grounding</li>
          <li><code>GET /auth-info/:api</code> - Get auth discovery metadata</li>
          <li><code>GET /auth/github</code> - Start GitHub OAuth flow</li>
          <li><code>GET /auth/confluence</code> - Start Confluence OAuth flow</li>
          <li><code>GET /status</code> - Check authentication status (JSON)</li>
        </ul>

        <h2>Example Request</h2>
        <pre>{
  "api": "github",
  "operationId": "createIssue",
  "intent": {
    "repo_name": "test-repo",
    "title": "Bug: Login page not working",
    "body": "Steps to reproduce..."
  }
}</pre>
      </body>
    </html>
  `);
});

/**
 * Check authentication status (JSON endpoint)
 */
app.get('/status', (req, res) => {
  res.json({
    github: {
      authenticated: !!req.session.tokens?.github,
      cloudId: null,
    },
    confluence: {
      authenticated: !!req.session.tokens?.confluence,
      cloudId: req.session.confluenceCloudId || null,
    },
  });
});

/**
 * Get auth discovery metadata for an API
 */
app.get('/auth-info/:api', (req, res) => {
  const { api } = req.params;

  if (!specs[api]) {
    return res.status(404).json({ error: `No spec found for API: ${api}` });
  }

  // Extract auth discovery from spec
  const authDiscovery = specs[api].info?.['x-postcall-auth-discovery'] || {};
  const provisioningUrl = specs[api].info?.['x-postcall-provisioning-url'] || null;

  res.json({
    api,
    auth_discovery: authDiscovery,
    provisioning_url: provisioningUrl,
    oauth_flow_url: `/auth/${api}`,
  });
});

/**
 * Start OAuth flow for GitHub
 */
app.get('/auth/github', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;

  const authUrl = getAuthorizationUrl('github', state);
  res.redirect(authUrl);
});

/**
 * Start OAuth flow for Confluence
 */
app.get('/auth/confluence', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;

  const authUrl = getAuthorizationUrl('confluence', state);
  res.redirect(authUrl);
});

/**
 * OAuth callback for GitHub
 */
app.get('/callback/github', async (req, res) => {
  const { code, state } = req.query;

  // Verify state for CSRF protection
  if (state !== req.session.oauthState) {
    return res.status(400).send('Invalid state parameter - possible CSRF attack');
  }

  try {
    console.log('[GitHub] Exchanging code for token...');
    const tokenData = await exchangeCodeForToken('github', code);

    // Store token in session
    if (!req.session.tokens) req.session.tokens = {};
    req.session.tokens.github = tokenData;

    console.log('[GitHub] OAuth flow completed successfully');

    res.send(`
      <html>
        <head><title>GitHub Authentication Success</title></head>
        <body style="font-family: Arial; max-width: 600px; margin: 50px auto; text-align: center;">
          <h1 style="color: green;">✓ GitHub Authentication Successful</h1>
          <p>You can now close this window and make API calls.</p>
          <a href="/" style="display: inline-block; margin-top: 20px; padding: 10px 20px; background: #007bff; color: white; text-decoration: none; border-radius: 5px;">Back to Home</a>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('[GitHub] OAuth error:', error.message);
    res.status(500).send(`
      <html>
        <head><title>GitHub Authentication Failed</title></head>
        <body style="font-family: Arial; max-width: 600px; margin: 50px auto; text-align: center;">
          <h1 style="color: red;">✗ GitHub Authentication Failed</h1>
          <p>${error.message}</p>
          <a href="/auth/github" style="display: inline-block; margin-top: 20px; padding: 10px 20px; background: #007bff; color: white; text-decoration: none; border-radius: 5px;">Try Again</a>
        </body>
      </html>
    `);
  }
});

/**
 * OAuth callback for Confluence
 */
app.get('/callback/confluence', async (req, res) => {
  const { code, state } = req.query;

  // Verify state for CSRF protection
  if (state !== req.session.oauthState) {
    return res.status(400).send('Invalid state parameter - possible CSRF attack');
  }

  try {
    console.log('[Confluence] Exchanging code for token...');
    const tokenData = await exchangeCodeForToken('confluence', code);

    // Get accessible Confluence sites
    console.log('[Confluence] Fetching accessible resources...');
    const resources = await getConfluenceResources(tokenData.access_token);

    if (resources.length === 0) {
      throw new Error('No Confluence sites accessible with this account');
    }

    // Store token and cloud ID in session
    if (!req.session.tokens) req.session.tokens = {};
    req.session.tokens.confluence = tokenData;
    req.session.confluenceCloudId = resources[0].id; // Use first available site
    req.session.confluenceResources = resources;

    console.log(`[Confluence] OAuth flow completed successfully (Cloud ID: ${resources[0].id})`);

    const resourcesList = resources.map(r => `<li>${r.name} (${r.id})</li>`).join('');

    res.send(`
      <html>
        <head><title>Confluence Authentication Success</title></head>
        <body style="font-family: Arial; max-width: 600px; margin: 50px auto; text-align: center;">
          <h1 style="color: green;">✓ Confluence Authentication Successful</h1>
          <p>Connected to: ${resources[0].name}</p>
          <details style="margin: 20px 0;">
            <summary>All accessible sites (${resources.length})</summary>
            <ul style="text-align: left; margin: 10px auto; max-width: 400px;">${resourcesList}</ul>
          </details>
          <p>You can now close this window and make API calls.</p>
          <a href="/" style="display: inline-block; margin-top: 20px; padding: 10px 20px; background: #007bff; color: white; text-decoration: none; border-radius: 5px;">Back to Home</a>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('[Confluence] OAuth error:', error.message);
    res.status(500).send(`
      <html>
        <head><title>Confluence Authentication Failed</title></head>
        <body style="font-family: Arial; max-width: 600px; margin: 50px auto; text-align: center;">
          <h1 style="color: red;">✗ Confluence Authentication Failed</h1>
          <p>${error.message}</p>
          <a href="/auth/confluence" style="display: inline-block; margin-top: 20px; padding: 10px 20px; background: #007bff; color: white; text-decoration: none; border-radius: 5px;">Try Again</a>
        </body>
      </html>
    `);
  }
});

/**
 * Execute an operation with grounding
 */
app.post('/execute', async (req, res) => {
  const { api, operationId, intent, body: requestBody } = req.body;

  if (!api || !operationId) {
    return res.status(400).json({ error: 'Missing required fields: api, operationId' });
  }

  // Check if authenticated
  const tokenData = req.session.tokens?.[api];
  if (!tokenData) {
    return res.status(401).json({
      error: 'Authentication required',
      code: 'auth_required_challenge',
      auth_discovery: {
        oauth_flow_url: `/auth/${api}`,
        auth_info_url: `/auth-info/${api}`,
      },
    });
  }

  // TODO: Implement grounding chain execution
  // For now, just return a placeholder
  res.json({
    message: 'Execution endpoint ready - grounding implementation coming next',
    api,
    operationId,
    intent,
    authenticated: true,
  });
});

/**
 * Start the server
 */
function start() {
  logConfigStatus();
  loadSpecs();

  app.listen(config.proxy.port, () => {
    console.log(`🚀 PostCall Universal Proxy running on http://localhost:${config.proxy.port}`);
    console.log(`\nQuick Start:`);
    console.log(`  1. Visit http://localhost:${config.proxy.port} in your browser`);
    console.log(`  2. Click "Authenticate with GitHub" or "Authenticate with Confluence"`);
    console.log(`  3. Make API calls via POST /execute\n`);
  });
}

// Start if run directly
if (require.main === module) {
  start();
}

module.exports = { app, start };
