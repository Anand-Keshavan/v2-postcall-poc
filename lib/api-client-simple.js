/**
 * Generic API Client
 *
 * One client factory for all APIs, driven entirely by spec definitions.
 * Use createClientFromSpec() — it handles all auth types and server URLs
 * as declared in the OAS++ / Schema++ spec's x-postcall-auth-discovery.
 */

const axios = require('axios');
const { getToken, storeToken } = require('./token-storage');

/**
 * Add request/response interceptors for logging and error handling
 * @param {Object} client - Axios instance
 * @param {string} api - 'github', 'confluence', or 'nile'
 */
function addInterceptors(client, api) {
  // Request interceptor for logging
  client.interceptors.request.use(
    (config) => {
      if (process.env.DEBUG === 'true') {
        console.log(`[${api.toUpperCase()}] ${config.method.toUpperCase()} ${config.url}`);
        if (config.params) {
          console.log(`[${api.toUpperCase()}] Params:`, config.params);
        }
      }
      return config;
    },
    (error) => {
      return Promise.reject(error);
    }
  );

  // Response interceptor for logging and error handling
  client.interceptors.response.use(
    (response) => {
      // Log rate limit info for GitHub
      if (api === 'github' && response.headers['x-ratelimit-remaining']) {
        const remaining = response.headers['x-ratelimit-remaining'];
        const limit = response.headers['x-ratelimit-limit'];
        if (process.env.DEBUG === 'true') {
          console.log(`[GITHUB] Rate limit: ${remaining}/${limit} remaining`);
        }
        if (parseInt(remaining) < 100) {
          console.warn(`[GITHUB] Warning: Only ${remaining} API calls remaining!`);
        }
      }

      if (process.env.DEBUG === 'true') {
        console.log(`[${api.toUpperCase()}] Response: ${response.status}`);
      }

      return response;
    },
    (error) => {
      if (error.response) {
        const { status, data } = error.response;

        // Handle 401 Unauthorized
        if (status === 401) {
          const message = data.message || 'Authentication failed';
          const authError = new Error(`Authentication failed for ${api}: ${message}`);
          authError.code = 'auth_required_challenge';
          authError.status = 401;
          authError.api = api;
          authError.originalError = data;

          // Log the full error response for debugging
          console.error(`\n[${api.toUpperCase()}] 401 Unauthorized`);
          console.error(`Message: ${message}`);
          if (data.documentation_url) {
            console.error(`Docs: ${data.documentation_url}`);
          }

          throw authError;
        }

        // Handle 403 Forbidden
        if (status === 403) {
          if (api === 'github' && error.response.headers['x-ratelimit-remaining'] === '0') {
            const resetTime = error.response.headers['x-ratelimit-reset'];
            const resetDate = new Date(parseInt(resetTime) * 1000);
            const rateLimitError = new Error(`GitHub rate limit exceeded. Resets at ${resetDate.toISOString()}`);
            rateLimitError.code = 'rate_limit_exceeded';
            rateLimitError.status = 403;
            rateLimitError.resetAt = resetDate;
            throw rateLimitError;
          }

          const forbiddenError = new Error(data.message || 'Forbidden - insufficient permissions');
          forbiddenError.code = 'forbidden';
          forbiddenError.status = 403;
          forbiddenError.originalError = data;
          throw forbiddenError;
        }

        // Handle 400 Bad Request (often validation errors)
        if (status === 400) {
          const badRequestError = new Error(data.message || 'Bad Request');
          badRequestError.code = 'validation_error';
          badRequestError.status = 400;
          badRequestError.errors = data.errors || [];
          badRequestError.originalError = data;
          throw badRequestError;
        }

        // Handle 404 Not Found
        if (status === 404) {
          const notFoundError = new Error(data.message || 'Resource not found');
          notFoundError.code = 'not_found';
          notFoundError.status = 404;
          notFoundError.originalError = data;
          throw notFoundError;
        }

        // Handle 422 Validation Error
        if (status === 422) {
          const validationError = new Error(data.message || 'Validation failed');
          validationError.code = 'validation_error';
          validationError.status = 422;
          validationError.errors = data.errors || [];
          validationError.originalError = data;
          throw validationError;
        }

        // Other HTTP errors
        const httpError = new Error(data.message || `HTTP ${status} error`);
        httpError.code = 'http_error';
        httpError.status = status;
        httpError.originalError = data;
        throw httpError;
      }

      // Network or timeout errors
      if (error.code === 'ECONNABORTED') {
        const timeoutError = new Error('Request timeout');
        timeoutError.code = 'timeout';
        throw timeoutError;
      }

      throw error;
    }
  );
}

/**
 * Fetch Confluence Cloud ID using the tenant_info endpoint (works with Basic Auth)
 * @returns {Promise<string>} cloud ID
 */
async function fetchConfluenceCloudId() {
  const tokenData = getToken('confluence');
  if (!tokenData || !tokenData.email || !tokenData.apiToken) {
    throw new Error('Confluence credentials not found');
  }

  if (!tokenData.domain) {
    throw new Error('Confluence domain not stored. Please delete stored credentials and re-authenticate.');
  }

  // Normalize domain: strip .atlassian.net if user included it
  const domain = tokenData.domain.replace(/\.atlassian\.net$/, '');
  const tenantUrl = `https://${domain}.atlassian.net/_edge/tenant_info`;

  console.log(`[Confluence] Fetching Cloud ID from: ${tenantUrl}`);

  try {
    // _edge/tenant_info does not require auth - it's a public metadata endpoint
    const response = await axios.get(tenantUrl, {
      headers: { Accept: 'application/json' },
      timeout: 10000,
    });

    const cloudId = response.data?.cloudId;
    if (!cloudId) {
      throw new Error('cloudId not found in tenant_info response');
    }

    console.log(`[Confluence] Found Cloud ID: ${cloudId} for ${domain}.atlassian.net`);
    return cloudId;

  } catch (error) {
    const status = error.response?.status;
    const body = JSON.stringify(error.response?.data || {});
    console.error(`[Confluence] Tenant info request failed: ${status} - ${body}`);
    throw new Error(`Failed to fetch Confluence Cloud ID: ${error.message}`);
  }
}

/**
 * Retry a request with exponential backoff
 * @param {Function} requestFn - Function that returns a promise
 * @param {number} maxRetries - Maximum number of retries
 * @param {number} baseDelay - Base delay in milliseconds
 * @returns {Promise<Object>} response
 */
async function retryWithBackoff(requestFn, maxRetries = 3, baseDelay = 1000) {
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await requestFn();
    } catch (error) {
      lastError = error;

      // Don't retry on certain errors
      if (
        error.code === 'auth_required_challenge' ||
        error.code === 'forbidden' ||
        error.code === 'not_found' ||
        error.code === 'validation_error'
      ) {
        throw error;
      }

      // Last attempt, throw error
      if (attempt === maxRetries) {
        throw error;
      }

      // Calculate backoff delay with jitter
      const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
      console.log(`[Retry] Attempt ${attempt + 1}/${maxRetries} failed. Retrying in ${Math.round(delay)}ms...`);

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

/**
 * Create an API client driven entirely by the spec's x-postcall-auth-discovery.
 *
 * Supports all auth types:
 *   type: none        — plain axios client, no auth headers
 *   type: api_key     — header set to api_key value from spec (embedded) or tokens.json
 *   type: token
 *     scheme: bearer  — Authorization: Bearer {token}
 *     scheme: basic   — Authorization: Basic base64(email:api_token)
 *                       + cloud_id_discovery triggers dynamic base URL resolution
 *
 * Works for both OAS++ (REST) and Schema++ (GraphQL) specs.
 *
 * @param {string} api        - API name key (e.g. 'github', 'confluence', 'forge')
 * @param {Object} spec       - OAS++ spec object (or null)
 * @param {Object} schemaSpec - Schema++ spec object (or null)
 * @returns {Promise<Object>} configured axios instance
 */
async function createClientFromSpec(api, spec, schemaSpec) {
  const authDiscovery = spec?.info?.['x-postcall-auth-discovery']
                     || schemaSpec?.info?.['x-postcall-auth-discovery']
                     || { type: 'none' };

  // Server base URL — REST uses servers[0].url, GraphQL uses server.url
  let baseURL = spec?.servers?.[0]?.url || schemaSpec?.server?.url || 'http://localhost';

  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };

  if (authDiscovery.type === 'none') {
    // No auth required — plain client

  } else if (authDiscovery.type === 'api_key') {
    // API key — either embedded in spec or stored in tokens.json
    const apiKey = authDiscovery.api_key || getToken(api)?.api_key;
    if (!apiKey) throw new Error(`API key not found for ${api}. Please authenticate first.`);
    headers[authDiscovery.header_name || 'X-API-Key'] = apiKey;

  } else if (authDiscovery.type === 'token' && authDiscovery.scheme === 'bearer') {
    const tokenData = getToken(api);
    if (!tokenData?.token) throw new Error(`Bearer token not found for ${api}. Please authenticate first.`);
    headers['Authorization'] = `Bearer ${tokenData.token}`;

  } else if (authDiscovery.type === 'token' && authDiscovery.scheme === 'basic') {
    const tokenData = getToken(api);
    if (!tokenData) throw new Error(`Credentials not found for ${api}. Please authenticate first.`);

    // Determine field names from required_params (snake_case) with legacy camelCase fallback
    const paramKeys = Object.keys(authDiscovery.required_params || {});
    const emailKey = paramKeys.find(k => k.toLowerCase().includes('email')) || 'email';
    const secretKey = paramKeys.find(k => /token|password|secret/.test(k.toLowerCase())) || 'api_token';

    const email = tokenData[emailKey];
    const secret = tokenData[secretKey] || tokenData.apiToken; // legacy fallback for existing stored tokens

    if (!email || !secret) {
      throw new Error(`Incomplete credentials for ${api}: missing ${!email ? emailKey : secretKey}`);
    }
    headers['Authorization'] = `Basic ${Buffer.from(`${email}:${secret}`).toString('base64')}`;

    // cloud_id_discovery: the base URL must be resolved from the domain
    if (authDiscovery.cloud_id_discovery) {
      let cloudId = tokenData.cloudId;
      if (!cloudId) {
        console.log('      Fetching Cloud ID...');
        try {
          cloudId = await fetchConfluenceCloudId();
          storeToken(api, { ...tokenData, cloudId });
          console.log(`      ✓ Cloud ID resolved`);
        } catch (err) {
          console.error(`      ✗ Could not resolve Cloud ID: ${err.message}`);
          console.log(`      Tip: Make sure your domain is correct (e.g., "mycompany" from mycompany.atlassian.net)`);
          throw err;
        }
      }
      // Atlassian REST API requires a cloud-specific base URL
      baseURL = `https://api.atlassian.com/ex/confluence/${cloudId}`;
    }

  } else if (authDiscovery.type === 'oauth2') {
    let tokenData = getToken(api);
    if (!tokenData?.access_token) {
      throw new Error(`OAuth2 access token not found for ${api}. Please authenticate first.`);
    }

    // Proactive refresh: if token is expired (or within 60s of expiry), refresh now
    const expiresAt = tokenData.expires_at ? new Date(tokenData.expires_at) : null;
    const needsRefresh = expiresAt && expiresAt.getTime() - Date.now() < 60_000;

    if (needsRefresh) {
      if (!tokenData.refresh_token) {
        throw new Error(`OAuth2 token expired for ${api} and no refresh token available. Please re-authenticate.`);
      }
      console.log(`      OAuth2 token expired for ${api}, refreshing...`);
      try {
        const refreshResp = await axios.post(
          authDiscovery.token_url,
          new URLSearchParams({
            grant_type:    'refresh_token',
            refresh_token: tokenData.refresh_token,
            client_id:     authDiscovery.client_id,
            client_secret: authDiscovery.client_secret,
          }).toString(),
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );
        const { access_token, refresh_token, expires_in, token_type: tt } = refreshResp.data;
        const expires_at = new Date(Date.now() + expires_in * 1000).toISOString();
        tokenData = { ...tokenData, access_token, refresh_token, expires_at, token_type: tt || 'Bearer' };
        storeToken(api, tokenData);
        console.log(`      ✓ OAuth2 token refreshed for ${api}`);
      } catch (err) {
        throw new Error(`OAuth2 token refresh failed for ${api}: ${err.message}. Please re-authenticate.`);
      }
    }

    headers['Authorization'] = `Bearer ${tokenData.access_token}`;

    // Build client early so we can attach the 401-refresh interceptor before standard ones
    const client = axios.create({ baseURL, headers, timeout: 30000 });

    // 401 interceptor: attempt one silent token refresh then retry
    client.interceptors.response.use(null, async (error) => {
      if (error.response?.status !== 401 || error.config._retried) return Promise.reject(error);

      try {
        const current = getToken(api);
        if (!current?.refresh_token) return Promise.reject(error);

        const resp = await axios.post(
          authDiscovery.token_url,
          new URLSearchParams({
            grant_type:    'refresh_token',
            refresh_token: current.refresh_token,
            client_id:     authDiscovery.client_id,
            client_secret: authDiscovery.client_secret,
          }).toString(),
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );

        const { access_token, refresh_token, expires_in, token_type: tt } = resp.data;
        const expires_at = new Date(Date.now() + expires_in * 1000).toISOString();
        storeToken(api, { ...current, access_token, refresh_token, expires_at, token_type: tt || 'Bearer' });
        console.log(`      ✓ OAuth2 token silently refreshed for ${api}`);

        // Retry the original request with the new access token
        error.config._retried = true;
        error.config.headers['Authorization'] = `Bearer ${access_token}`;
        return client(error.config);
      } catch (_) {
        return Promise.reject(error);
      }
    });

    addInterceptors(client, api);
    return client;
  }

  const client = axios.create({ baseURL, headers, timeout: 30000 });
  addInterceptors(client, api);
  return client;
}

module.exports = {
  createClientFromSpec,
  fetchConfluenceCloudId,
  retryWithBackoff,
};
