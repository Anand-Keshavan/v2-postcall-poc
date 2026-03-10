/**
 * PostCall POC — Mock API backend for Phase 2 + Phase 3.
 * Implements resolver and primary endpoints from sample-oas-plus.yaml.
 * Phase 3: Set REQUIRE_AUTH=1 to make PATCH /settings return 401 with auth_required_challenge until credentials are sent.
 * Run: node proxy/mock-backend.js  (listens on port 3001)
 */

const http = require('http');

const PORT = 3001;
const REQUIRE_AUTH = process.env.REQUIRE_AUTH === '1' || process.env.REQUIRE_AUTH === 'true';
const VALID_BEARER = 'demo-token';
const VALID_API_KEY = 'demo-key';

function isAuthenticated(req) {
  const auth = req.headers.authorization;
  if (auth && auth.toLowerCase().startsWith('bearer ') && auth.slice(7).trim() === VALID_BEARER) return true;
  if (req.headers['x-api-key'] === VALID_API_KEY) return true;
  return false;
}

function sendAuthChallenge(res) {
  res.writeHead(401, { 'WWW-Authenticate': 'Bearer' });
  res.end(
    JSON.stringify({
      code: 'auth_required_challenge',
      message: 'Credentials required. Use Authorization: Bearer demo-token or X-API-Key: demo-key',
      provisioning_url: 'https://developer.example.com/api-keys',
    })
  );
}

// In-memory data for demo
const orgs = [
  { id: 'org_8821', name: 'Acme Corp' },
  { id: 'org_9999', name: 'Globex Inc' },
];
const projects = [
  { id: 'proj_abc_123', orgId: 'org_8821', name: 'Marketing', status: 'active' },
  { id: 'proj_xyz_456', orgId: 'org_8821', name: 'Engineering', status: 'active' },
  { id: 'proj_def_789', orgId: 'org_9999', name: 'Marketing', status: 'active' },
];
const settingsStore = {}; // key: `${orgId}:${projectId}`

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;
  const method = req.method;

  res.setHeader('Content-Type', 'application/json');

  // GET /organizations/search?name=...
  if (method === 'GET' && pathname === '/organizations/search') {
    const name = url.searchParams.get('name');
    const org = orgs.find((o) => o.name.toLowerCase() === (name || '').toLowerCase());
    if (!org) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Organization not found', query: name }));
      return;
    }
    res.writeHead(200);
    res.end(JSON.stringify({ id: org.id, name: org.name }));
    return;
  }

  // GET /organizations/:orgId/projects/lookup?projectName=...
  const lookupMatch = pathname.match(/^\/organizations\/([^/]+)\/projects\/lookup$/);
  if (method === 'GET' && lookupMatch) {
    const orgId = lookupMatch[1];
    const projectName = url.searchParams.get('projectName');
    const project = projects.find(
      (p) => p.orgId === orgId && p.name.toLowerCase() === (projectName || '').toLowerCase()
    );
    if (!project) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Project not found', orgId, projectName }));
      return;
    }
    res.writeHead(200);
    res.end(JSON.stringify({ id: project.id, status: project.status }));
    return;
  }

  // PATCH /organizations/:orgId/projects/:projectId/settings (Phase 3: optional auth)
  const settingsMatch = pathname.match(/^\/organizations\/([^/]+)\/projects\/([^/]+)\/settings$/);
  if (method === 'PATCH' && settingsMatch) {
    if (REQUIRE_AUTH && !isAuthenticated(req)) {
      sendAuthChallenge(res);
      return;
    }
    const [, orgId, projectId] = settingsMatch;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const payload = body ? JSON.parse(body) : {};
      const key = `${orgId}:${projectId}`;
      settingsStore[key] = { ...settingsStore[key], ...payload, _updated: new Date().toISOString() };
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, settings: settingsStore[key] }));
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found', path: pathname, method }));
});

server.listen(PORT, () => {
  console.log(`Mock backend listening on http://localhost:${PORT}`);
  if (REQUIRE_AUTH) console.log('Phase 3: PATCH /settings requires Authorization (Bearer demo-token or X-API-Key: demo-key)');
});
