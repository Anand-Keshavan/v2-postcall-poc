/**
 * PostCall POC — Universal Proxy (Phase 2 + Phase 3 + Phase 4).
 * Phase 2: Grounding chain. Phase 3: Auth discovery, 401 handling, credentials.
 * Phase 4: RAG — POST /query (intent → operationId), POST /execute-by-intent (query + intent → execute).
 * Run: node proxy/universal-proxy.js  (listens on port 3000, forwards to backend on 3001)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const yaml = require('yaml');
const { buildIndex } = require(path.join(__dirname, '..', 'rag', 'build-index.js'));
const { retrieve } = require(path.join(__dirname, '..', 'rag', 'retrieve.js'));

const PROXY_PORT = 3000;
const BACKEND_BASE = process.env.BACKEND_BASE || 'http://localhost:3001';
const SPEC_PATH = path.join(__dirname, '..', 'specs', 'sample-oas-plus.yaml');
const SPECS_DIR = path.join(__dirname, '..', 'specs');

// --- Load spec and build operation index ---
function loadSpec() {
  const raw = fs.readFileSync(SPEC_PATH, 'utf8');
  return yaml.parse(raw);
}

// --- Phase 3: Auth discovery from OAS++ spec ---
function getAuthDiscovery(spec) {
  const auth = spec['x-postcall-auth-discovery'] || {};
  const provisioningUrl = spec['x-postcall-provisioning-url'] || null;
  return {
    metadata_url: auth.metadata_url || null,
    registration_url: auth.registration_url || null,
    provisioning_url: provisioningUrl,
  };
}

function buildOperationIndex(spec) {
  const index = new Map();
  const baseUrl = (spec.servers && spec.servers[0] && spec.servers[0].url) ? spec.servers[0].url : '';
  for (const [pathTemplate, pathItem] of Object.entries(spec.paths || {})) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const op = pathItem[method];
      if (!op || !op.operationId) continue;
      index.set(op.operationId, {
        pathTemplate,
        method: method.toUpperCase(),
        parameters: op.parameters || [],
        requestBody: op.requestBody,
        baseUrl: baseUrl.replace(/\/$/, ''),
      });
    }
  }
  return index;
}

// --- Resolve {{intent.x}} and {{steps[N].y}} in step parameters ---
function resolveTemplates(obj, intent, steps) {
  if (typeof obj !== 'object' || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map((v) => resolveTemplates(v, intent, steps));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v !== 'string') {
      out[k] = resolveTemplates(v, intent, steps);
      continue;
    }
    let s = v;
    s = s.replace(/\{\{intent\.([^}]+)\}\}/g, (_, key) => {
      const val = key.split('.').reduce((o, k) => (o && o[k]), intent);
      return val != null ? String(val) : '';
    });
    s = s.replace(/\{\{steps\[(\d+)\]\.([^}]+)\}\}/g, (_, i, key) => {
      const step = steps[Number(i)];
      const val = step && key.split('.').reduce((o, k) => (o && o[k]), step);
      return val != null ? String(val) : '';
    });
    out[k] = s;
  }
  return out;
}

// --- Build URL and options for an operation (Phase 3: optional auth headers) ---
function buildRequest(op, resolvedParams, body, baseOverride, authHeaders = {}) {
  const base = baseOverride || op.baseUrl || BACKEND_BASE;
  let path = op.pathTemplate;
  const queryParams = [];

  for (const p of op.parameters) {
    const name = p.name;
    const value = resolvedParams[name];
    if (value === undefined) continue;
    if (p.in === 'path') {
      path = path.replace(new RegExp(`\\{${name}\\}`, 'g'), encodeURIComponent(value));
    } else if (p.in === 'query') {
      queryParams.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
    }
  }
  const url = `${base}${path}${queryParams.length ? '?' + queryParams.join('&') : ''}`;
  const options = {
    method: op.method,
    headers: { 'Content-Type': 'application/json', ...authHeaders },
  };
  if (body && (op.method === 'POST' || op.method === 'PUT' || op.method === 'PATCH')) {
    options.body = JSON.stringify(body);
  }
  return { url, options };
}

// --- Build auth headers from request or credentials payload ---
function getAuthHeaders(req, payload) {
  const headers = {};
  if (req.headers.authorization) headers['Authorization'] = req.headers.authorization;
  if (req.headers['x-api-key']) headers['X-API-Key'] = req.headers['x-api-key'];
  const creds = payload.credentials;
  if (creds) {
    if (creds.type === 'bearer' && creds.token) headers['Authorization'] = `Bearer ${creds.token}`;
    if (creds.type === 'api_key' && creds.key) headers['X-API-Key'] = creds.key;
  }
  return headers;
}

// --- Phase 3: Build auth_required response for 401 ---
function buildAuthRequiredResponse(spec, context) {
  const authInfo = getAuthDiscovery(spec);
  return {
    auth_required: true,
    code: 'auth_required_challenge',
    message: 'Credentials required. Use OAuth (metadata_url) or obtain an API key (provisioning_url), then retry with Authorization header or credentials in body.',
    auth_discovery: authInfo,
    ...context,
  };
}

// --- Execute grounding steps and then primary operation (Phase 3: auth headers + 401 handling) ---
async function executeWithGrounding(spec, opIndex, operationId, intent, body, authHeaders = {}) {
  const primaryOp = opIndex.get(operationId);
  if (!primaryOp) throw new Error(`Unknown operationId: ${operationId}`);

  let groundingSteps = null;
  for (const p of primaryOp.parameters) {
    if (p['x-postcall-grounding'] && p['x-postcall-grounding'].steps) {
      groundingSteps = p['x-postcall-grounding'].steps;
      break;
    }
  }

  const steps = [];

  if (groundingSteps && groundingSteps.length > 0) {
    for (let i = 0; i < groundingSteps.length; i++) {
      const step = groundingSteps[i];
      const resolverOp = opIndex.get(step.operationId);
      if (!resolverOp) throw new Error(`Grounding step references unknown operationId: ${step.operationId}`);

      const stepParams = resolveTemplates(step.parameters || {}, intent, steps);
      const { url, options } = buildRequest(resolverOp, stepParams, null, BACKEND_BASE, authHeaders);

      const res = await fetch(url, options);
      if (res.status === 401) {
        let challengeBody = null;
        try { challengeBody = await res.json(); } catch { /* ignore */ }
        return {
          auth_response: buildAuthRequiredResponse(spec, {
            where: 'grounding',
            step_index: i,
            operationId: step.operationId,
            backend_body: challengeBody,
          }),
        };
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Grounding step ${i + 1} (${step.operationId}) failed: ${res.status} ${text}`);
      }
      const stepResult = await res.json();
      steps.push(stepResult);
    }
  }

  // Build primary request: path params from steps (and any from intent)
  const pathParamNames = primaryOp.parameters.filter((p) => p.in === 'path').map((p) => p.name);
  const resolvedPathParams = {};
  pathParamNames.forEach((name, idx) => {
    if (steps[idx] && typeof steps[idx].id === 'string') {
      resolvedPathParams[name] = steps[idx].id;
    }
  });
  // If we have more path params than steps, we might have mixed (e.g. orgId from steps[0], projectId from steps[1])
  if (pathParamNames.length === 2 && steps.length >= 2) {
    resolvedPathParams[pathParamNames[0]] = steps[0].id;
    resolvedPathParams[pathParamNames[1]] = steps[1].id;
  } else if (pathParamNames.length === 1 && steps.length >= 1) {
    resolvedPathParams[pathParamNames[0]] = steps[0].id;
  }

  const { url: primaryUrl, options: primaryOptions } = buildRequest(primaryOp, resolvedPathParams, body, BACKEND_BASE, authHeaders);

  const primaryRes = await fetch(primaryUrl, primaryOptions);
  const primaryText = await primaryRes.text();
  let primaryJson;
  try {
    primaryJson = primaryText ? JSON.parse(primaryText) : null;
  } catch {
    primaryJson = { _raw: primaryText };
  }

  if (primaryRes.status === 401) {
    return {
      auth_response: buildAuthRequiredResponse(spec, {
        where: 'primary',
        url: primaryUrl,
        method: primaryOp.method,
        backend_body: primaryJson,
      }),
    };
  }

  return {
    groundingSteps: steps.length,
    steps,
    primary: {
      url: primaryUrl,
      method: primaryOp.method,
      status: primaryRes.status,
      body: primaryJson,
    },
  };
}

// --- HTTP server ---
const spec = loadSpec();
const opIndex = buildOperationIndex(spec);
const ragIndex = buildIndex(SPECS_DIR);

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'POST' && req.url === '/query') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const query = payload.query || '';
        const topK = Math.min(Number(payload.topK) || 5, 10);
        const results = retrieve(ragIndex, query, topK);
        res.writeHead(200);
        res.end(JSON.stringify({ query, results }));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/execute-by-intent') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const { query, intent = {}, body: requestBody, credentials } = payload;
        if (!query) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing query' }));
          return;
        }
        const results = retrieve(ragIndex, query, 1);
        const selected = results[0];
        if (!selected || selected.score <= 0) {
          res.writeHead(404);
          res.end(
            JSON.stringify({
              error: 'No matching operation for query',
              query,
              hint: 'Add x-agent-guidance to operations in your OAS++ spec for better matching.',
            })
          );
          return;
        }
        const authHeaders = getAuthHeaders(req, payload);
        const result = await executeWithGrounding(
          spec,
          opIndex,
          selected.operationId,
          intent,
          requestBody,
          authHeaders
        );
        if (result.auth_response) {
          res.writeHead(401);
          res.end(JSON.stringify(result.auth_response));
          return;
        }
        res.writeHead(200);
        res.end(
          JSON.stringify({
            selected_operation: selected,
            ...result,
          })
        );
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message, stack: err.stack }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/execute') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const { operationId, intent = {}, body: requestBody } = payload;
        if (!operationId) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing operationId' }));
          return;
        }
        const authHeaders = getAuthHeaders(req, payload);
        const result = await executeWithGrounding(spec, opIndex, operationId, intent, requestBody, authHeaders);
        if (result.auth_response) {
          res.writeHead(401);
          res.end(JSON.stringify(result.auth_response));
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message, stack: err.stack }));
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/auth-info') {
    const authInfo = getAuthDiscovery(spec);
    res.writeHead(200);
    res.end(JSON.stringify({ auth_discovery: authInfo }));
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', spec: spec.info?.title }));
    return;
  }

  res.writeHead(404);
  res.end(
    JSON.stringify({
      error: 'Not found',
      try: ['POST /execute', 'POST /query', 'POST /execute-by-intent', 'GET /auth-info', 'GET /health'],
    })
  );
});

server.listen(PROXY_PORT, () => {
  console.log(`Universal Proxy listening on http://localhost:${PROXY_PORT}`);
  console.log(`Backend: ${BACKEND_BASE}`);
  console.log(`Phase 4: POST /query { "query": "..." } → operationId; POST /execute-by-intent { "query", "intent", "body" } → full run`);
});
