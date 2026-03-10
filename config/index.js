/**
 * Configuration module for PostCall POC
 * Loads environment variables and provides API configuration
 */

require('dotenv').config();

const config = {
  // Authentication method: 'token' or 'oauth'
  authMethod: process.env.AUTH_METHOD || 'token',

  // Proxy settings
  proxy: {
    port: process.env.PROXY_PORT || 3000,
    mockPort: process.env.MOCK_PORT || 3001,
    sessionSecret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
    debug: process.env.DEBUG === 'true',
  },

  // GitHub configuration
  github: {
    // Token-based auth
    token: process.env.GITHUB_TOKEN,
    username: process.env.GITHUB_USERNAME,

    // OAuth configuration
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    redirectUri: process.env.GITHUB_REDIRECT_URI || 'http://localhost:3000/callback/github',
    scopes: ['repo', 'read:user', 'user:email'],
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',

    // API
    apiBaseUrl: 'https://api.github.com',
  },

  // Confluence configuration
  confluence: {
    // Token-based auth (Basic Auth with API token)
    email: process.env.CONFLUENCE_EMAIL,
    apiToken: process.env.CONFLUENCE_API_TOKEN,
    domain: process.env.CONFLUENCE_DOMAIN,
    cloudId: process.env.CONFLUENCE_CLOUD_ID,

    // OAuth configuration
    clientId: process.env.CONFLUENCE_CLIENT_ID,
    clientSecret: process.env.CONFLUENCE_CLIENT_SECRET,
    redirectUri: process.env.CONFLUENCE_REDIRECT_URI || 'http://localhost:3000/callback/confluence',
    scopes: [
      'read:confluence-space.summary',
      'read:confluence-content.all',
      'write:confluence-content',
      'read:confluence-content.summary',
      'offline_access', // For refresh tokens
    ],
    authUrl: 'https://auth.atlassian.com/authorize',
    tokenUrl: 'https://auth.atlassian.com/oauth/token',
    resourcesUrl: 'https://api.atlassian.com/oauth/token/accessible-resources',

    // API
    apiBaseUrl: 'https://api.atlassian.com/ex/confluence', // Will be appended with cloudId
  },

  // OpenAI configuration (for RAG embeddings)
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: 'text-embedding-3-small',
  },
};

/**
 * Validates that required configuration is present
 * @param {string} api - 'github' or 'confluence'
 * @returns {Object} validation result
 */
function validateConfig(api) {
  const errors = [];

  if (api === 'github') {
    if (config.authMethod === 'token') {
      if (!config.github.token) errors.push('GITHUB_TOKEN is not set');
      if (!config.github.username) errors.push('GITHUB_USERNAME is not set');
    } else {
      if (!config.github.clientId) errors.push('GITHUB_CLIENT_ID is not set');
      if (!config.github.clientSecret) errors.push('GITHUB_CLIENT_SECRET is not set');
    }
  }

  if (api === 'confluence') {
    if (config.authMethod === 'token') {
      if (!config.confluence.email) errors.push('CONFLUENCE_EMAIL is not set');
      if (!config.confluence.apiToken) errors.push('CONFLUENCE_API_TOKEN is not set');
      if (!config.confluence.domain) errors.push('CONFLUENCE_DOMAIN is not set');
    } else {
      if (!config.confluence.clientId) errors.push('CONFLUENCE_CLIENT_ID is not set');
      if (!config.confluence.clientSecret) errors.push('CONFLUENCE_CLIENT_SECRET is not set');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Get API base URL for authenticated requests
 * @param {string} api - 'github' or 'confluence'
 * @param {string} cloudId - Confluence cloud ID (required for Confluence)
 * @returns {string} base URL
 */
function getApiBaseUrl(api, cloudId = null) {
  if (api === 'github') {
    return config.github.apiBaseUrl;
  }

  if (api === 'confluence') {
    if (!cloudId && !config.confluence.cloudId) {
      throw new Error('Confluence Cloud ID is required');
    }
    const id = cloudId || config.confluence.cloudId;
    return `${config.confluence.apiBaseUrl}/${id}`;
  }

  throw new Error(`Unknown API: ${api}`);
}

/**
 * Log configuration status (without exposing secrets)
 */
function logConfigStatus() {
  console.log('\n=== PostCall Configuration Status ===');
  console.log(`Proxy Port: ${config.proxy.port}`);
  console.log(`Debug Mode: ${config.proxy.debug}`);
  console.log(`Auth Method: ${config.authMethod.toUpperCase()}`);

  const githubValid = validateConfig('github');
  const authType = config.authMethod === 'token' ? 'Token' : 'OAuth';
  console.log(`\nGitHub ${authType}: ${githubValid.valid ? '✓ Configured' : '✗ Missing credentials'}`);
  if (!githubValid.valid && config.proxy.debug) {
    githubValid.errors.forEach(err => console.log(`  - ${err}`));
  }

  const confluenceValid = validateConfig('confluence');
  console.log(`Confluence ${authType}: ${confluenceValid.valid ? '✓ Configured' : '✗ Missing credentials'}`);
  if (!confluenceValid.valid && config.proxy.debug) {
    confluenceValid.errors.forEach(err => console.log(`  - ${err}`));
  }

  console.log(`\nOpenAI API: ${config.openai.apiKey ? '✓ Configured' : '○ Not configured (optional for Phase 1-3)'}`);
  console.log('=====================================\n');
}

module.exports = {
  config,
  validateConfig,
  getApiBaseUrl,
  logConfigStatus,
};
