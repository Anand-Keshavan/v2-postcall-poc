/**
 * Interactive Auth Form Server
 * Launches browser with form for user to paste API tokens
 */

const express = require('express');
const { exec } = require('child_process');

let server = null;
let authResolver = null;

/**
 * Start auth form server
 */
function startServer(port = 3001) {
  if (server) return Promise.resolve();

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Serve the auth form
  app.get('/auth/:api', (req, res) => {
    const { api } = req.params;
    const { provisioning_url } = req.query;

    res.send(generateAuthForm(api, provisioning_url));
  });

  // Handle token submission
  app.post('/submit-token', (req, res) => {
    const { api, token, email, domain } = req.body;

    if (authResolver) {
      authResolver({ api, token, email, domain });
      authResolver = null;
    }

    res.send(`
      <html>
        <head><title>Success!</title></head>
        <body style="font-family: Arial; max-width: 600px; margin: 50px auto; text-align: center;">
          <h1 style="color: green;">✓ Token Received!</h1>
          <p>You can close this window and return to the terminal.</p>
          <p>The PostCall agent will now execute your query...</p>
        </body>
      </html>
    `);
  });

  return new Promise((resolve) => {
    server = app.listen(port, () => {
      console.log(`[Auth Server] Running on http://localhost:${port}`);
      resolve();
    });
  });
}

/**
 * Stop the server
 */
function stopServer() {
  if (server) {
    server.close();
    server = null;
  }
}

/**
 * Generate HTML auth form
 */
function generateAuthForm(api, provisioningUrl) {
  if (api === 'github') {
    return `
      <html>
        <head>
          <title>PostCall - GitHub Authentication</title>
          <style>
            body { font-family: Arial, sans-serif; max-width: 700px; margin: 50px auto; padding: 20px; }
            h1 { color: #333; }
            .step { margin: 20px 0; padding: 20px; background: #f5f5f5; border-radius: 5px; }
            .step-number { display: inline-block; width: 30px; height: 30px; background: #007bff; color: white; border-radius: 50%; text-align: center; line-height: 30px; margin-right: 10px; }
            input[type="text"] { width: 100%; padding: 10px; font-size: 14px; border: 1px solid #ddd; border-radius: 4px; font-family: monospace; }
            button { padding: 12px 30px; background: #28a745; color: white; border: none; border-radius: 5px; font-size: 16px; cursor: pointer; margin-top: 20px; }
            button:hover { background: #218838; }
            a { color: #007bff; text-decoration: none; }
            a:hover { text-decoration: underline; }
          </style>
        </head>
        <body>
          <h1>🔐 GitHub Authentication Required</h1>
          <p>PostCall needs a GitHub Personal Access Token to execute your query.</p>

          <div class="step">
            <span class="step-number">1</span>
            <strong>Generate a token:</strong><br>
            <a href="${provisioningUrl}" target="_blank">Click here to create a GitHub token →</a>
            <ul>
              <li>Give it a name: <code>PostCall Agent</code></li>
              <li>Select scopes: <code>repo</code>, <code>read:user</code></li>
              <li>Click "Generate token"</li>
              <li>Copy the token (starts with <code>ghp_</code>)</li>
            </ul>
          </div>

          <div class="step">
            <span class="step-number">2</span>
            <strong>Paste your token here:</strong><br><br>
            <form id="tokenForm" method="POST" action="/submit-token">
              <input type="hidden" name="api" value="github">
              <input type="text" name="token" placeholder="ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" required autofocus>
              <button type="submit">Submit Token</button>
            </form>
          </div>

          <script>
            document.getElementById('tokenForm').onsubmit = function() {
              const token = this.token.value;
              if (!token.startsWith('ghp_')) {
                alert('GitHub tokens should start with "ghp_"');
                return false;
              }
            };
          </script>
        </body>
      </html>
    `;
  }

  if (api === 'confluence') {
    return `
      <html>
        <head>
          <title>PostCall - Confluence Authentication</title>
          <style>
            body { font-family: Arial, sans-serif; max-width: 700px; margin: 50px auto; padding: 20px; }
            h1 { color: #333; }
            .step { margin: 20px 0; padding: 20px; background: #f5f5f5; border-radius: 5px; }
            .step-number { display: inline-block; width: 30px; height: 30px; background: #007bff; color: white; border-radius: 50%; text-align: center; line-height: 30px; margin-right: 10px; }
            input[type="text"], input[type="email"] { width: 100%; padding: 10px; font-size: 14px; border: 1px solid #ddd; border-radius: 4px; margin: 5px 0; }
            label { display: block; margin-top: 10px; font-weight: bold; }
            button { padding: 12px 30px; background: #28a745; color: white; border: none; border-radius: 5px; font-size: 16px; cursor: pointer; margin-top: 20px; }
            button:hover { background: #218838; }
            a { color: #007bff; text-decoration: none; }
            a:hover { text-decoration: underline; }
          </style>
        </head>
        <body>
          <h1>🔐 Confluence Authentication Required</h1>
          <p>PostCall needs a Confluence API Token to execute your query.</p>

          <div class="step">
            <span class="step-number">1</span>
            <strong>Generate a token:</strong><br>
            <a href="${provisioningUrl}" target="_blank">Click here to create a Confluence API token →</a>
            <ul>
              <li>Give it a label: <code>PostCall Agent</code></li>
              <li>Click "Create"</li>
              <li>Copy the token</li>
            </ul>
          </div>

          <div class="step">
            <span class="step-number">2</span>
            <strong>Enter your Confluence details:</strong><br><br>
            <form method="POST" action="/submit-token">
              <input type="hidden" name="api" value="confluence">

              <label>Your Atlassian Email:</label>
              <input type="email" name="email" placeholder="you@example.com" required>

              <label>API Token:</label>
              <input type="text" name="token" placeholder="Paste your API token here" required>

              <label>Confluence Domain (optional):</label>
              <input type="text" name="domain" placeholder="yourcompany (from yourcompany.atlassian.net)">

              <button type="submit">Submit Token</button>
            </form>
          </div>
        </body>
      </html>
    `;
  }

  return '<html><body>Unknown API</body></html>';
}

/**
 * Open browser to auth form
 */
function openBrowser(url) {
  const platform = process.platform;
  let command;

  if (platform === 'darwin') {
    command = `open "${url}"`;
  } else if (platform === 'win32') {
    command = `start "${url}"`;
  } else {
    command = `xdg-open "${url}"`;
  }

  exec(command, (error) => {
    if (error) {
      console.error('[Auth] Could not open browser:', error.message);
      console.log(`[Auth] Please open this URL manually: ${url}`);
    }
  });
}

/**
 * Request auth from user via browser
 */
async function requestAuth(api, provisioningUrl) {
  await startServer();

  const authUrl = `http://localhost:3001/auth/${api}?provisioning_url=${encodeURIComponent(provisioningUrl)}`;

  console.log(`\n🌐 Opening browser for authentication...`);
  console.log(`   If browser doesn't open, visit: ${authUrl}\n`);

  openBrowser(authUrl);

  // Wait for user to submit token
  return new Promise((resolve) => {
    authResolver = resolve;
  });
}

module.exports = {
  startServer,
  stopServer,
  requestAuth,
};
