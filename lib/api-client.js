/**
 * API Client Module
 * Handles authenticated HTTP requests to GitHub and Confluence
 */

const axios = require('axios');
const { getApiBaseUrl } = require('../config');
const { getValidToken } = require('./oauth');

/**
 * Create an axios instance with proper configuration for an API
 * @param {string} api - 'github' or 'confluence'
 * @param {string} accessToken - OAuth access token
 * @param {string} cloudId - Confluence cloud ID (required for Confluence)
 * @returns {Object} configured axios instance
 */
function createClient(api, accessToken, cloudId = null) {
  const baseURL = getApiBaseUrl(api, cloudId);

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
  };

  // GitHub requires User-Agent header
  if (api === 'github') {
    headers['User-Agent'] = 'PostCall-POC/1.0';
  }

  const client = axios.create({
    baseURL,
    headers,
    timeout: 30000, // 30 seconds
  });

  // Add request interceptor for logging
  client.interceptors.request.use(
    (config) => {
      if (process.env.DEBUG === 'true') {
        console.log(`[${api.toUpperCase()}] ${config.method.toUpperCase()} ${config.url}`);
      }
      return config;
    },
    (error) => {
      return Promise.reject(error);
    }
  );

  // Add response interceptor for error handling and rate limiting
  client.interceptors.response.use(
    (response) => {
      // Log rate limit info
      if (api === 'github' && response.headers['x-ratelimit-remaining']) {
        const remaining = response.headers['x-ratelimit-remaining'];
        const limit = response.headers['x-ratelimit-limit'];
        if (process.env.DEBUG === 'true') {
          console.log(`[GITHUB] Rate limit: ${remaining}/${limit} remaining`);
        }
        if (parseInt(remaining) < 10) {
          console.warn(`[GITHUB] Warning: Only ${remaining} API calls remaining!`);
        }
      }

      return response;
    },
    async (error) => {
      if (error.response) {
        const { status, data } = error.response;

        // Handle 401 Unauthorized
        if (status === 401) {
          const authError = new Error('Authentication required or token expired');
          authError.code = 'auth_required_challenge';
          authError.status = 401;
          authError.api = api;
          authError.originalError = data;
          throw authError;
        }

        // Handle 403 Forbidden (might be rate limiting or permissions)
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

  return client;
}

/**
 * Make an authenticated API request with automatic token refresh
 * @param {string} api - 'github' or 'confluence'
 * @param {Object} tokenData - Current token data
 * @param {Object} requestConfig - Axios request configuration
 * @param {string} cloudId - Confluence cloud ID (optional)
 * @returns {Promise<Object>} response data
 */
async function makeAuthenticatedRequest(api, tokenData, requestConfig, cloudId = null) {
  // Ensure token is valid (refresh if needed)
  const validToken = await getValidToken(api, tokenData);

  // Create client with valid token
  const client = createClient(api, validToken.access_token, cloudId);

  try {
    const response = await client.request(requestConfig);
    return {
      success: true,
      data: response.data,
      status: response.status,
      headers: response.headers,
      tokenData: validToken, // Return potentially refreshed token
    };
  } catch (error) {
    return {
      success: false,
      error: {
        message: error.message,
        code: error.code,
        status: error.status,
        originalError: error.originalError,
      },
      tokenData: validToken, // Return token even on error
    };
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

module.exports = {
  createClient,
  makeAuthenticatedRequest,
  retryWithBackoff,
};
