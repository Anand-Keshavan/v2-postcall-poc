/**
 * PostCall POC — Phase 3 demo: auth discovery and 401 → credentials → retry.
 * 1. Start mock with REQUIRE_AUTH=1 and proxy.
 * 2. Call POST /execute without credentials → expect 401 with auth_discovery.
 * 3. Call GET /auth-info → show discovery URLs.
 * 4. Call POST /execute with credentials → expect 200.
 */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const MOCK_PORT = 3001;
const PROXY_PORT = 3000;

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, data: data ? JSON.parse(data) : null }));
    }).on('error', reject);
  });
}

async function post(url, body, headers = {}) {
  const u = new URL(url);
  const raw = JSON.stringify(body);
  const defaultHeaders = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) };
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: { ...defaultHeaders, ...headers },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode, data: data ? JSON.parse(data) : null }));
      }
    );
    req.on('error', reject);
    req.write(raw);
    req.end();
  });
}

async function main() {
  const mock = spawn('node', ['proxy/mock-backend.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, REQUIRE_AUTH: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  mock.stdout.on('data', (d) => process.stdout.write('[mock] ' + d));
  mock.stderr.on('data', (d) => process.stderr.write('[mock] ' + d));

  await wait(300);

  const proxy = spawn('node', ['proxy/universal-proxy.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, BACKEND_BASE: `http://localhost:${MOCK_PORT}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proxy.stdout.on('data', (d) => process.stdout.write('[proxy] ' + d));
  proxy.stderr.on('data', (d) => process.stderr.write('[proxy] ' + d));

  await wait(500);

  const executePayload = {
    operationId: 'update_project_settings',
    intent: { org_name: 'Acme Corp', project_name: 'Marketing' },
    body: { notifications_enabled: true },
  };

  console.log('\n--- 1. POST /execute without credentials (expect 401) ---');
  const r1 = await post(`http://localhost:${PROXY_PORT}/execute`, executePayload);
  if (r1.status !== 401 || !r1.data.auth_required) {
    console.error('Expected 401 with auth_required:', r1);
    mock.kill();
    proxy.kill();
    process.exit(1);
  }
  console.log(JSON.stringify(r1.data, null, 2));

  console.log('\n--- 2. GET /auth-info (discovery from spec) ---');
  const r2 = await get(`http://localhost:${PROXY_PORT}/auth-info`);
  console.log(JSON.stringify(r2.data, null, 2));

  console.log('\n--- 3. POST /execute with credentials (expect 200) ---');
  const r3 = await post(`http://localhost:${PROXY_PORT}/execute`, {
    ...executePayload,
    credentials: { type: 'bearer', token: 'demo-token' },
  });
  if (r3.status !== 200 || !r3.data.primary) {
    console.error('Expected 200 with primary result:', r3);
    mock.kill();
    proxy.kill();
    process.exit(1);
  }
  console.log(JSON.stringify(r3.data, null, 2));

  mock.kill();
  proxy.kill();
  console.log('\nPhase 3 demo OK: 401 → auth_discovery → retry with credentials → success.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
