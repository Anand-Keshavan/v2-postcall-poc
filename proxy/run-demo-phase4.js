/**
 * PostCall POC — Phase 4 demo: natural language query → RAG selects operation → proxy executes.
 * 1. Start mock and proxy.
 * 2. POST /query with natural language → get operationId.
 * 3. POST /execute-by-intent with same query + intent + body → full flow (RAG + grounding + execute).
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

async function post(url, body) {
  const u = new URL(url);
  const raw = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) },
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

  await wait(600);

  const naturalLanguageQuery = 'I want to update the settings for the Marketing project in Acme Corp';

  console.log('\n--- 1. POST /query (RAG: natural language → operation) ---');
  const r1 = await post(`http://localhost:${PROXY_PORT}/query`, { query: naturalLanguageQuery });
  if (r1.status !== 200) {
    console.error('Query failed:', r1);
    mock.kill();
    proxy.kill();
    process.exit(1);
  }
  console.log(JSON.stringify(r1.data, null, 2));
  const topOp = r1.data.results && r1.data.results[0];
  if (!topOp || topOp.operationId !== 'update_project_settings') {
    console.error('Expected top result operationId update_project_settings, got:', topOp);
    mock.kill();
    proxy.kill();
    process.exit(1);
  }

  console.log('\n--- 2. POST /execute-by-intent (query + intent + body → full execution) ---');
  const r2 = await post(`http://localhost:${PROXY_PORT}/execute-by-intent`, {
    query: naturalLanguageQuery,
    intent: { org_name: 'Acme Corp', project_name: 'Marketing' },
    body: { notifications_enabled: true, timezone: 'America/New_York' },
  });
  if (r2.status !== 200) {
    console.error('Execute-by-intent failed:', r2);
    mock.kill();
    proxy.kill();
    process.exit(1);
  }
  console.log(JSON.stringify(r2.data, null, 2));

  if (!r2.data.primary || r2.data.primary.status !== 200) {
    console.error('Expected primary 200:', r2.data);
    mock.kill();
    proxy.kill();
    process.exit(1);
  }

  mock.kill();
  proxy.kill();
  console.log('\nPhase 4 demo OK: natural language → RAG selected update_project_settings → grounding + PATCH succeeded.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
