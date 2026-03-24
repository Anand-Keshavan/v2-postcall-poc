/**
 * Nile Ecommerce API - Mock Server for Grounding Testing
 * Runs on localhost:8000
 *
 * Includes a self-contained OAuth 2.0 Authorization Code server:
 *   GET  /oauth/authorize  — approval page
 *   POST /oauth/authorize  — issue auth code, redirect to callback
 *   POST /oauth/token      — exchange code for tokens / refresh tokens
 *
 * Pre-registered client:
 *   client_id:     postcall-agent
 *   client_secret: postcall-secret
 *   redirect_uri:  http://localhost:9999/callback
 */

const express = require('express');
const crypto  = require('crypto');
const app     = express();
const PORT    = 8000;

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── OAuth in-memory stores ────────────────────────────────────────────────────

const REGISTERED_CLIENTS = {
  'postcall-agent': {
    secret: 'postcall-secret',
    redirectUris: ['http://localhost:9999/callback'],
  },
};

const ACCESS_TOKEN_TTL  = 3600;        // 1 hour in seconds
const REFRESH_TOKEN_TTL = 30 * 86400;  // 30 days in seconds

const authCodes    = new Map(); // code → { clientId, scope, expiresAt }
const accessTokens = new Map(); // token → { clientId, scope, expiresAt }
const refreshTokens = new Map(); // token → { clientId, scope, expiresAt }

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ── OAuth endpoints ───────────────────────────────────────────────────────────

// GET /oauth/authorize — render approval page
app.get('/oauth/authorize', (req, res) => {
  const { client_id, redirect_uri, response_type, state, scope } = req.query;

  if (!REGISTERED_CLIENTS[client_id]) {
    return res.status(400).json({ error: 'invalid_client' });
  }
  if (response_type !== 'code') {
    return res.status(400).json({ error: 'unsupported_response_type' });
  }

  res.send(`<!DOCTYPE html>
<html>
<head><title>Nile OAuth</title>
<style>
  body { font-family: sans-serif; max-width: 480px; margin: 80px auto; padding: 24px; border: 1px solid #ddd; border-radius: 8px; }
  h2   { color: #333; }
  p    { color: #555; }
  button { background: #0070f3; color: white; border: none; padding: 10px 24px; border-radius: 4px; cursor: pointer; font-size: 16px; }
  button:hover { background: #005cc5; }
  .scope { background: #f0f4ff; padding: 8px 12px; border-radius: 4px; font-family: monospace; }
</style>
</head>
<body>
  <h2>Nile Ecommerce API</h2>
  <p><strong>PostCall Agent</strong> is requesting access to your Nile account.</p>
  <p>Scope: <span class="scope">${scope || 'read'}</span></p>
  <form method="POST" action="/oauth/authorize">
    <input type="hidden" name="client_id"    value="${client_id}" />
    <input type="hidden" name="redirect_uri" value="${redirect_uri || ''}" />
    <input type="hidden" name="state"        value="${state || ''}" />
    <input type="hidden" name="scope"        value="${scope || 'read'}" />
    <button type="submit">Approve Access</button>
  </form>
</body>
</html>`);
});

// POST /oauth/authorize — issue auth code, redirect to callback
app.post('/oauth/authorize', (req, res) => {
  const { client_id, redirect_uri, state, scope } = req.body;

  const client = REGISTERED_CLIENTS[client_id];
  if (!client) return res.status(400).json({ error: 'invalid_client' });
  if (redirect_uri && !client.redirectUris.includes(redirect_uri)) {
    return res.status(400).json({ error: 'invalid_redirect_uri' });
  }

  const code = generateToken();
  authCodes.set(code, {
    clientId: client_id,
    redirectUri: redirect_uri,
    scope: scope || 'read',
    expiresAt: Date.now() + 60_000, // codes expire in 60 seconds
  });

  const callbackUrl = new URL(redirect_uri || client.redirectUris[0]);
  callbackUrl.searchParams.set('code', code);
  if (state) callbackUrl.searchParams.set('state', state);

  res.redirect(callbackUrl.toString());
});

// POST /oauth/token — exchange code or refresh token
app.post('/oauth/token', (req, res) => {
  const { grant_type, code, refresh_token, client_id, client_secret, redirect_uri } = req.body;

  // Validate client
  const client = REGISTERED_CLIENTS[client_id];
  if (!client || client.secret !== client_secret) {
    return res.status(401).json({ error: 'invalid_client' });
  }

  if (grant_type === 'authorization_code') {
    const codeData = authCodes.get(code);
    if (!codeData) return res.status(400).json({ error: 'invalid_grant', error_description: 'Code not found or already used' });
    if (codeData.expiresAt < Date.now()) {
      authCodes.delete(code);
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Code expired' });
    }
    if (codeData.clientId !== client_id) {
      return res.status(400).json({ error: 'invalid_grant' });
    }
    authCodes.delete(code); // single use

    const access  = generateToken();
    const refresh = generateToken();
    const now = Date.now();

    accessTokens.set(access,  { clientId: client_id, scope: codeData.scope, expiresAt: now + ACCESS_TOKEN_TTL * 1000 });
    refreshTokens.set(refresh, { clientId: client_id, scope: codeData.scope, expiresAt: now + REFRESH_TOKEN_TTL * 1000 });

    return res.json({
      access_token:  access,
      token_type:    'Bearer',
      expires_in:    ACCESS_TOKEN_TTL,
      refresh_token: refresh,
      scope:         codeData.scope,
    });
  }

  if (grant_type === 'refresh_token') {
    const rtData = refreshTokens.get(refresh_token);
    if (!rtData || rtData.clientId !== client_id) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Refresh token not found' });
    }
    if (rtData.expiresAt < Date.now()) {
      refreshTokens.delete(refresh_token);
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Refresh token expired' });
    }
    refreshTokens.delete(refresh_token); // rotate refresh token

    const access  = generateToken();
    const refresh = generateToken();
    const now = Date.now();

    accessTokens.set(access,  { clientId: client_id, scope: rtData.scope, expiresAt: now + ACCESS_TOKEN_TTL * 1000 });
    refreshTokens.set(refresh, { clientId: client_id, scope: rtData.scope, expiresAt: now + REFRESH_TOKEN_TTL * 1000 });

    return res.json({
      access_token:  access,
      token_type:    'Bearer',
      expires_in:    ACCESS_TOKEN_TTL,
      refresh_token: refresh,
      scope:         rtData.scope,
    });
  }

  return res.status(400).json({ error: 'unsupported_grant_type' });
});

// ── Bearer token middleware (protects all routes below) ───────────────────────

app.use((req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'unauthorized', error_description: 'Bearer token required' });
  }

  const token = authHeader.slice(7);
  const tokenData = accessTokens.get(token);

  if (!tokenData) {
    return res.status(401).json({ error: 'invalid_token', error_description: 'Token not found' });
  }
  if (tokenData.expiresAt < Date.now()) {
    accessTokens.delete(token);
    return res.status(401).json({ error: 'invalid_token', error_description: 'Token expired' });
  }

  next();
});

// ── Fuzzy matching ────────────────────────────────────────────────────────────
// Handles: case differences, partial names, model numbers, word-level matches
// e.g. "iPhone" → "iPhone 15", "macbook" → "MacBook Pro", "gatsby" → "The Great Gatsby"
function fuzzyMatch(text, query) {
  const normalize = s => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const textN = normalize(text);
  const queryN = normalize(query);

  // 1. Direct normalized substring match
  if (textN.includes(queryN) || queryN.includes(textN)) return true;

  // 2. Word-level: any significant word in the query appears in the text
  const queryWords = queryN.split(/\s+/).filter(w => w.length > 2);
  if (queryWords.some(w => textN.includes(w))) return true;

  // 3. Reverse: any significant word in the text appears in the query
  const textWords = textN.split(/\s+/).filter(w => w.length > 2);
  if (textWords.some(w => queryN.includes(w))) return true;

  return false;
}

// Mock Data
const users = [
  { id: 1, name: 'Alice Johnson', email: 'alice@example.com' },
  { id: 2, name: 'Bob Smith', email: 'bob@example.com' },
  { id: 3, name: 'Charlie Brown', email: 'charlie@example.com' },
];

const categories = [
  { id: 1, name: 'Electronics', description: 'Electronic devices and accessories' },
  { id: 2, name: 'Books', description: 'Books and publications' },
  { id: 3, name: 'Clothing', description: 'Apparel and fashion items' },
];

const products = [
  { id: 101, name: 'iPhone 15', category_id: 1, price: 999, stock: 50 },
  { id: 102, name: 'MacBook Pro', category_id: 1, price: 2499, stock: 30 },
  { id: 103, name: 'AirPods Pro', category_id: 1, price: 249, stock: 100 },
  { id: 201, name: 'The Great Gatsby', category_id: 2, price: 15, stock: 200 },
  { id: 202, name: '1984', category_id: 2, price: 18, stock: 150 },
  { id: 301, name: 'Blue Jeans', category_id: 3, price: 79, stock: 80 },
  { id: 302, name: 'T-Shirt', category_id: 3, price: 29, stock: 120 },
];

const orders = [
  { id: 1001, user_id: 1, product_id: 101, quantity: 1, status: 'delivered', total: 999 },
  { id: 1002, user_id: 1, product_id: 103, quantity: 2, status: 'shipped', total: 498 },
  { id: 1003, user_id: 2, product_id: 102, quantity: 1, status: 'processing', total: 2499 },
  { id: 1004, user_id: 3, product_id: 201, quantity: 3, status: 'delivered', total: 45 },
];

const reviews = [
  { id: 1, product_id: 101, user_id: 1, rating: 5, comment: 'Excellent phone!' },
  { id: 2, product_id: 101, user_id: 2, rating: 4, comment: 'Great but expensive' },
  { id: 3, product_id: 102, user_id: 1, rating: 5, comment: 'Best laptop ever' },
  { id: 4, product_id: 201, user_id: 3, rating: 5, comment: 'Classic literature' },
];

// ============= USER ENDPOINTS =============

// Search users by name
app.get('/users/search', (req, res) => {
  const { name } = req.query;
  if (!name) {
    return res.status(400).json({ error: 'name query parameter required' });
  }

  const results = users.filter(u => fuzzyMatch(u.name, name));

  res.json({ users: results, total: results.length });
});

// Get user by ID
app.get('/users/:user_id', (req, res) => {
  const user = users.find(u => u.id === parseInt(req.params.user_id));
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  res.json(user);
});

// ============= CATEGORY ENDPOINTS =============

// List all categories
app.get('/categories', (req, res) => {
  res.json({ categories, total: categories.length });
});

// Search categories by name
app.get('/categories/search', (req, res) => {
  const { name } = req.query;
  if (!name) {
    return res.status(400).json({ error: 'name query parameter required' });
  }

  const results = categories.filter(c => fuzzyMatch(c.name, name));

  res.json({ categories: results, total: results.length });
});

// Get category by ID
app.get('/categories/:category_id', (req, res) => {
  const category = categories.find(c => c.id === parseInt(req.params.category_id));
  if (!category) {
    return res.status(404).json({ error: 'Category not found' });
  }
  res.json(category);
});

// ============= PRODUCT ENDPOINTS =============

// Search products by name
app.get('/products/search', (req, res) => {
  const { name } = req.query;
  if (!name) {
    return res.status(400).json({ error: 'name query parameter required' });
  }

  const results = products.filter(p => fuzzyMatch(p.name, name));

  res.json({ products: results, total: results.length });
});

// Get product by ID
app.get('/products/:product_id', (req, res) => {
  const product = products.find(p => p.id === parseInt(req.params.product_id));
  if (!product) {
    return res.status(404).json({ error: 'Product not found' });
  }
  res.json(product);
});

// List products by category
app.get('/products', (req, res) => {
  const { category_id } = req.query;

  if (category_id) {
    const results = products.filter(p => p.category_id === parseInt(category_id));
    return res.json({ products: results, total: results.length });
  }

  res.json({ products, total: products.length });
});

// ============= ORDER ENDPOINTS =============

// List orders by user
app.get('/orders', (req, res) => {
  const { user_id } = req.query;

  if (!user_id) {
    return res.status(400).json({ error: 'user_id query parameter required' });
  }

  const results = orders.filter(o => o.user_id === parseInt(user_id));
  res.json({ orders: results, total: results.length });
});

// Get order by ID
app.get('/orders/:order_id', (req, res) => {
  const order = orders.find(o => o.id === parseInt(req.params.order_id));
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }
  res.json(order);
});

// ============= REVIEW ENDPOINTS =============

// List reviews by product
app.get('/reviews', (req, res) => {
  const { product_id } = req.query;

  if (!product_id) {
    return res.status(400).json({ error: 'product_id query parameter required' });
  }

  const results = reviews.filter(r => r.product_id === parseInt(product_id));
  res.json({ reviews: results, total: results.length });
});

// Get review by ID
app.get('/reviews/:review_id', (req, res) => {
  const review = reviews.find(r => r.id === parseInt(req.params.review_id));
  if (!review) {
    return res.status(404).json({ error: 'Review not found' });
  }
  res.json(review);
});

// ============= START SERVER =============

app.listen(PORT, () => {
  console.log(`\n╔════════════════════════════════════════════════════════════╗`);
  console.log(`║         Nile Ecommerce API - Mock Server                  ║`);
  console.log(`╚════════════════════════════════════════════════════════════╝\n`);
  console.log(`✓ Server running on http://localhost:${PORT}`);
  console.log(`\nOAuth 2.0 endpoints:`);
  console.log(`  • GET  /oauth/authorize  (approval page)`);
  console.log(`  • POST /oauth/authorize  (issue code)`);
  console.log(`  • POST /oauth/token      (exchange code / refresh)`);
  console.log(`\nPre-registered client:`);
  console.log(`  client_id:     postcall-agent`);
  console.log(`  client_secret: postcall-secret`);
  console.log(`\nAvailable Endpoints:`);
  console.log(`  • GET /users/search?name=Alice`);
  console.log(`  • GET /users/:user_id`);
  console.log(`  • GET /categories/search?name=Electronics`);
  console.log(`  • GET /categories/:category_id`);
  console.log(`  • GET /products/search?name=iPhone`);
  console.log(`  • GET /products/:product_id`);
  console.log(`  • GET /products?category_id=1`);
  console.log(`  • GET /orders?user_id=1`);
  console.log(`  • GET /orders/:order_id`);
  console.log(`  • GET /reviews?product_id=101`);
  console.log(`  • GET /reviews/:review_id\n`);
});
