/**
 * Console-based Authentication
 * Prompts for API tokens in the terminal with masked input.
 *
 * The main entry point is requestAuthForSpec(), which reads what credentials
 * are required from the spec's x-postcall-auth-discovery block and prompts
 * the user accordingly — no API-specific logic needed here.
 */

const readline = require('readline');
const http     = require('http');
const crypto   = require('crypto');
const { exec } = require('child_process');
const axios    = require('axios');

/**
 * Prompt with masked input (for passwords / tokens)
 */
function askMasked(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let input = '';

    const onData = (char) => {
      char = char.toString();
      if (char === '\n' || char === '\r' || char === '\u0004') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(input);
      } else if (char === '\u0003') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        process.exit(0);
      } else if (char === '\u007f' || char === '\b') {
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else {
        input += char;
        process.stdout.write('*');
      }
    };

    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

/**
 * Prompt with visible input (for non-sensitive fields like email, domain)
 */
function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Open a URL in the system browser (best-effort).
 */
function openBrowser(url) {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? `open "${url}"`
            : platform === 'win32'  ? `start "" "${url}"`
            : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) console.log(`      (Could not auto-open browser: ${err.message})`);
  });
}

/**
 * Start a one-shot HTTP server on the given port and wait for the OAuth callback.
 * Resolves with the authorization code once the redirect arrives.
 * @param {number} port
 * @param {string} expectedState
 * @returns {Promise<string>} authorization code
 */
function waitForOAuthCallback(port, expectedState) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url, `http://localhost:${port}`);
      if (reqUrl.pathname !== '/callback') {
        res.writeHead(404);
        res.end();
        return;
      }

      const code  = reqUrl.searchParams.get('code');
      const state = reqUrl.searchParams.get('state');
      const error = reqUrl.searchParams.get('error');

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:480px;margin:80px auto;padding:24px">
        <h2>${error ? '❌ Authorization denied' : '✅ Authorization complete'}</h2>
        <p>${error ? error : 'You can close this tab and return to the terminal.'}</p>
      </body></html>`);

      server.close();

      if (error) return reject(new Error(`OAuth authorization denied: ${error}`));
      if (state !== expectedState) return reject(new Error('OAuth state mismatch — possible CSRF'));
      if (!code) return reject(new Error('No authorization code received'));

      resolve(code);
    });

    server.on('error', reject);
    server.listen(port, () => {
      console.log(`      Callback server listening on http://localhost:${port}/callback`);
    });
  });
}

/**
 * Prompt the user for credentials based on the spec's x-postcall-auth-discovery.
 *
 * Supports all auth types defined in OAS++ / Schema++:
 *   type: none        — no-op (should not be called)
 *   type: api_key     — single masked field for the key
 *   type: token
 *     scheme: bearer  — single masked field for the bearer token
 *     scheme: basic   — one field per entry in required_params
 *                       (masked if name contains token/password/secret/key)
 *                       plus a domain prompt when cloud_id_discovery is present
 *
 * @param {string} api             - API name (e.g. 'github', 'confluence')
 * @param {Object} authDiscovery   - x-postcall-auth-discovery object from spec
 * @param {string} provisioningUrl - Where to get credentials (shown to user)
 * @returns {Promise<Object>}      Collected credential fields (ready to storeToken)
 */
async function requestAuthForSpec(api, authDiscovery, provisioningUrl) {
  const { type, scheme, token_type, required_params, header_name } = authDiscovery;

  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log(`║  ${api.charAt(0).toUpperCase() + api.slice(1)} Authentication Required`.padEnd(61) + '║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  if (authDiscovery['x-postcall-auth-notes']) {
    console.log('⚠️  NOTE:');
    authDiscovery['x-postcall-auth-notes'].trim().split('\n').forEach(line => {
      console.log(`   ${line.trim()}`);
    });
    console.log('');
  }

  if (provisioningUrl) {
    console.log(`Get your credentials at:\n  ${provisioningUrl}\n`);
  }

  const result = {};

  if (type === 'oauth2') {
    const {
      authorization_url,
      token_url,
      callback_port = 9999,
      client_id,
      client_secret,
      scopes = {},
    } = authDiscovery;

    const scope        = Object.keys(scopes).join(' ');
    const state        = crypto.randomBytes(16).toString('hex');
    const redirectUri  = `http://localhost:${callback_port}/callback`;

    // Build the full authorization URL
    const authUrl = new URL(authorization_url);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id',     client_id);
    authUrl.searchParams.set('redirect_uri',  redirectUri);
    authUrl.searchParams.set('state',         state);
    if (scope) authUrl.searchParams.set('scope', scope);

    console.log(`\n   Opening authorization page in your browser...`);
    console.log(`   If it doesn't open automatically, visit:\n`);
    console.log(`   ${authUrl.toString()}\n`);

    // Start callback server before opening browser
    const callbackPromise = waitForOAuthCallback(callback_port, state);
    openBrowser(authUrl.toString());

    console.log(`   Waiting for you to approve access in the browser...`);
    const code = await callbackPromise;
    console.log(`      ✓ Authorization code received`);

    // Exchange code for tokens
    const tokenResponse = await axios.post(
      token_url,
      new URLSearchParams({
        grant_type:   'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id,
        client_secret,
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, refresh_token, expires_in, token_type } = tokenResponse.data;
    const expires_at = new Date(Date.now() + expires_in * 1000).toISOString();

    console.log(`      ✓ Access token obtained (expires in ${expires_in}s)`);

    result.access_token  = access_token;
    result.refresh_token = refresh_token;
    result.expires_at    = expires_at;
    result.token_type    = token_type || 'Bearer';
    result.scope         = scope;

  } else if (type === 'api_key') {
    const label = header_name || 'API key';
    result.api_key = await askMasked(`Enter ${api} ${label} (input hidden): `);

  } else if (type === 'token' && scheme === 'bearer') {
    const label = token_type ? token_type.replace(/_/g, ' ') : 'token';
    result.token = await askMasked(`Enter ${api} ${label} (input hidden): `);

  } else if (type === 'token' && scheme === 'basic') {
    // Collect each field listed in required_params
    for (const [paramName, description] of Object.entries(required_params || {})) {
      const isSecret = /token|password|secret|key/i.test(paramName);
      if (isSecret) {
        result[paramName] = await askMasked(`${description} (input hidden): `);
      } else {
        result[paramName] = await ask(`${description}: `);
      }
    }
    // Domain is needed when the base URL must be resolved dynamically
    if (authDiscovery.cloud_id_discovery) {
      result.domain = await ask(`Your ${api} domain (e.g. "mycompany" from mycompany.atlassian.net): `);
    }
  }

  return result;
}

module.exports = {
  requestAuthForSpec,
  ask,
  askMasked,
};
