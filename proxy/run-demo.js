/**
 * PostCall POC — Start mock backend + proxy, then run a demo /execute call.
 * Usage: node proxy/run-demo.js
 */

const { spawn } = require('child_process');
const http = require('http');

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
      res.on('end', () => resolve({ status: res.statusCode, data }));
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
    cwd: require('path').join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  mock.stdout.on('data', (d) => process.stdout.write('[mock] ' + d));
  mock.stderr.on('data', (d) => process.stderr.write('[mock] ' + d));

  await wait(300);

  const proxy = spawn('node', ['proxy/universal-proxy.js'], {
    cwd: require('path').join(__dirname, '..'),
    env: { ...process.env, BACKEND_BASE: `http://localhost:${MOCK_PORT}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proxy.stdout.on('data', (d) => process.stdout.write('[proxy] ' + d));
  proxy.stderr.on('data', (d) => process.stderr.write('[proxy] ' + d));

  await wait(500);

  try {
    const r = await get(`http://localhost:${MOCK_PORT}/organizations/search?name=Acme%20Corp`);
    if (r.status !== 200) throw new Error('Mock not ready');
  } catch (e) {
    console.error('Mock backend did not start:', e.message);
    mock.kill();
    process.exit(1);
  }

  try {
    const result = await post(`http://localhost:${PROXY_PORT}/execute`, {
      operationId: 'update_project_settings',
      intent: { org_name: 'Acme Corp', project_name: 'Marketing' },
      body: { notifications_enabled: true, timezone: 'America/New_York' },
    });
    console.log('\n--- POST /execute result ---');
    console.log(JSON.stringify(result.data, null, 2));
    if (result.status !== 200) process.exit(1);
  } catch (e) {
    console.error('Proxy execute failed:', e.message);
    mock.kill();
    proxy.kill();
    process.exit(1);
  }

  mock.kill();
  proxy.kill();
  console.log('\nDemo OK: grounding chain ran, primary PATCH succeeded.');
}

main();
